import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type VoiceSettings } from '../src/services/memory/settings'
import { VoiceController, describeSttError, toSpeech } from '../src/services/voice/voice-controller'
import type { SpeechToText, SttHandlers, SttSession, SttStartOptions, SttStatus, TextToSpeech } from '../src/services/voice/types'
import type { VoiceUiState } from '../src/shared/voice-types'

class FakeTts implements TextToSpeech {
  busy = false
  spoken: string[] = []
  stops = 0
  speaking = false
  private cb: Array<(s: boolean) => void> = []
  onSpeakingChange(cb: (s: boolean) => void): void { this.cb.push(cb) }
  speak(t: string): void { this.spoken.push(t); this.set(true) }
  stop(): void { this.stops++; this.set(false) }
  finish(): void { this.set(false) }
  private set(v: boolean): void { if (this.speaking !== v) { this.speaking = v; this.cb.forEach((c) => c(v)) } }
}

class FakeStt implements SpeechToText {
  h!: SttHandlers
  started = 0
  opts!: SttStartOptions
  stopped = 0
  cancelled = 0
  throwOnStart: Error | null = null
  installed = true
  async status(): Promise<SttStatus> { return { installed: this.installed, mic: 'authorized', speech: 'authorized', onDevice: true } }
  start(o: SttStartOptions, h: SttHandlers): SttSession {
    if (this.throwOnStart) throw this.throwOnStart
    this.started++
    this.opts = o
    this.h = h
    return { stop: () => void this.stopped++, cancel: () => void this.cancelled++ }
  }
}

function setup(voice: Partial<VoiceSettings> = {}) {
  const stt = new FakeStt()
  const tts = new FakeTts()
  const states: VoiceUiState[] = []
  const pet: string[] = []
  const sent: string[] = []
  let before = 0
  const settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, live: false, ...voice } // push-to-talk unless a test turns live on
  const vc = new VoiceController({
    stt, tts, settings,
    onState: (s) => states.push(s),
    onListeningChange: (on) => pet.push(`listening:${on}`),
    onSpeakingChange: (on) => pet.push(`speaking:${on}`),
    beforeListen: () => void before++,
    onAutoSend: (t) => void sent.push(t)
  })
  return { vc, stt, tts, states, pet, sent, before: () => before, last: () => vc.snapshot() }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('describeSttError', () => {
  it('gives actionable text and the right Settings pane', () => {
    expect(describeSttError({ code: 'mic-denied', message: 'x' })).toMatchObject({ fix: 'microphone' })
    expect(describeSttError({ code: 'speech-denied', message: 'x' })).toMatchObject({ fix: 'speech' })
    expect(describeSttError({ code: 'not-installed', message: 'build it' })).toEqual({ message: 'build it', fix: null })
    expect(describeSttError({ code: 'failed', message: '' }).message).toBeTruthy()
  })
})

