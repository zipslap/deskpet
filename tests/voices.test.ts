import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SwitchableTts, type DisposableTts } from '../src/services/voice/switchable-tts'
import { installedVoices, isUsableModelDir, loadCatalog, speakerLabel } from '../src/services/voice/voice-catalog'

const ASSETS = join(__dirname, '../assets')
const catalog = loadCatalog(ASSETS)

describe('voice catalog (assets/voices/catalog.json)', () => {
  it('lists many voices with unique ids, real archive names and sizes', () => {
    expect(catalog.length).toBeGreaterThan(100)
    expect(new Set(catalog.map((v) => v.id)).size).toBe(catalog.length)
    for (const v of catalog) {
      expect(v.asset, v.id).toMatch(/^[A-Za-z0-9._-]+\.tar\.bz2$/)
      expect(v.mb, v.id).toBeGreaterThan(0)
      expect(['kokoro', 'vits']).toContain(v.family)
      expect(v.id, v.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
    }
  })
  it('Kokoro lists its named speakers, and the default speaker exists', () => {
    const k = catalog.find((v) => v.id === 'kokoro-multi-lang-v1_0')!
    expect(k.speakers).toHaveLength(53)
    expect(k.speakers![3]).toBe('af_heart')
  })
  it('covers a wide range of languages, with a recommended starter in each', () => {
    const langs = new Set(catalog.map((v) => v.lang))
    expect(langs.size).toBeGreaterThan(40)
    const rec = catalog.filter((v) => v.recommended)
    expect(rec.length).toBeGreaterThan(50)
    expect(new Set(rec.map((v) => v.lang)).size).toBeGreaterThan(35)
  })
  it('an unreadable catalog is just empty', () => expect(loadCatalog('/no/such/dir')).toEqual([]))
})

describe('installed voices', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deskpet-voices-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const make = (id: string, files: string[]): void => {
    mkdirSync(join(dir, id), { recursive: true })
    for (const f of files) writeFileSync(join(dir, id, f), 'x')
  }
  it('a Piper folder needs a model and tokens; a Kokoro folder also needs voices.bin', () => {
    make('piper-ok', ['a.onnx', 'tokens.txt'])
    make('piper-no-tokens', ['a.onnx'])
    make('kokoro-ok', ['model.int8.onnx', 'tokens.txt', 'voices.bin'])
    make('kokoro-no-voices', ['model.onnx', 'tokens.txt'])
    expect(isUsableModelDir(join(dir, 'piper-ok'), 'vits')).toBe(true)
    expect(isUsableModelDir(join(dir, 'piper-no-tokens'), 'vits')).toBe(false)
    expect(isUsableModelDir(join(dir, 'kokoro-ok'), 'kokoro')).toBe(true)
    expect(isUsableModelDir(join(dir, 'kokoro-no-voices'), 'kokoro')).toBe(false)
    expect(isUsableModelDir(join(dir, 'missing'), 'vits')).toBe(false)
  })
  it('only catalogued voices whose folder is complete count as installed', () => {
    make('piper-en_US-amy-medium', ['amy.onnx', 'tokens.txt'])
    make('kokoro-multi-lang-v1_0', ['model.onnx', 'tokens.txt']) // incomplete download
    make('not-in-catalog', ['a.onnx', 'tokens.txt'])
    const got = installedVoices(catalog, dir)
    expect(got.map((v) => v.id)).toEqual(['piper-en_US-amy-medium'])
    expect(got[0]!.dir).toBe(join(dir, 'piper-en_US-amy-medium'))
  })
})

describe('speakerLabel', () => {
  it.each([
    ['af_heart', 'Heart (US, female)'],
    ['bm_george', 'George (UK, male)'],
    ['zf_xiaoxiao', 'Xiaoxiao (ZH, female)'],
    ['am', 'am']
  ])('%s → %s', (name, label) => expect(speakerLabel(name)).toBe(label))
})

class FakeTts implements DisposableTts {
  speaking = false
  spoken: string[] = []
  stopped = 0
  disposed = 0
  private cbs: Array<(s: boolean) => void> = []
  speak(t: string): void {
    this.spoken.push(t)
  }
  stop(): void {
    this.stopped++
  }
  dispose(): void {
    this.disposed++
  }
  onSpeakingChange(cb: (s: boolean) => void): void {
    this.cbs.push(cb)
  }
  emit(s: boolean): void {
    this.speaking = s
    for (const cb of this.cbs) cb(s)
  }
}

describe('SwitchableTts', () => {
  it('forwards speech and speaking changes to the current engine', () => {
    const a = new FakeTts()
    const t = new SwitchableTts(a)
    const seen: boolean[] = []
    t.onSpeakingChange((s) => seen.push(s))
    t.speak('hi')
    a.emit(true)
    a.emit(false)
    expect(a.spoken).toEqual(['hi'])
    expect(seen).toEqual([true, false])
  })
  it('switching silences and shuts down the old engine, and the new one takes over', () => {
    const a = new FakeTts()
    const b = new FakeTts()
    const t = new SwitchableTts(a)
    const seen: boolean[] = []
    t.onSpeakingChange((s) => seen.push(s))
    a.emit(true)
    t.use(b)
    expect(a.stopped).toBe(1)
    expect(a.disposed).toBe(1)
    expect(seen).toEqual([true, false]) // the interrupted speech is reported as ended
    t.speak('new voice')
    expect(b.spoken).toEqual(['new voice'])
    b.emit(true)
    expect(seen).toEqual([true, false, true])
  })
  it('ignores late events from an engine that was replaced', () => {
    const a = new FakeTts()
    const b = new FakeTts()
    const t = new SwitchableTts(a)
    const seen: boolean[] = []
    t.onSpeakingChange((s) => seen.push(s))
    t.use(b)
    a.emit(true)
    expect(seen).toEqual([])
    expect(t.speaking).toBe(false)
  })
})
