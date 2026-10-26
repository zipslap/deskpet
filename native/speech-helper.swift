// Speech helper for the desktop pet: microphone capture + macOS speech recognition, driven over stdin/stdout.
//
//   speech-helper status [--locale en-US]
//       One JSON line with permission/availability state. Never prompts, never opens the microphone.
//   speech-helper listen [--locale en-US] [--allow-server] [--max-seconds 30] [--silence-ms 1800]
//       Opens the microphone and streams JSON lines:
//         {"type":"state","state":"requesting-permission"|"listening"}
//         {"type":"level","level":0.0-1.0}            ~10/s while listening
//         {"type":"partial","text":"..."}             best transcript so far
//         {"type":"final","text":"..."}               at most once
//         {"type":"error","code":"...","message":"..."}
//         {"type":"ended","reason":"stopped|silence|timeout|no-speech|cancelled|error"}   always last
//       Commands on stdin: "stop" (finish and deliver what was heard) or "cancel". stdin closing = cancel,
//       so the microphone can never stay open if the parent app dies. SIGTERM/SIGINT = cancel.
//
// Recognition is forced on-device unless --allow-server is given. Nothing is recorded to disk.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func arg(_ name: String, default def: String? = nil) -> String? {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return def
}
func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

func speechAuthName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}
func micAuthName(_ s: AVAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

// ---------------------------------------------------------------- status
func runStatus() {
    let locale = Locale(identifier: arg("--locale", default: "en-US")!)
    let r = SFSpeechRecognizer(locale: locale)
    emit([
        "type": "status",
        "mic": micAuthName(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speech": speechAuthName(SFSpeechRecognizer.authorizationStatus()),
        "available": r?.isAvailable ?? false,
        "onDevice": r?.supportsOnDeviceRecognition ?? false,
    ])
    exit(0)
}

// ---------------------------------------------------------------- listen
final class Listener {
    let locale: Locale
    let allowServer: Bool
    let maxSeconds: Double
    let silenceMs: Double
    let noSpeechSeconds = 8.0

    let engine = AVAudioEngine()
    var recognizer: SFSpeechRecognizer?
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var timer: Timer?

    var startedAt = Date()
    var lastText = ""
    var lastChange = Date()
    var heardSpeech = false
    var done = false
    var stopping = false
    var reason = "stopped"
    var latestLevel: Float = 0
    var lastLevelEmit = Date.distantPast

    init(locale: Locale, allowServer: Bool, maxSeconds: Double, silenceMs: Double) {
        self.locale = locale
        self.allowServer = allowServer
        self.maxSeconds = maxSeconds
        self.silenceMs = silenceMs
    }

    func fail(_ code: String, _ message: String) {
        emit(["type": "error", "code": code, "message": message])
        end(reason: "error", final: nil)
    }

    /// Single exit point: closes the microphone, reports, exits. Idempotent.
    func end(reason r: String, final text: String?) {
        if done { return }
        done = true
        timer?.invalidate()
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        if let t = text, !t.isEmpty, r != "cancelled" { emit(["type": "final", "text": t]) }
        emit(["type": "ended", "reason": r])
        exit(0)
    }

    func start() {
        // 1. permissions (these may show the system prompts, which is why `status` exists separately)
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            emit(["type": "state", "state": "requesting-permission"])
            SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async { self.start() } }
            return
        }
        guard speechStatus == .authorized else {
            return fail("speech-denied", "Speech recognition is not allowed for this app (status: \(speechAuthName(speechStatus))).")
        }
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        if micStatus == .notDetermined {
            emit(["type": "state", "state": "requesting-permission"])
            AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { self.start() } }
            return
        }
        guard micStatus == .authorized else {
            return fail("mic-denied", "Microphone access is not allowed for this app (status: \(micAuthName(micStatus))).")
        }

        // 2. recogniser
        guard let rec = SFSpeechRecognizer(locale: locale), rec.isAvailable else {
            return fail("unavailable", "Speech recognition is not available for \(locale.identifier).")
        }
        recognizer = rec
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if rec.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        } else if allowServer {
            req.requiresOnDeviceRecognition = false
        } else {
            return fail("on-device-unavailable", "On-device recognition is not available for \(locale.identifier), and server recognition is not allowed in settings.")
        }
        request = req

        // 3. microphone
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            return fail("no-input", "No audio input device is available.")
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self = self, !self.done else { return }
            self.request?.append(buffer)
            if let ch = buffer.floatChannelData?[0] {
                let n = Int(buffer.frameLength)
                var sum: Float = 0
                for i in 0..<n { sum += ch[i] * ch[i] }
                self.latestLevel = n > 0 ? min(1, (sum / Float(n)).squareRoot() * 6) : 0
            }
        }
        engine.prepare()
        do { try engine.start() } catch {
            return fail("no-input", "Could not open the microphone: \(error.localizedDescription)")
        }

        startedAt = Date()
        lastChange = Date()
        emit(["type": "state", "state": "listening"])

        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    }

    func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if done { return }
        if let r = result {
            let text = r.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                heardSpeech = true
                if text != lastText {
                    lastText = text
                    lastChange = Date()
                    emit(["type": "partial", "text": text])
                }
            }
            if r.isFinal { return end(reason: reason, final: lastText) }
        }
        if let e = error {
            // "No speech detected" and friends: not worth an error if there is nothing to report anyway.
            if lastText.isEmpty { return end(reason: stopping ? reason : "no-speech", final: nil) }
            _ = e
            return end(reason: reason, final: lastText)
        }
    }

    func tick() {
        if done { return }
        let now = Date()
        if now.timeIntervalSince(lastLevelEmit) >= 0.1 {
            lastLevelEmit = now
            emit(["type": "level", "level": Double(latestLevel)])
        }
        if stopping { return }
        if now.timeIntervalSince(startedAt) > maxSeconds { return stop(reason: "timeout") }
        if heardSpeech && now.timeIntervalSince(lastChange) * 1000 > silenceMs { return stop(reason: "silence") }
        if !heardSpeech && now.timeIntervalSince(startedAt) > noSpeechSeconds { return end(reason: "no-speech", final: nil) }
    }

    /// Stop capturing and let the recogniser deliver what it heard.
    func stop(reason r: String) {
        if done || stopping { return }
        stopping = true
        reason = r
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // If the recogniser never sends a final result, report the last partial anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            guard let self = self else { return }
            self.end(reason: self.reason, final: self.lastText)
        }
    }

    func cancel() { end(reason: "cancelled", final: nil) }
}

