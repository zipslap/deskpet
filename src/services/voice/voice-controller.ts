import type { VoiceSettings } from '../memory/settings'
import { IDLE_VOICE_STATE, type FixHint, type VoiceUiState } from '../../shared/voice-types'
import { SentenceSplitter } from './sentence-splitter'
import type { SpeechToText, SttError, SttSession, TextToSpeech } from './types'

export interface VoiceDeps {
  stt: SpeechToText
  tts: TextToSpeech
  settings: VoiceSettings
  /** Every UI-relevant change (phase, level, transcript, errors, mute, speaking). */
  onState(state: VoiceUiState): void
  /** The microphone really is open (true) / closed again (false): drives the pet's "listening" state. */
  onListeningChange(listening: boolean): void
  /** Speech started/stopped playing: drives the pet's "speaking" state. */
  onSpeakingChange(speaking: boolean): void
  /** Called just before the microphone opens: the caller stops anything the user is about to talk over. */
  beforeListen(): void
  /** Dictation finished and `autoSend` is on (or a live conversation is on): send it now. */
  onAutoSend(text: string): void
}

/** Live conversation: this many listens in a row that hear nothing, and the mic closes (about a minute and a half of quiet). */
export const LIVE_MAX_QUIET = 3
/** Live conversation: a sent message that gets no reply at all within this long stops waiting and listens again. */
export const LIVE_REPLY_TIMEOUT_MS = 180_000

