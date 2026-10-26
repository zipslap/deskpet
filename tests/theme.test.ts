import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_THEME, READABLE_ALPHA, THEME_LIMITS, normalizeTheme, parseTheme, themeColors } from '../src/shared/theme'
import { loadTheme, saveTheme } from '../src/services/memory/theme-store'

describe('parseTheme (strict, for IPC)', () => {
  it('accepts the default and the extremes of every slider', () => {
    expect(parseTheme(DEFAULT_THEME)).toEqual(DEFAULT_THEME)
    for (const k of Object.keys(THEME_LIMITS) as Array<keyof typeof THEME_LIMITS>)
      for (const v of THEME_LIMITS[k]) expect(parseTheme({ ...DEFAULT_THEME, [k]: v })).toEqual({ ...DEFAULT_THEME, [k]: v })
  })
  it('rounds to whole numbers (opacity to 2 places)', () => {
    expect(parseTheme({ hue: 10.4, saturation: 99.6, brightness: 100, opacity: 0.456 })).toEqual({ hue: 10, saturation: 100, brightness: 100, opacity: 0.46 })
  })
  it.each([
    null, undefined, 5, 'x', [], {},
    { ...DEFAULT_THEME, hue: 181 }, { ...DEFAULT_THEME, hue: -181 }, { ...DEFAULT_THEME, saturation: -1 }, { ...DEFAULT_THEME, saturation: 201 },
    { ...DEFAULT_THEME, brightness: 49 }, { ...DEFAULT_THEME, brightness: 151 }, { ...DEFAULT_THEME, opacity: 0.19 }, { ...DEFAULT_THEME, opacity: 1.01 },
    { ...DEFAULT_THEME, hue: NaN }, { ...DEFAULT_THEME, hue: Infinity }, { ...DEFAULT_THEME, hue: '10' }, { ...DEFAULT_THEME, opacity: null },
    { hue: 0, saturation: 100, brightness: 100 }
  ])('rejects %j', (v) => expect(parseTheme(v)).toBeNull())
  it('ignores extra fields', () => {
    expect(parseTheme({ ...DEFAULT_THEME, evil: '<script>' })).toEqual(DEFAULT_THEME)
  })
})

describe('normalizeTheme (lenient, for a hand-edited file)', () => {
  it('keeps good fields, clamps out-of-range ones and defaults the rest', () => {
    expect(normalizeTheme({ hue: 400, saturation: -5, brightness: 'x', opacity: 0.5 })).toEqual({ hue: 180, saturation: 0, brightness: 100, opacity: 0.5 })
  })
  it.each([null, 5, 'x', [], undefined])('gives the default for %j', (v) => expect(normalizeTheme(v)).toEqual(DEFAULT_THEME))
})

// ---- readability: whatever the user picks, the words must stay legible ----
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  s /= 100
  l /= 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}
const parseColor = (c: string): [number, number, number] => {
  const m = /^hsl\((\d+) (\d+)% ([\d.]+)%\)$/.exec(c)
  if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]))
  const x = /^#([0-9a-f]{6})$/i.exec(c)!
  return [0, 2, 4].map((i) => parseInt(x[1]!.slice(i, i + 2), 16)) as [number, number, number]
}
const lum = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number): number => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
const contrast = (a: string, b: string): number => {
  const [la, lb] = [lum(parseColor(a)), lum(parseColor(b))]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('themeColors', () => {
  const hues = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180]
  const all = hues.flatMap((hue) => [0, 100, 200].flatMap((saturation) => [50, 100, 150].flatMap((brightness) => ({ hue, saturation, brightness, opacity: 0.2 }))))
  for (const dark of [false, true]) {
    it(`keeps text readable at every extreme of the sliders (${dark ? 'dark' : 'light'} mode)`, () => {
      let worstInk = Infinity
      let worstMuted = Infinity
      for (const t of all) {
        const c = themeColors(t, dark)
        worstInk = Math.min(worstInk, contrast(c.ink, c.plate), contrast(c.ink, c.bubble))
        worstMuted = Math.min(worstMuted, contrast(c.muted, c.plate), contrast(c.muted, c.bubble))
      }
      expect(worstInk).toBeGreaterThanOrEqual(7)
      expect(worstMuted).toBeGreaterThanOrEqual(4.5)
    })
  }
  it('never lets the text plate get more transparent than the readable floor, whatever the opacity', () => {
    for (const opacity of [0.2, 0.5, 1]) expect(themeColors({ ...DEFAULT_THEME, opacity }, false).plateAlpha).toBeGreaterThanOrEqual(READABLE_ALPHA)
    expect(themeColors({ ...DEFAULT_THEME, opacity: 0.2 }, false).plateAlpha).toBeCloseTo(READABLE_ALPHA)
    expect(themeColors({ ...DEFAULT_THEME, opacity: 1 }, false).plateAlpha).toBeCloseTo(1)
  })
  it('rotates the plate hue with the hue slider and drives the grass filter and opacity', () => {
    expect(themeColors(DEFAULT_THEME, false).plate).toMatch(/^hsl\(125 /)
    expect(themeColors({ ...DEFAULT_THEME, hue: 90 }, false).plate).toMatch(/^hsl\(215 /)
    expect(themeColors({ ...DEFAULT_THEME, hue: -180 }, false).plate).toMatch(/^hsl\(305 /)
    const c = themeColors({ hue: 40, saturation: 150, brightness: 80, opacity: 0.6 }, false)
    expect(c.grassFilter).toBe('hue-rotate(40deg) saturate(150%) brightness(80%)')
    expect(c.grassOpacity).toBe(0.6)
  })
  it('produces only values safe to put in CSS (no stray characters)', () => {
    for (const t of all) {
      const c = themeColors(t, false)
      for (const v of [c.plate, c.bubble, c.line, c.grassFilter]) expect(v).toMatch(/^[a-z0-9 ().%#-]+$/i)
    }
  })
})

describe('theme store', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'pet-theme-'))
    dirs.push(d)
    return d
  }
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it('is the default look when there is no file, and creates nothing', () => {
    const path = join(tmp(), 'theme.json')
    expect(loadTheme(path)).toEqual({ theme: DEFAULT_THEME })
  })
  it('round-trips a saved theme (creating folders as needed)', () => {
    const path = join(tmp(), 'a', 'b', 'theme.json')
    const t = { hue: -95, saturation: 120, brightness: 90, opacity: 0.7 }
    saveTheme(path, t)
    expect(loadTheme(path).theme).toEqual(t)
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
  })
  it('falls back to the default (with a warning) for a corrupt file, and a bad value only costs that field', () => {
    const d = tmp()
    writeFileSync(join(d, 'bad.json'), '{ not json')
    const r = loadTheme(join(d, 'bad.json'))
    expect(r.theme).toEqual(DEFAULT_THEME)
    expect(r.warning).toMatch(/default look/)
    writeFileSync(join(d, 'part.json'), JSON.stringify({ hue: 30, opacity: 'x', brightness: 9999 }))
    expect(loadTheme(join(d, 'part.json')).theme).toEqual({ ...DEFAULT_THEME, hue: 30, brightness: 150 })
  })
  it('leaves no temp file behind', () => {
    const d = tmp()
    saveTheme(join(d, 'theme.json'), DEFAULT_THEME)
    expect(() => readFileSync(join(d, 'theme.json.tmp'))).toThrow()
  })
})
