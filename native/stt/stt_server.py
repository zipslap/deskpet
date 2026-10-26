"""DeskPet's offline speech recognition: a streaming sherpa-onnx recogniser behind the same small command line and JSON-lines
protocol as the macOS speech helper, so the app treats both alike.

  python stt_server.py --model DIR status
  python stt_server.py --model DIR listen --locale en-US --max-seconds 30 --silence-ms 1200
  python stt_server.py --model DIR transcribe file.wav          (a check: prints the text)

`listen` reads the default microphone, and prints one JSON object per line on stdout:
  {"type":"state","state":"listening"}  {"type":"level","level":0..1}  {"type":"partial","text":...}  {"type":"final","text":...}
  {"type":"error","code":...,"message":...}  {"type":"ended","reason":"silence|stopped|timeout|no-speech|cancelled|error"}
and reads "stop" (finish now and deliver what was heard) or "cancel" (discard) lines on stdin. Audio never leaves this process.
"""
import argparse, glob, json, os, queue, re, sys, threading, time, wave

import numpy as np

RATE = 16000
NO_SPEECH_SECONDS = 8.0  # how long to wait for the first word before giving up (the app then listens again or pauses)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"type": "error", "code": code, "message": message})
    emit({"type": "ended", "reason": "error"})
    sys.exit(0)


def pick(model_dir, prefix):
    """The int8 file when there is one (smaller and as accurate), else the plain one."""
    hits = sorted(glob.glob(os.path.join(model_dir, prefix + "*.onnx")))
    int8 = [h for h in hits if "int8" in os.path.basename(h)]
    return (int8 or hits or [""])[0]


def model_ok(model_dir):
    return bool(model_dir) and all(pick(model_dir, p) for p in ("encoder", "decoder", "joiner")) and os.path.exists(os.path.join(model_dir, "tokens.txt"))


def tidy(text):
    """These models write capitals or lower case without punctuation: make it read like a sentence."""
    t = re.sub(r"\s+", " ", text).strip()
    if not t:
        return t
    if t.isupper():
        t = t.lower()
    t = re.sub(r"\bi\b", "I", t)
    return t[0].upper() + t[1:]


def make_recognizer(model_dir, silence_s, max_s):
    import sherpa_onnx

    # decoder uses the plain file (int8 decoders can be slower), the big encoder/joiner use int8 when available
    dec = [h for h in sorted(glob.glob(os.path.join(model_dir, "decoder*.onnx"))) if "int8" not in os.path.basename(h)] or [pick(model_dir, "decoder")]
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=os.path.join(model_dir, "tokens.txt"),
        encoder=pick(model_dir, "encoder"),
        decoder=dec[0],
        joiner=pick(model_dir, "joiner"),
        num_threads=2,
        sample_rate=RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=max_s + 5,  # we run our own "nobody spoke" timer
        rule2_min_trailing_silence=max(0.4, silence_s),  # a pause after speech ends the sentence
        rule3_min_utterance_length=max_s + 5,
    )


def result_text(rec, stream):
    r = rec.get_result(stream)
    return tidy(r if isinstance(r, str) else getattr(r, "text", ""))


def transcribe(model_dir, path):
    if not model_ok(model_dir):
        fail("not-installed", "That speech model is not installed.")
    with wave.open(path, "rb") as w:
        ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        if width != 2:
            sys.exit("Use a 16-bit PCM WAV file.")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, ch)[:, 0].astype(np.float32) / 32768
    if rate != RATE:
        data = np.interp(np.linspace(0, len(data) - 1, int(len(data) * RATE / rate)), np.arange(len(data)), data).astype(np.float32)
    rec = make_recognizer(model_dir, 1.2, 60)
    s = rec.create_stream()
    s.accept_waveform(RATE, data)
    s.accept_waveform(RATE, np.zeros(int(RATE * 0.8), dtype=np.float32))  # a tail of silence flushes the last words
    s.input_finished()
    while rec.is_ready(s):
        rec.decode_stream(s)
    print(result_text(rec, s))


def status(model_dir):
    # a microphone permission cannot be queried from here; the OS asks the first time the microphone is opened
    emit({"type": "status", "mic": "unknown", "speech": "authorized" if model_ok(model_dir) else "notDetermined", "onDevice": True})