describe('listening (push to talk)', () => {
  it('starts, shows partials, stops on request, keeps the final text for review', async () => {
    const t = setup()
    await tick()
    expect(t.last().canListen).toBe(true)
    t.vc.toggleListen()
    expect(t.last().phase).toBe('starting')
    expect(t.before()).toBe(1)
    expect(t.stt.opts).toMatchObject({ locale: 'en-US', allowServerRecognition: false, maxSeconds: 30, silenceMs: 1200 })
    expect(t.pet).toEqual([]) // not "listening" until the mic is actually open
    t.stt.h.onListening()
    expect(t.last().phase).toBe('listening')
    expect(t.pet).toEqual(['listening:true'])
    t.stt.h.onLevel(0.5)
    t.stt.h.onPartial('hello')
    expect(t.last()).toMatchObject({ level: 0.5, text: 'hello', final: false })
    t.vc.toggleListen() // press again = stop
    expect(t.last().phase).toBe('stopping')
    expect(t.stt.stopped).toBe(1)
    t.stt.h.onFinal('hello there')
    t.stt.h.onEnded('stopped')
    expect(t.last()).toMatchObject({ phase: 'idle', text: 'hello there', final: true, level: 0, error: null, notice: null })
    expect(t.pet).toEqual(['listening:true', 'listening:false'])
    expect(t.sent).toEqual([]) // review first: nothing is sent automatically
  })

  it('autoSend sends the dictation and clears the box', () => {
    const t = setup({ autoSend: true })
    t.vc.startListening()
    t.stt.h.onListening()
    t.stt.h.onFinal('send me')
    t.stt.h.onEnded('silence')
    expect(t.sent).toEqual(['send me'])
    expect(t.last()).toMatchObject({ phase: 'idle', text: '', final: false })
  })

  it('autoSend never sends after an error', () => {
    const t = setup({ autoSend: true })
    t.vc.startListening()
    t.stt.h.onFinal('partial thing')
    t.stt.h.onError({ code: 'failed', message: 'boom' })
    t.stt.h.onEnded('error')
    expect(t.sent).toEqual([])
    expect(t.last().error?.message).toBe('boom')
  })

  it('hearing nothing gives a gentle notice, not an error', () => {
    const t = setup()
    t.vc.startListening()
    t.stt.h.onListening()
    t.stt.h.onEnded('no-speech')
    expect(t.last()).toMatchObject({ phase: 'idle', error: null, text: '' })
    expect(t.last().notice).toMatch(/didn't catch/i)
  })

  it('permission denied: shows a fixable error, closes cleanly, and can retry', () => {
    const t = setup()
    t.vc.startListening()
    t.stt.h.onError({ code: 'mic-denied', message: 'x' })
    t.stt.h.onEnded('error')
    expect(t.last()).toMatchObject({ phase: 'idle', error: { fix: 'microphone' } })
    expect(t.pet).toEqual([]) // the pet never pretended to listen
    t.vc.toggleListen()
    expect(t.last()).toMatchObject({ phase: 'starting', error: null }) // a new attempt clears the old error
  })

  it('cancel discards everything and ignores whatever the old session still says', () => {
    const t = setup()
    t.vc.startListening()
    const old = t.stt.h
    old.onListening()
    old.onPartial('secret words')
    t.vc.cancelListening()
    expect(t.stt.cancelled).toBe(1)
    expect(t.last()).toMatchObject({ phase: 'idle', text: '', final: false })
    expect(t.pet).toEqual(['listening:true', 'listening:false'])
    old.onFinal('late final') // stale session
    old.onEnded('stopped')
    old.onPartial('late partial')
    expect(t.last()).toMatchObject({ phase: 'idle', text: '' })
    expect(t.pet).toEqual(['listening:true', 'listening:false'])
    // and a new session is unaffected by the old one
    t.vc.startListening()
    t.stt.h.onPartial('fresh')
    expect(t.last().text).toBe('fresh')
  })

  it('toggling while still starting cancels (e.g. a permission prompt that never gets answered)', () => {
    const t = setup()
    t.vc.toggleListen()
    t.vc.toggleListen()
    expect(t.stt.cancelled).toBe(1)
    expect(t.last().phase).toBe('idle')
  })

  it('a second start while active is ignored', () => {
    const t = setup()
    t.vc.startListening()
    t.vc.startListening()
    expect(t.stt.started).toBe(1)
  })

  it('a start that throws is reported and leaves the controller usable', () => {
    const t = setup()
    t.stt.throwOnStart = new Error('spawn failed')
    t.vc.startListening()
    expect(t.last()).toMatchObject({ phase: 'idle' })
    expect(t.last().error?.message).toContain('spawn failed')
    t.stt.throwOnStart = null
    t.vc.startListening()
    expect(t.last().phase).toBe('starting')
  })

  it('canListen is false when the helper is not installed', async () => {
    const stt = new FakeStt()
    stt.installed = false
    const states: VoiceUiState[] = []
    const vc = new VoiceController({ stt, tts: new FakeTts(), settings: DEFAULT_SETTINGS.voice, onState: (s) => states.push(s), onListeningChange() {}, onSpeakingChange() {}, beforeListen() {}, onAutoSend() {} })
    await tick()
    expect(vc.snapshot().canListen).toBe(false)
  })

  it('shutdown closes the microphone and stops the voice, from any phase', () => {
    const t = setup()
    t.vc.startListening()
    t.stt.h.onListening()
    t.tts.speak('talking')
    t.vc.shutdown()
    expect(t.stt.cancelled).toBe(1)
    expect(t.tts.speaking).toBe(false)
    expect(t.last().phase).toBe('idle')
    t.vc.shutdown() // idempotent
  })
})

describe('reading replies aloud', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => void (t = setup()))

  it('speaks sentence by sentence as the reply streams, and the tail on completion', () => {
    t.vc.replyBegin()
    t.vc.replyChunk('Hello there. How ')
    expect(t.tts.spoken).toEqual(['Hello there.'])
    t.vc.replyChunk('are you? Fine')
    t.vc.replyEnd(true)
    expect(t.tts.spoken).toEqual(['Hello there.', 'How are you?', 'Fine'])
    expect(t.pet).toEqual(['speaking:true'])
  })

  it('a cancelled or failed request stops the voice and drops the unspoken rest', () => {
    t.vc.replyBegin()
    t.vc.replyChunk('One. Two partial')
    t.vc.replyEnd(false)
    expect(t.tts.speaking).toBe(false)
    expect(t.tts.spoken).toEqual(['One.'])
    t.vc.replyBegin()
    t.vc.replyChunk('Next. ')
    t.vc.replyEnd(true)
    expect(t.tts.spoken).toEqual(['One.', 'Next.']) // "Two partial" never comes back
  })

  it('a new request silences the previous reply', () => {
    t.vc.replyChunk('Old sentence. ')
    const stops = t.tts.stops
    t.vc.replyBegin()
    expect(t.tts.stops).toBe(stops + 1)
  })

  it('muted: nothing is spoken, muting mid-speech stops it, unmuting does not replay', () => {
    t.vc.replyChunk('Speak this. ')
    expect(t.tts.speaking).toBe(true)
    t.vc.toggleMute()
    expect(t.last().muted).toBe(true)
    expect(t.tts.speaking).toBe(false)
    t.vc.replyChunk('Silent. ')
    t.vc.replyEnd(true)
    expect(t.tts.spoken).toEqual(['Speak this.'])
    t.vc.toggleMute()
    expect(t.last().muted).toBe(false)
    expect(t.tts.spoken).toEqual(['Speak this.'])
  })

  it('starts muted when the setting says replies should not be spoken', () => {
    const m = setup({ speakReplies: false })
    expect(m.last().muted).toBe(true)
    m.vc.replyChunk('No sound. ')
    expect(m.tts.spoken).toEqual([])
  })

  it('"Test voice" speaks a fixed sentence', () => {
    t.vc.speakTest()
    expect(t.tts.spoken).toHaveLength(1)
  })

  it('reports speaking changes to the UI state and the pet', () => {
    t.vc.replyChunk('Hi. ')
    expect(t.last().speaking).toBe(true)
    t.tts.finish()
    expect(t.last().speaking).toBe(false)
    expect(t.pet).toEqual(['speaking:true', 'speaking:false'])
  })

  it('talking over the pet: beforeListen is called so the caller can stop speech/request first', () => {
    t.vc.replyChunk('Long reply. ')
    t.vc.startListening()
    expect(t.before()).toBe(1)
  })
})

