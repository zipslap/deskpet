"""DeskPet's local voice: a small text-to-speech server (Kokoro or Piper/VITS models via sherpa-onnx), driven by the app over stdin/stdout.

One JSON object per line on stdin:
  {"cmd": "speak", "text": "..."}   queue a sentence (synthesised while the previous one plays, so speech flows)
  {"cmd": "stop"}                   stop playing now and drop everything queued
  {"cmd": "quit"}
  ("speak" may carry an integer "id"; "idle" reports the newest id received, so the app knows nothing it sent is still pending.)
One JSON object per line on stdout: {"event": "ready", "speakers": n} | {"event": "start"} | {"event": "idle", "last": id} | {"event": "error", "message": ...}

Audio goes out through one continuous sounddevice stream (no gap or process start between sentences).
Optional pitch change: synthesise slightly slower, then play the audio faster by `pitch` (a classic animation trick: it raises the
pitch and the formants together). 1.0 leaves the voice as it was recorded. No voice is cloned from anyone.
Usage: python tts_server.py --family kokoro|vits --model DIR [--sid 0] [--pitch 1.0] [--speed 1.0]   or  --sample "text" --out file.wav
"""
import argparse, glob, json, os, queue, sys, threading, wave

import numpy as np
import sherpa_onnx


def first(model_dir, *patterns):
    """The first existing file in model_dir matching one of the glob patterns, as a path ('' if none)."""
    for pat in patterns:
        hits = sorted(glob.glob(os.path.join(model_dir, pat)))
        if hits:
            return hits[0]
    return ""


def existing(model_dir, *names):
    return [os.path.join(model_dir, n) for n in names if os.path.exists(os.path.join(model_dir, n))]


def load(family, model_dir, threads=2):
    """Build the sherpa-onnx engine for a model folder. Kokoro and Piper (VITS) folders differ in which extra files they carry."""
    model = first(model_dir, "model.onnx", "model*.onnx", "*.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")
    data_dir = os.path.join(model_dir, "espeak-ng-data")
    if not model or not os.path.exists(tokens):
        raise SystemExit(f"{model_dir} is not a voice folder (no .onnx model or tokens.txt)")
    if family == "kokoro":
        dict_dir = os.path.join(model_dir, "dict")
        kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=model,
            voices=os.path.join(model_dir, "voices.bin"),
            tokens=tokens,
            data_dir=data_dir,
            dict_dir=dict_dir if os.path.isdir(dict_dir) else "",
            lexicon=",".join(existing(model_dir, "lexicon-us-en.txt", "lexicon-zh.txt")),
        )
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=threads)
    elif family == "vits":
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=model,
            tokens=tokens,
            data_dir=data_dir if os.path.isdir(data_dir) else "",
            lexicon=first(model_dir, "lexicon.txt"),
        )
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=threads)
    else:
        raise SystemExit(f"unknown voice family {family!r}")
    fsts = ",".join(existing(model_dir, "date-zh.fst", "number-zh.fst", "phone-zh.fst")) if family == "kokoro" else ""
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model_cfg, rule_fsts=fsts, max_num_sentences=1))


def synth(tts, text, sid, pitch, speed):
    """Mono float32 samples at the model's rate, already pitched up (resampled shorter by `pitch`)."""
    audio = tts.generate(text, sid=sid, speed=speed / pitch)
    x = np.clip(np.asarray(audio.samples, dtype=np.float32), -1, 1)
    if abs(pitch - 1) > 1e-3 and len(x) > 1:
        n = int(len(x) / pitch)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x, audio.sample_rate