func runListen() {
    let listener = Listener(
        locale: Locale(identifier: arg("--locale", default: "en-US")!),
        allowServer: flag("--allow-server"),
        maxSeconds: Double(arg("--max-seconds", default: "30") ?? "30") ?? 30,
        silenceMs: Double(arg("--silence-ms", default: "1800") ?? "1800") ?? 1800
    )

    // stdin commands; EOF (parent gone) cancels
    let stdinHandle = FileHandle.standardInput
    stdinHandle.readabilityHandler = { h in
        let data = h.availableData
        if data.isEmpty {
            h.readabilityHandler = nil
            DispatchQueue.main.async { listener.cancel() }
            return
        }
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            switch line.trimmingCharacters(in: .whitespaces) {
            case "stop": DispatchQueue.main.async { listener.stop(reason: "stopped") }
            case "cancel": DispatchQueue.main.async { listener.cancel() }
            default: break
            }
        }
    }
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler { listener.cancel() }
        src.resume()
        signalSources.append(src)
    }
    DispatchQueue.main.async { listener.start() }
    RunLoop.main.run()
}
var signalSources: [DispatchSourceSignal] = []

switch CommandLine.arguments.dropFirst().first {
case "status": runStatus()
case "listen": runListen()
default:
    FileHandle.standardError.write(Data("usage: speech-helper status|listen [options]\n".utf8))
    exit(2)
}