/** Markdown marks that would be read out loud as punctuation noise. */
export function toSpeech(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Turn a recogniser error into something a person can act on. */
export function describeSttError(e: SttError): { message: string; fix: FixHint } {
  switch (e.code) {
    case 'mic-denied':
      return { message: 'Microphone access is off. Allow it in the system privacy settings (Microphone), then try again.', fix: 'microphone' }
    case 'speech-denied':
      return { message: 'Speech recognition is off. Allow it in the system privacy settings (Speech Recognition), then try again.', fix: 'speech' }
    case 'not-installed':
      return { message: e.message, fix: null }
    case 'no-input':
      return { message: 'No microphone was found. Check your input device in the system sound settings.', fix: null }
    default:
      return { message: e.message || 'Voice input failed.', fix: null }
  }
}

/**
 * Coordinates the microphone (push-to-talk), dictation review, and reading replies aloud.
 * It owns no OS resources itself: the STT session and the TTS adapter do. Everything it is told by those
 * adapters is checked against a session id, so a late callback from a finished listen can never touch a new one.
 */
export class VoiceController {
  private state: VoiceUiState
  private session: SttSession | null = null
  private sessionId = 0
  private petListening = false
  private finalText = ''
  private sawError = false
  private readonly splitter = new SentenceSplitter()
  private spokenChars = 0 // how much of the current reply has been queued to speak
  private inCode = false // inside a fenced code block: never read code aloud
  // live conversation
  private awaitingReply = false // sent what was heard; the mic reopens once the reply has been said
  private resumeAfterSpeech = false // the reply is done but still being read aloud
  private quietRuns = 0
  private resumeTimer: NodeJS.Timeout | null = null

  constructor(private readonly d: VoiceDeps) {
    this.state = { ...IDLE_VOICE_STATE, muted: !d.settings.speakReplies }
    d.tts.onSpeakingChange((speaking) => {
      this.patch({ speaking })
      d.onSpeakingChange(speaking)
      if (!speaking && this.resumeAfterSpeech && !this.ttsBusy()) {
        this.resumeAfterSpeech = false
        this.resumeSoon(350)
      }
    })
    void d.stt.status(d.settings.locale).then((s) => this.patch({ canListen: s.installed }))
  }

  snapshot(): VoiceUiState {
    return { ...this.state }
  }
  get phase(): VoiceUiState['phase'] {
    return this.state.phase
  }
  get muted(): boolean {
    return this.state.muted
  }
  get speaking(): boolean {
    return this.state.speaking
  }

  get live(): boolean {
    return this.state.live
  }

  // ---------- microphone ----------
  /**
   * The mic button / shortcut. With live conversation on (the default): the first press starts talking together; pressing while
   * he is thinking or talking interrupts him and listens; pressing while listening ends the conversation. Otherwise push-to-talk.
   */
  toggleListen(): void {
    if (this.d.settings.live) {
      if (!this.state.live) return this.startLive()
      if (this.state.phase === 'idle') return this.bargeIn()
      return this.endLive()
    }
    switch (this.state.phase) {
      case 'idle':
        return this.startListening()
      case 'starting':
        return this.cancelListening() // still waiting for the helper or a permission prompt
      case 'listening':
        return this.stopListening()
      default:
        return
    }
  }

  startListening(): void {
    if (this.state.phase !== 'idle') return
    this.d.beforeListen()
    const id = ++this.sessionId
    this.finalText = ''
    this.sawError = false
    this.patch({ phase: 'starting', level: 0, text: '', final: false, error: null, notice: null })
    const live = (): boolean => id === this.sessionId
    const s = this.d.settings
    try {
      this.session = this.d.stt.start(
        { locale: s.locale, allowServerRecognition: s.allowServerRecognition, maxSeconds: s.maxListenSeconds, silenceMs: s.silenceMs },
        {
          onListening: () => {
            if (!live()) return
            this.patch({ phase: 'listening' })
            this.setPetListening(true)
          },
          onLevel: (level) => live() && this.state.phase !== 'idle' && this.patch({ level }),
          onPartial: (text) => live() && this.patch({ text, final: false }),
          onFinal: (text) => {
            if (!live()) return
            this.finalText = text
            this.patch({ text, final: true })
          },
          onError: (e) => {
            if (!live()) return
            this.sawError = true
            this.patch({ error: describeSttError(e) })
          },
          onEnded: (reason) => {
            if (!live()) return
            this.session = null
            this.setPetListening(false)
            const text = this.finalText || (this.state.final ? this.state.text : '')
            if (reason === 'cancelled') {
              this.patch({ phase: 'idle', level: 0, text: '', final: false })
              return
            }
            if (this.state.live) {
              this.patch({ phase: 'idle', level: 0, text: '', final: false })
              if (this.sawError) return this.endLive()
              if (text) {
                // you paused: that was your turn. Send it; the mic reopens once he has answered.
                this.quietRuns = 0
                this.awaitingReply = true
                this.resumeSoon(LIVE_REPLY_TIMEOUT_MS) // a safety net, replaced as soon as the reply ends
                this.d.onAutoSend(text)
                return
              }
              if (++this.quietRuns >= LIVE_MAX_QUIET) return this.endLive('Live talk paused: it went quiet. Click 🎤 to talk again.')
              return this.resumeSoon(150)
            }
            if (text && !this.sawError && this.d.settings.autoSend) {
              this.patch({ phase: 'idle', level: 0, text: '', final: false })
              this.d.onAutoSend(text)
              return
            }
            const heardNothing = !text && !this.sawError
            this.patch({
              phase: 'idle',
              level: 0,
              text,
              final: text.length > 0,
              notice: heardNothing ? "I didn't catch anything. Try again, a bit closer to the microphone." : null
            })
          }
        }
      )
    } catch (e) {
      this.sessionId++
      this.session = null
      this.patch({ phase: 'idle', error: { message: `Could not start listening: ${(e as Error).message}`, fix: null } })
    }
  }

  /** Start a live conversation: listen now, and keep listening after every reply until it is ended or goes quiet. */
  startLive(): void {
    if (this.state.live) return
    this.quietRuns = 0
    this.awaitingReply = false
    this.resumeAfterSpeech = false
    this.patch({ live: true, notice: null })
    this.startListening()
  }

  /** End the live conversation (anything being said or thought keeps going; only the mic stops reopening). */
  endLive(notice: string | null = null): void {
    if (!this.state.live) return
    this.clearResume()
    this.awaitingReply = false
    this.resumeAfterSpeech = false
    this.cancelListening()
    this.patch({ live: false, notice })
  }

  /** Talking over him: stop his voice and the pending reply, and listen. */
  private bargeIn(): void {
    this.clearResume()
    this.awaitingReply = false
    this.resumeAfterSpeech = false
    this.quietRuns = 0
    this.startListening() // beforeListen() stops the voice and cancels the request
  }

  private ttsBusy(): boolean {
    return this.d.tts.busy ?? this.d.tts.speaking
  }
  private clearResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
  }
  /** Reopen the mic shortly (live conversation only, and only if nothing else has happened meanwhile). */
  private resumeSoon(ms: number): void {
    this.clearResume()
    if (!this.state.live) return
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (this.state.live && this.state.phase === 'idle' && !this.ttsBusy()) {
        this.awaitingReply = false
        this.startListening()
      }
    }, ms)
  }

  /** Stop listening and keep what was heard. */
  stopListening(): void {
    if (this.state.phase !== 'listening') return
    this.patch({ phase: 'stopping' })
    this.session?.stop()
  }

  /** Close the microphone now and discard the result. Safe in any phase. */
  cancelListening(): void {
    if (this.state.phase === 'idle') return
    this.sessionId++ // everything the old session still says is ignored
    this.session?.cancel()
    this.session = null
    this.setPetListening(false)
    this.patch({ phase: 'idle', level: 0, text: '', final: false })
  }

  // ---------- reading replies aloud ----------
  /** A new request was submitted: whatever was being read is obsolete. */
  replyBegin(): void {
    this.splitter.reset()
    this.resetReply()
    this.d.tts.stop()
  }
  replyChunk(chunk: string): void {
    if (this.state.muted) return
    for (const sentence of this.splitter.push(chunk)) this.speakSentence(sentence)
  }
  /** The request finished. `completed` false = cancelled/failed/timed out: stop talking and drop the unspoken rest. */
  replyEnd(completed: boolean): void {
    if (completed && !this.state.muted) for (const sentence of this.splitter.flush()) this.speakSentence(sentence)
    else this.stopSpeaking()
    if (this.state.live && this.awaitingReply) {
      // your turn again as soon as he has finished saying it
      this.awaitingReply = false
      this.clearResume()
      if (this.ttsBusy()) this.resumeAfterSpeech = true
      else this.resumeSoon(400)
    }
  }
  stopSpeaking(): void {
    this.splitter.reset()
    this.resetReply()
    this.d.tts.stop()
  }
  private resetReply(): void {
    this.spokenChars = 0
    this.inCode = false
  }
  /**
   * Speak one sentence of the reply, as speech: markdown marks removed, code blocks skipped, and a long reply read only
   * up to `maxSpokenChars` (the whole text is always on screen) so the cat does not lecture for minutes.
   */
  private speakSentence(sentence: string): void {
    const fences = sentence.split('```').length - 1
    const wasInCode = this.inCode
    if (fences % 2 === 1) this.inCode = !this.inCode
    if (wasInCode || fences > 0) return
    const max = this.d.settings.maxSpokenChars
    if (max > 0 && this.spokenChars >= max) return
    const text = toSpeech(sentence)
    if (!text) return
    this.spokenChars += text.length
    this.d.tts.speak(text)
  }
  setMuted(muted: boolean): void {
    if (muted) this.stopSpeaking()
    this.patch({ muted })
  }
  toggleMute(): void {
    this.setMuted(!this.state.muted)
  }
  speakTest(): void {
    this.d.tts.speak('Hi! This is how I sound.')
  }

  /** App closing / panel closing / pet hiding: nothing may keep listening or talking. */
  shutdown(): void {
    this.endLive()
    this.cancelListening()
    this.stopSpeaking()
  }

  /** Something outside the controller failed (e.g. `say` could not start): show it. */
  reportError(message: string): void {
    this.patch({ error: { message, fix: null } })
  }

  /** Clear a shown error or notice (e.g. when the panel is reopened). */
  clearMessages(): void {
    if (this.state.error || this.state.notice) this.patch({ error: null, notice: null })
  }

  // ---------- internals ----------
  private setPetListening(v: boolean): void {
    if (this.petListening === v) return
    this.petListening = v
    this.d.onListeningChange(v)
  }
  private patch(p: Partial<VoiceUiState>): void {
    this.state = { ...this.state, ...p }
    this.d.onState(this.snapshot())
  }
}