describe('toSpeech', () => {
  it.each([
    ['**Bold** and *soft* and `code`.', 'Bold and soft and code.'],
    ['- a list item', 'a list item'],
    ['## A heading', 'A heading'],
    ['3. third thing', 'third thing'],
    ['See [the docs](https://example.com) now.', 'See the docs now.'],
    ['2 * 3 = 6 and 4*5', '2 * 3 = 6 and 4*5']
  ])('%j -> %j', (input, expected) => expect(toSpeech(input)).toBe(expected))
})

describe('reading long replies aloud', () => {
  const feed = (t: ReturnType<typeof setup>, text: string): void => {
    t.vc.replyBegin()
    t.vc.replyChunk(text)
    t.vc.replyEnd(true)
  }
  it('stops queueing sentences once maxSpokenChars is reached; the rest stays on screen only', () => {
    const t = setup({ maxSpokenChars: 40 })
    feed(t, 'First sentence is here. Second sentence is here. Third sentence is here. Fourth one too.')
    expect(t.tts.spoken).toEqual(['First sentence is here.', 'Second sentence is here.'])
  })
  it('0 reads everything', () => {
    const t = setup({ maxSpokenChars: 0 })
    feed(t, 'One two three four five. '.repeat(30))
    expect(t.tts.spoken).toHaveLength(30)
  })
  it('never reads a code block aloud, and strips markdown marks', () => {
    const t = setup()
    feed(t, 'Here is **the** idea.\n```\nconst x = 1;\nconsole.log(x);\n```\nThat is `it`.')
    expect(t.tts.spoken).toEqual(['Here is the idea.', 'That is it.'])
  })
  it('a new reply starts counting from zero', () => {
    const t = setup({ maxSpokenChars: 20 })
    feed(t, 'Aaaaaaaaaaaaaaaaaaaaaaaa. Bbbbbbbbbbbb.')
    feed(t, 'Cccc.')
    expect(t.tts.spoken).toEqual(['Aaaaaaaaaaaaaaaaaaaaaaaa.', 'Cccc.'])
  })
})

