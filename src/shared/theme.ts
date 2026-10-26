/**
 * The look of the chat panel: a patch of pixel grass the user can recolour. Pure data and maths (no DOM), shared by
 * the main process (validate + save) and the chat renderer (apply), and unit-tested.
 */
export interface Theme {
  /** Degrees to rotate the colour away from grass green. */
  hue: number
  /** Colour richness, percent (0 = grey). */
  saturation: number
  /** Percent of the normal lightness. */
  brightness: number
  /** Opacity of the grass, 0.2 to 1. The text plate never goes below READABLE_ALPHA. */
  opacity: number
}

export const THEME_LIMITS = {
  hue: [-180, 180],
  saturation: [0, 200],
  brightness: [50, 150],
  opacity: [0.2, 1]
} as const satisfies Record<keyof Theme, readonly [number, number]>

export const DEFAULT_THEME: Theme = { hue: 0, saturation: 100, brightness: 100, opacity: 1 }

/** Never let the text plate get more transparent than this: the words must stay readable over anything. */
export const READABLE_ALPHA = 0.8

const KEYS = Object.keys(THEME_LIMITS) as Array<keyof Theme>
const inRange = (k: keyof Theme, n: number): boolean => n >= THEME_LIMITS[k][0] && n <= THEME_LIMITS[k][1]
const round = (k: keyof Theme, n: number): number => (k === 'opacity' ? Math.round(n * 100) / 100 : Math.round(n))

/** Strict: every field present, finite and within range. Anything else is rejected whole (used for IPC from the renderer). */
export function parseTheme(v: unknown): Theme | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out = { ...DEFAULT_THEME }
  for (const k of KEYS) {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || !inRange(k, n)) return null
    out[k] = round(k, n)
  }
  return out
}

/** Lenient: for a hand-edited file. Each bad or missing field falls back to its default; good ones are kept (clamped). */
export function normalizeTheme(v: unknown): Theme {
  const out = { ...DEFAULT_THEME }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  const o = v as Record<string, unknown>
  for (const k of KEYS) {
    const n = o[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = round(k, Math.min(THEME_LIMITS[k][1], Math.max(THEME_LIMITS[k][0], n)))
  }
  return out
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
/** The grass art is drawn in green; this is its hue so `theme.hue` can offset it. */
export const GRASS_HUE = 125

export interface ThemeColors {
  /** hsl() strings, ready for CSS custom properties */
  plate: string
  plateAlpha: number
  bubble: string
  line: string
  ink: string
  muted: string
  /** CSS filter for the grass layers */
  grassFilter: string
  grassOpacity: number
}

export function themeColors(t: Theme, dark: boolean): ThemeColors {
  const h = (((GRASS_HUE + t.hue) % 360) + 360) % 360
  const sat = clamp(34 * (t.saturation / 100), 0, dark ? 38 : 52)
  const bf = t.brightness / 100
  const L = dark ? clamp(14 + (bf - 1) * 8, 8, 19) : clamp(91 + (bf - 1) * 12, 82, 96)
  const hsl = (s: number, l: number): string => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(1)}%)`
  const op = (t.opacity - THEME_LIMITS.opacity[0]) / (THEME_LIMITS.opacity[1] - THEME_LIMITS.opacity[0])
  return {
    plate: hsl(sat, L),
    plateAlpha: READABLE_ALPHA + (1 - READABLE_ALPHA) * op,
    bubble: hsl(sat, dark ? L + 6 : L - 6),
    line: hsl(Math.min(70, sat + 8), dark ? L + 16 : L - 28),
    ink: dark ? '#eef3ff' : '#14213a',
    muted: dark ? '#bcc7de' : '#34405a',
    grassFilter: `hue-rotate(${t.hue}deg) saturate(${t.saturation}%) brightness(${t.brightness}%)`,
    grassOpacity: t.opacity
  }
}
