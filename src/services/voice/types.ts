/**
 * Voice boundaries. Speech-to-text and text-to-speech are separate, replaceable adapters: the pet, the chat panel
 * and the VoiceController only know these interfaces, so macOS-native pieces can be swapped (or faked in tests).
 */

// ---------- speech-to-text ----------
export type SttErrorCode =
  | 'not-installed' // the speech helper binary is missing
  | 'mic-denied' // microphone permission refused (or restricted)
  | 'speech-denied' // speech-recognition permission refused (or restricted)
  | 'unavailable' // no recogniser for this language / service unavailable
  | 'on-device-unavailable' // on-device recognition needed but not available, and server recognition is not allowed
  | 'no-input' // no microphone / audio input
  | 'failed' // anything else

export interface SttError {
  code: SttErrorCode
  message: string
}

export type SttEndReason = 'stopped' | 'silence' | 'timeout' | 'no-speech' | 'cancelled' | 'error'

export interface SttStartOptions {
  locale: string
  allowServerRecognition: boolean
  maxSeconds: number
  silenceMs: number
}

export interface SttHandlers {
  /** The microphone is open and listening (not just "starting"). */
  onListening(): void
  /** Input level 0..1, ~10 per second, so the UI can show that the mic is live. */
  onLevel(level: number): void
  /** Best transcript so far (replaces the previous one). */
  onPartial(text: string): void
  /** The final transcript. Called at most once. */
  onFinal(text: string): void
  onError(error: SttError): void
  /** Always called exactly once, last. After it the microphone is closed. */
  onEnded(reason: SttEndReason): void
}

export interface SttSession {
  /** Stop listening and deliver the final transcript of what was heard so far. */
  stop(): void
  /** Stop listening and discard the result. */
  cancel(): void
}

export interface SttStatus {
  /** The speech helper exists and can run. */
  installed: boolean
  mic: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
  speech: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
  onDevice: boolean
  detail?: string
}

export interface SpeechToText {
  status(locale: string): Promise<SttStatus>
  start(options: SttStartOptions, handlers: SttHandlers): SttSession
}

// ---------- text-to-speech ----------
export interface TextToSpeech {
  /** Queue `text` to be read aloud. Utterances play in order. */
  speak(text: string): void
  /** Stop speaking immediately and drop everything queued. Safe to call at any time, any number of times. */
  stop(): void
  readonly speaking: boolean
  /** Speaking or about to (queued text not yet played). Adapters without a queue of their own may leave it out (= speaking). */
  readonly busy?: boolean
  /** Fires true when speech starts playing and false when the queue has fully drained or was stopped. */
  onSpeakingChange(cb: (speaking: boolean) => void): void
}
