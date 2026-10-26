import { DEFAULT_THEME, GRASS_HUE, themeColors, type Theme } from '../shared/theme'

const root = document.documentElement.style
const grass = document.getElementById('grass') as HTMLElement
const dark = window.matchMedia('(prefers-color-scheme: dark)')
let current: Theme = { ...DEFAULT_THEME }

/** Push a theme into CSS custom properties (the page has no inline styles, so this uses the CSSOM only). */
export function applyTheme(t: Theme): void {
  current = t
  const c = themeColors(t, dark.matches)
  root.setProperty('--plate', c.plate)
  root.setProperty('--plate-alpha', String(c.plateAlpha))
  root.setProperty('--bubble', c.bubble)
  root.setProperty('--line', c.line)
  root.setProperty('--fg', c.ink)
  root.setProperty('--muted', c.muted)
  root.setProperty('--grass-filter', c.grassFilter)
  root.setProperty('--grass-opacity', String(c.grassOpacity))
  grass.style.filter = c.grassFilter
  grass.style.opacity = String(c.grassOpacity)
}
dark.addEventListener('change', () => applyTheme(current))

export const currentTheme = (): Theme => current

/** Colour of a preset swatch: the grass hue shifted by `hue`. */
export const swatchColor = (hue: number): string => `hsl(${(((GRASS_HUE + hue) % 360) + 360) % 360} 55% 55%)`