class FakeMic:
    """Feeds a 16-bit mono WAV (any rate) to the callback in 100 ms pieces, then silence, as a microphone would."""

    def __init__(self, path, callback):
        with wave.open(path, "rb") as w:
            rate, ch = w.getframerate(), w.getnchannels()
            data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, ch)[:, 0].astype(np.float32) / 32768
        if rate != RATE:
            data = np.interp(np.linspace(0, len(data) - 1, int(len(data) * RATE / rate)), np.arange(len(data)), data).astype(np.float32)
        self.data, self.callback, self.stop_flag = data, callback, False

    def start(self):
        def run():
            step = int(RATE * 0.1)
            i = 0
            while not self.stop_flag:
                piece = self.data[i:i + step]
                if len(piece) < step:
                    piece = np.concatenate([piece, np.zeros(step - len(piece), dtype=np.float32)])
                self.callback(piece.reshape(-1, 1), step, None, None)
                i += step
                time.sleep(0.03)  # a little faster than real time keeps tests short

        threading.Thread(target=run, daemon=True).start()

    def stop(self):
        self.stop_flag = True

    def close(self):
        pass


def listen(model_dir, locale, max_seconds, silence_ms):
    if not model_ok(model_dir):
        fail("not-installed", "No speech model is installed. Run: npm run speech -- install --recommended")
    try:
        import sounddevice as sd
    except Exception as e:  # noqa: BLE001
        fail("failed", f"Audio input is unavailable: {e}")
    rec = make_recognizer(model_dir, silence_ms / 1000.0, max_seconds)
    stream = rec.create_stream()
    chunks = queue.Queue()
    commands = queue.Queue()

    def read_commands():
        for line in sys.stdin:
            commands.put(line.strip())
        commands.put("cancel")  # the app went away: stop listening

    threading.Thread(target=read_commands, daemon=True).start()

    def on_audio(indata, frames, time_info, status_flags):  # noqa: ARG001
        chunks.put(indata[:, 0].copy())

    wav = os.environ.get("DESKPET_STT_FAKE_WAV")  # tests: play a recording into the recogniser instead of opening a microphone
    try:
        if wav:
            mic = FakeMic(wav, on_audio)
        else:
            mic = sd.InputStream(channels=1, dtype="float32", samplerate=RATE, blocksize=int(RATE * 0.1), callback=on_audio)
        mic.start()
    except Exception as e:  # noqa: BLE001
        text = str(e)
        code = "mic-denied" if re.search(r"permission|denied|access", text, re.I) else "no-input"
        fail(code, "The microphone could not be opened. " + ("Allow microphone access for DeskPet in your system settings." if code == "mic-denied" else "Is one connected?"))
    emit({"type": "state", "state": "listening"})
    started = last_level = time.time()
    last = ""
    spoke = False
    reason = "timeout"
    try:
        while True:
            now = time.time()
            try:
                cmd = commands.get_nowait()
            except queue.Empty:
                cmd = ""
            if cmd == "cancel":
                reason = "cancelled"
                break
            if cmd == "stop":
                reason = "stopped"
                break
            if now - started >= max_seconds:
                reason = "timeout"
                break
            if not spoke and now - started >= NO_SPEECH_SECONDS:
                reason = "no-speech"
                break
            try:
                data = chunks.get(timeout=0.1)
            except queue.Empty:
                continue
            if now - last_level >= 0.1:
                emit({"type": "level", "level": float(min(1.0, float(np.sqrt(np.mean(data * data))) * 12))})
                last_level = now
            stream.accept_waveform(RATE, data)
            while rec.is_ready(stream):
                rec.decode_stream(stream)
            text = result_text(rec, stream)
            if text and text != last:
                last = text
                spoke = True
                emit({"type": "partial", "text": text})
            if rec.is_endpoint(stream) and last:
                reason = "silence"
                break
    finally:
        try:
            mic.stop()
            mic.close()
        except Exception:  # noqa: BLE001
            pass
    if reason == "cancelled":
        emit({"type": "ended", "reason": "cancelled"})
        return
    # flush what is still buffered, then deliver the text
    stream.accept_waveform(RATE, np.zeros(int(RATE * 0.6), dtype=np.float32))
    stream.input_finished()
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    final = result_text(rec, stream) or last
    if final:
        emit({"type": "final", "text": final})
    emit({"type": "ended", "reason": reason if final else "no-speech"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").add_argument("--locale", default="en-US")
    p = sub.add_parser("listen")
    p.add_argument("--locale", default="en-US")
    p.add_argument("--max-seconds", type=float, default=30)
    p.add_argument("--silence-ms", type=float, default=1200)
    p.add_argument("--allow-server", action="store_true")  # accepted and ignored: nothing here ever uses a server
    sub.add_parser("transcribe").add_argument("wav")
    a = ap.parse_args()
    if a.cmd == "status":
        status(a.model)
    elif a.cmd == "listen":
        listen(a.model, a.locale, a.max_seconds, a.silence_ms)
    else:
        transcribe(a.model, a.wav)
