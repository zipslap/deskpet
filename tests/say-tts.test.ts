import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSystemTts, MAX_UTTERANCE_CHARS, SayTts, sapiRate, speakable, systemTtsPlan } from '../src/services/voice/say-tts'

const FAKE = new URL('../tools/fake-say.mjs', import.meta.url).pathname
let dir: string
let logFile: string
const calls = (): Array<{ args: string[]; text: string }> =>
  existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const until = async (fn: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return fn()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pet-say-'))
  logFile = join(dir, 'say.log')
  process.env['PET_FAKE_SAY_LOG'] = logFile
  process.env['PET_FAKE_SAY_MS_PER_CHAR'] = '10'
  delete process.env['PET_FAKE_SAY_FAIL']
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const k of ['PET_FAKE_SAY_LOG', 'PET_FAKE_SAY_MS_PER_CHAR', 'PET_FAKE_SAY_FAIL']) delete process.env[k]
})

describe('speakable()', () => {
  it('removes things not worth reading aloud and control characters', () => {
    expect(speakable('Hello\n\nworld')).toBe('Hello world')
    expect(speakable('Use `rm -rf /` carefully')).toBe('Use carefully')
    expect(speakable('See https://example.com/a?b=c now')).toBe('See link now')
    expect(speakable('**bold** _it_ # head > quote')).toBe('bold it head quote')
    expect(speakable('a\u0000b\u001bc')).toBe('a b c')
  })
  it('returns "" for nothing speakable and caps the length', () => {
    expect(speakable('  ***  ')).toBe('')
    expect(speakable('x'.repeat(5000))).toHaveLength(MAX_UTTERANCE_CHARS)
  })
})

describe('SayTts (against a fake `say`)', () => {
  const make = (extra: Partial<ConstructorParameters<typeof SayTts>[0]> = {}) => new SayTts({ voice: '', rate: 200, bin: FAKE, ...extra })

  it('speaks queued utterances in order and reports speaking true then false', async () => {
    const tts = make()
    const changes: boolean[] = []
    tts.onSpeakingChange((s) => changes.push(s))
    tts.speak('First sentence.')
    tts.speak('Second sentence.')
    expect(tts.speaking).toBe(true)
    expect(await until(() => !tts.speaking && calls().length === 2)).toBe(true)
    expect(calls().map((c) => c.text)).toEqual(['First sentence.', 'Second sentence.'])
    expect(changes).toEqual([true, false]) // one continuous stretch of speech, not a flicker between sentences
  })

  it('passes text on stdin only: it can never become an option or shell command', async () => {
    const tts = make({ voice: 'Eddy (English (US))' })
    tts.speak('-v Bad; $(touch /tmp/pwned) `x`')
    await until(() => calls().length === 1)
    const [c] = calls()
    expect(c!.args).toEqual(['-r', '200', '-v', 'Eddy (English (US))', '-f', '-'])
    expect(c!.text).toContain('-v Bad')
    expect(c!.args.join(' ')).not.toContain('pwned')
    expect(existsSync('/tmp/pwned')).toBe(false)
  })

  it('stop() silences immediately, clears the queue, and is safe to repeat', async () => {
    process.env['PET_FAKE_SAY_MS_PER_CHAR'] = '200'
    const tts = make()
    const changes: boolean[] = []
    tts.onSpeakingChange((s) => changes.push(s))
    tts.speak('A fairly long sentence that takes a while.')
    tts.speak('This one must never be spoken.')
    await until(() => calls().length === 1)
    tts.stop()
    tts.stop()
    expect(tts.speaking).toBe(false)
    await new Promise((r) => setTimeout(r, 400))
    expect(calls()).toHaveLength(1)
    expect(changes).toEqual([true, false])
  })

  it('can speak again after a stop', async () => {
    const tts = make()
    tts.speak('One.')
    tts.stop()
    tts.speak('Two.')
    expect(await until(() => calls().some((c) => c.text === 'Two.'))).toBe(true)
    await until(() => !tts.speaking)
    expect(tts.speaking).toBe(false)
  })

  it('ignores empty/unspeakable text', () => {
    const tts = make()
    tts.speak('   ')
    tts.speak('***')
    expect(tts.speaking).toBe(false)
  })

  it('reports a failing `say` once and recovers', async () => {
    process.env['PET_FAKE_SAY_FAIL'] = '1'
    const errors: string[] = []
    const tts = make({ onError: (m) => errors.push(m) })
    tts.speak('Will fail.')
    expect(await until(() => errors.length === 1)).toBe(true)
    expect(errors[0]).toContain('Voice not found')
    expect(tts.speaking).toBe(false)
    delete process.env['PET_FAKE_SAY_FAIL']
    tts.speak('Works now.')
    expect(await until(() => calls().some((c) => c.text === 'Works now.'))).toBe(true)
  })

  it('reports a missing binary instead of throwing', async () => {
    const errors: string[] = []
    const tts = make({ bin: '/nonexistent/say', onError: (m) => errors.push(m) })
    tts.speak('Hello.')
    expect(await until(() => errors.length === 1)).toBe(true)
    expect(tts.speaking).toBe(false)
  })
})