def write_wav(path, x, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def serve(tts, sid, pitch, speed):
    import sounddevice as sd

    sr = tts.sample_rate
    texts = queue.Queue()
    events = queue.Queue()  # from the audio callback: ("start",) / ("done",), handled off the audio thread
    lock = threading.Lock()
    state = {"gen": 0, "inflight": 0, "last": 0, "speaking": False, "clips": [], "pos": 0, "stream": None, "quiet": 0.0}

    def finished_one():
        with lock:
            state["inflight"] = max(0, state["inflight"] - 1)
            if state["inflight"] == 0:
                state["speaking"] = False
                emit({"event": "idle", "last": state["last"]})

    def callback(out, frames, _time, _status):
        filled = 0
        with lock:
            while filled < frames and state["clips"]:
                clip = state["clips"][0]
                if state["pos"] == 0:
                    events.put(("start",))
                take = min(frames - filled, len(clip) - state["pos"])
                out[filled:filled + take, 0] = clip[state["pos"]:state["pos"] + take]
                filled += take
                state["pos"] += take
                if state["pos"] >= len(clip):
                    state["clips"].pop(0)
                    state["pos"] = 0
                    events.put(("done",))
        out[filled:, 0] = 0

    def ensure_stream():
        if state["stream"] is None:
            st = sd.OutputStream(samplerate=sr, channels=1, dtype="float32", callback=callback, blocksize=1024)
            st.start()
            state["stream"] = st

    def synthesiser():
        while True:
            g, text = texts.get()
            if g != state["gen"]:
                finished_one()
                continue
            try:
                x, _ = synth(tts, text, sid, pitch, speed)
            except Exception as e:  # noqa: BLE001
                emit({"event": "error", "message": f"voice failed: {e}"})
                finished_one()
                continue
            x = np.concatenate([x, np.zeros(int(sr * 0.12), dtype=np.float32)])  # a breath between sentences
            with lock:
                if g != state["gen"]:
                    stale = True
                else:
                    stale = False
                    state["clips"].append(x)
            if stale:
                finished_one()
                continue
            try:
                ensure_stream()
            except Exception as e:  # noqa: BLE001
                emit({"event": "error", "message": f"no audio output: {e}"})
                with lock:
                    state["clips"].clear()
                finished_one()

    def monitor():
        while True:
            try:
                ev = events.get(timeout=1.0)
            except queue.Empty:
                # close the audio device after a quiet spell, so an idle cat costs nothing
                with lock:
                    idle = not state["clips"] and state["inflight"] == 0
                    st = state["stream"]
                if idle and st is not None:
                    state["quiet"] += 1
                    if state["quiet"] >= 10:
                        state["stream"] = None
                        st.stop()
                        st.close()
                        state["quiet"] = 0
                continue
            state["quiet"] = 0
            if ev[0] == "start":
                with lock:
                    if not state["speaking"]:
                        state["speaking"] = True
                        emit({"event": "start"})
            else:
                finished_one()

    for fn in (synthesiser, monitor):
        threading.Thread(target=fn, daemon=True).start()
    emit({"event": "ready", "speakers": int(getattr(tts, "num_speakers", 1)), "rate": sr})
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        cmd = msg.get("cmd")
        if cmd == "speak" and isinstance(msg.get("text"), str) and msg["text"].strip():
            with lock:
                state["inflight"] += 1
                if isinstance(msg.get("id"), int):
                    state["last"] = msg["id"]
                texts.put((state["gen"], msg["text"].strip()[:1000]))
        elif cmd == "stop":
            with lock:
                state["gen"] += 1
                dropped = len(state["clips"])
                state["clips"].clear()
                state["pos"] = 0
            for _ in range(dropped):
                finished_one()
        elif cmd == "quit":
            break


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--family", choices=["kokoro", "vits"], default="kokoro")
    ap.add_argument("--model", required=True)
    ap.add_argument("--sid", type=int, default=0)
    ap.add_argument("--pitch", type=float, default=1.0)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--sample")
    ap.add_argument("--out")
    a = ap.parse_args()
    engine = load(a.family, a.model)
    if not 0 <= a.sid < max(1, int(getattr(engine, "num_speakers", 1))):
        a.sid = 0  # a speaker number the model does not have: use its first
    if a.sample:
        x, sr = synth(engine, a.sample, a.sid, a.pitch, a.speed)
        write_wav(a.out, x, sr)
    else:
        serve(engine, a.sid, a.pitch, a.speed)
