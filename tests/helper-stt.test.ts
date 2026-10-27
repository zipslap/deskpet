import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HelperStt, parseHelperLine } from '../src/services/voice/helper-stt'
import type { SttEndReason, SttError, SttSession } from '../src/services/voice/types'

const FAKE = fileURLToPath(new URL('../tools/fake-stt-helper.mjs', import.meta.url))
const opts = { locale: 'en-US', allowServerRecognition: false, maxSeconds: 30, silenceMs: 1800 }

describe('parseHelperLine (the helper is untrusted input)', () => {
  it('accepts every message type', () => {
    expect(parseHelperLine('{"type":"state","state":"listening"}')).toEqual({ type: 'state', state: 'listening' })
    expect(parseHelperLine('{"type":"partial","text":"hi"}')).toEqual({ type: 'partial', text: 'hi' })
    expect(parseHelperLine('{"type":"final","text":"hi there"}')).toEqual({ type: 'final', text: 'hi there' })
    expect(parseHelperLine('{"type":"ended","reason":"silence"}')).toEqual({ type: 'ended', reason: 'silence' })
    expect(parseHelperLine('{"type":"error","code":"mic-denied","message":"no"}')).toEqual({ type: 'error', code: 'mic-denied', message: 'no' })
    expect(parseHelperLine('{"type":"status","mic":"authorized","speech":"denied","onDevice":true}')).toEqual({
      type: 'status',
      status: { mic: 'authorized', speech: 'denied', onDevice: true }
    })
  })
  it('clamps levels, caps text, maps unknown codes/reasons/auth to safe values', () => {
    expect(parseHelperLine('{"type":"level","level":9}')).toEqual({ type: 'level', level: 1 })
    expect(parseHelperLine('{"type":"level","level":-2}')).toEqual({ type: 'level', level: 0 })
    expect((parseHelperLine(JSON.stringify({ type: 'partial', text: 'x'.repeat(9000) })) as { text: string }).text).toHaveLength(4000)
    expect(parseHelperLine('{"type":"error","code":"weird","message":"m"}')).toEqual({ type: 'error', code: 'failed', message: 'm' })
    expect(parseHelperLine('{"type":"ended","reason":"weird"}')).toEqual({ type: 'ended', reason: 'error' })
    expect(parseHelperLine('{"type":"status","mic":"???","speech":5,"onDevice":"yes"}')).toEqual({
      type: 'status',
      status: { mic: 'unknown', speech: 'unknown', onDevice: false }
    })
  })
  it.each(['', 'not json', '[]', 'null', '{"type":"nope"}', '{"type":"level","level":"high"}', '{"type":"partial","text":5}', '{"type":"state","state":3}'])('drops %j', (l) =>
    expect(parseHelperLine(l)).toBeNull()
  )
})

/** Runs one listen against the fake helper in `mode` and records everything the handlers see. */
function run(mode: string, o: Partial<typeof opts> = {}, killAfterMs = 1500) {
  process.env['PET_FAKE_STT_MODE'] = mode
  const log: string[] = []
  const errors: SttError[] = []
  let ended: SttEndReason | null = null
  let endedCount = 0
  const stt = new HelperStt({ helperPath: process.execPath, helperArgs: [FAKE], killAfterMs })
  const session: SttSession = stt.start(
    { ...opts, ...o },
    {
      onListening: () => log.push('listening'),
      onLevel: () => log.includes('level') || log.push('level'),
      onPartial: (t) => log.push(`partial:${t}`),
      onFinal: (t) => log.push(`final:${t}`),
      onError: (e) => errors.push(e),
      onEnded: (r) => {
        ended = r
        endedCount++
        log.push(`ended:${r}`)
      }
    }
  )
  return { session, log, errors, ended: () => ended, endedCount: () => endedCount }
}
const until = async (fn: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return fn()
}
beforeEach(() => void delete process.env['PET_FAKE_STT_MODE'])
afterEach(() => void delete process.env['PET_FAKE_STT_MODE'])