describe('live conversation', () => {
  const listenAndSay = (t: ReturnType<typeof setup>, text: string): void => {
    t.stt.h.onListening()
    if (text) t.stt.h.onFinal(text)
    t.stt.h.onEnded(text ? 'silence' : 'no-speech')
  }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('sends what you say when you pause, without a Send click, then listens again once he has finished talking', async () => {
    const t = setup({ live: true })
    t.vc.toggleListen()
    expect(t.last()).toMatchObject({ live: true, phase: 'starting' })
    listenAndSay(t, 'what is a p value')
    expect(t.sent).toEqual(['what is a p value'])
    expect(t.last()).toMatchObject({ live: true, phase: 'idle', text: '' })
    // the reply streams in and is read aloud; the mic stays closed meanwhile (no echo)
    t.vc.replyBegin()
    t.vc.replyChunk('Ooh, stats! ')
    t.tts.busy = true
    t.vc.replyEnd(true)
    await wait(500)
    expect(t.stt.started).toBe(1)
    t.tts.busy = false
    t.tts.finish()
    await wait(450)
    expect(t.stt.started).toBe(2)
    expect(t.last().live).toBe(true)
  })

  it('keeps listening through short silences, and pauses after a long quiet spell', async () => {
    const t = setup({ live: true })
    t.vc.toggleListen()
    listenAndSay(t, '')
    await wait(200)
    expect(t.stt.started).toBe(2)
    listenAndSay(t, '')
    await wait(200)
    listenAndSay(t, '')
    await wait(200)
    expect(t.stt.started).toBe(3)
    expect(t.last().live).toBe(false)
    expect(t.last().notice).toMatch(/quiet/)
  })

  it('pressing the button while he talks interrupts him and listens; pressing while listening ends it', async () => {
    const t = setup({ live: true })
    t.vc.toggleListen()
    listenAndSay(t, 'tell me a story')
    const before = t.before()
    t.vc.toggleListen() // he is thinking or talking: barge in
    expect(t.before()).toBe(before + 1) // stops the voice and the request
    expect(t.stt.started).toBe(2)
    t.stt.h.onListening()
    t.vc.toggleListen() // listening: end the conversation
    expect(t.last()).toMatchObject({ live: false, phase: 'idle' })
    expect(t.stt.cancelled).toBe(1)
  })

  it('a microphone error ends the live conversation instead of retrying forever', () => {
    const t = setup({ live: true })
    t.vc.toggleListen()
    t.stt.h.onError({ code: 'mic-denied', message: 'no' })
    t.stt.h.onEnded('error')
    expect(t.last().live).toBe(false)
    expect(t.last().error?.fix).toBe('microphone')
  })
})