describe('real macOS say (writes to a file, makes no sound)', () => {
  it.skipIf(process.platform !== 'darwin')('accepts our arguments and produces audio', async () => {
    const { spawnSync } = await import('node:child_process')
    const out = join(mkdtempSync(join(tmpdir(), 'pet-realsay-')), 'x.aiff')
    const r = spawnSync('/usr/bin/say', ['-r', '185', '-o', out, '-f', '-'], { input: 'Testing one two three.' })
    expect(r.status).toBe(0)
    expect(readFileSync(out).length).toBeGreaterThan(5000)
    rmSync(join(out, '..'), { recursive: true, force: true })
  })
})

describe('the system voice on each OS', () => {
  it('macOS: say, with the text on stdin', () => {
    expect(systemTtsPlan('darwin', { voice: 'Eddy (English (US))', rate: 185 })).toEqual({ kind: 'say', bin: '/usr/bin/say', args: ['-r', '185', '-v', 'Eddy (English (US))', '-f', '-'] })
    expect(systemTtsPlan('darwin', { voice: '', rate: 185.4 }).args).toEqual(['-r', '185', '-f', '-'])
  })
  it('Windows: PowerShell + SAPI reading stdin, with the voice name safely quoted and the rate mapped', () => {
    const p = systemTtsPlan('win32', { voice: "O'Brien (UK)", rate: 180 })
    expect(p.kind).toBe('sapi')
    expect(p.bin).toBe('powershell.exe')
    expect(p.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    const script = p.args[3]!
    expect(script).toContain("SelectVoice('O''Brien (UK)')")
    expect(script).toContain('[Console]::In.ReadToEnd()')
    expect(script).toContain('$s.Rate = 0')
    expect(systemTtsPlan('win32', { voice: '', rate: 180 }).args[3]).not.toContain('SelectVoice')
  })
  it.each([[180, 0], [90, -5], [360, 10], [40, -8], [1000, 10], [0, -10]])('SAPI rate for %i wpm is %i', (wpm, rate) => expect(sapiRate(wpm)).toBe(rate))
  describe('Linux: the first speech program installed', () => {
    let dir: string
    const fake = (name: string): void => {
      writeFileSync(join(dir, name), '#!/bin/sh\n')
      chmodSync(join(dir, name), 0o755)
    }
    const dirs: string[] = []
    const mk = (): string => (dir = (dirs[dirs.push(mkdtempSync(join(tmpdir(), 'deskpet-tts-'))) - 1] as string))
    afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
    it.skipIf(process.platform === 'win32')('prefers espeak-ng, then espeak, then spd-say', () => {
      mk()
      fake('spd-say')
      expect(systemTtsPlan('linux', { voice: '', rate: 170 }, { PATH: dir }).kind).toBe('spd-say')
      fake('espeak')
      expect(systemTtsPlan('linux', { voice: '', rate: 170 }, { PATH: dir }).kind).toBe('espeak')
      fake('espeak-ng')
      const p = systemTtsPlan('linux', { voice: 'en-us', rate: 170 }, { PATH: dir })
      expect(p).toMatchObject({ kind: 'espeak', bin: join(dir, 'espeak-ng') })
      expect(p.args).toEqual(['-s', '170', '-v', 'en-us', '--stdin'])
    })
    it('none installed: a clear message when it is used', () => {
      expect(systemTtsPlan('linux', { voice: '', rate: 170 }, { PATH: mk() }).kind).toBe('none')
    })
  })
  it('with no program the voice reports how to get one instead of throwing', () => {
    const errors: string[] = []
    const old = process.env['PATH']
    process.env['PATH'] = mkdtempSync(join(tmpdir(), 'deskpet-empty-'))
    try {
      const tts = createSystemTts({ voice: '', rate: 170, platform: 'linux', onError: (m) => errors.push(m) })
      tts.speak('hello')
      return new Promise<void>((resolve) => setTimeout(() => {
        expect(errors.join(' ')).toMatch(/espeak-ng|offline voices/)
        resolve()
      }, 200))
    } finally {
      process.env['PATH'] = old
    }
  })
})