describe('HelperStt (against the fake helper)', () => {
  it('listens, streams partials, and delivers the final text on stop()', async () => {
    const r = run('ok')
    await until(() => r.log.includes('partial:hello there'))
    r.session.stop()
    await until(() => r.ended() !== null)
    expect(r.log[0]).toBe('listening')
    expect(r.log).toContain('level')
    expect(r.log.filter((l) => l.startsWith('partial:'))).toEqual(['partial:hello', 'partial:hello there'])
    expect(r.log.slice(-2)).toEqual(['final:hello there', 'ended:stopped'])
    expect(r.errors).toEqual([])
    expect(r.endedCount()).toBe(1)
  })

  it('cancel() ends with "cancelled" and delivers no text', async () => {
    const r = run('ok')
    await until(() => r.log.includes('partial:hello'))
    r.session.cancel()
    await until(() => r.ended() !== null)
    expect(r.ended()).toBe('cancelled')
    expect(r.log.some((l) => l.startsWith('final:'))).toBe(false)
    await new Promise((x) => setTimeout(x, 300))
    expect(r.endedCount()).toBe(1)
  })

  it('a helper that ends by itself (silence) delivers its final text', async () => {
    const r = run('silence')
    await until(() => r.ended() !== null)
    expect(r.log.slice(-2)).toEqual(['final:hello there', 'ended:silence'])
  })

  it('"nothing heard" ends cleanly with no text and no error', async () => {
    const r = run('nothing')
    await until(() => r.ended() !== null)
    expect(r.ended()).toBe('no-speech')
    expect(r.errors).toEqual([])
  })

  it.each(['mic-denied', 'speech-denied', 'unavailable'] as const)('%s: reports the error code, then ends once', async (mode) => {
    const r = run(mode)
    await until(() => r.ended() !== null)
    expect(r.errors.map((e) => e.code)).toEqual([mode])
    expect(r.ended()).toBe('error')
    expect(r.endedCount()).toBe(1)
  })

  it('a helper that crashes is reported once and never hangs the session', async () => {
    const r = run('crash')
    await until(() => r.ended() !== null)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.code).toBe('failed')
    expect(r.errors[0]!.message).toContain('stopped unexpectedly')
    expect(r.endedCount()).toBe(1)
  })

  it('a missing helper is reported as not-installed, and ends once', async () => {
    const errors: SttError[] = []
    let ended = 0
    const stt = new HelperStt({ helperPath: '/nonexistent/speech-helper' })
    stt.start(opts, {
      onListening() {}, onLevel() {}, onPartial() {}, onFinal() {},
      onError: (e) => errors.push(e),
      onEnded: () => ended++
    })
    await until(() => ended > 0)
    expect(errors.map((e) => e.code)).toEqual(['not-installed'])
    expect(ended).toBe(1)
  })

  it('stop() or cancel() after the session ended is harmless', async () => {
    const r = run('silence')
    await until(() => r.ended() !== null)
    r.session.stop()
    r.session.cancel()
    await new Promise((x) => setTimeout(x, 200))
    expect(r.endedCount()).toBe(1)
  })
})

describe('HelperStt.status', () => {
  it('reports permissions from the helper without listening', async () => {
    process.env['PET_FAKE_STT_MODE'] = 'not-authorized'
    const s = await new HelperStt({ helperPath: process.execPath, helperArgs: [FAKE] }).status('en-US')
    expect(s).toMatchObject({ installed: true, mic: 'notDetermined', speech: 'notDetermined', onDevice: true })
    process.env['PET_FAKE_STT_MODE'] = 'ok'
    expect(await new HelperStt({ helperPath: process.execPath, helperArgs: [FAKE] }).status('en-US')).toMatchObject({ installed: true, mic: 'authorized' })
  })
  it('says "not installed" for a missing helper', async () => {
    expect(await new HelperStt({ helperPath: '/nonexistent/speech-helper' }).status('en-US')).toMatchObject({ installed: false })
  })
})
