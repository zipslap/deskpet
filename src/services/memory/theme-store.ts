import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_THEME, normalizeTheme, type Theme } from '../../shared/theme'

/**
 * The chat panel's look lives in its own small file, separate from settings.json, because the user changes it from
 * the panel itself and settings.json is never rewritten by the app. A missing or unreadable file means the default look.
 */
export function loadTheme(path: string): { theme: Theme; warning?: string } {
  if (!existsSync(path)) return { theme: { ...DEFAULT_THEME } }
  try {
    return { theme: normalizeTheme(JSON.parse(readFileSync(path, 'utf8'))) }
  } catch (e) {
    return { theme: { ...DEFAULT_THEME }, warning: `could not read ${path}: ${(e as Error).message}; using the default look` }
  }
}

/** Atomic write (temp file + rename), so a crash mid-save never leaves a half-written file. */
export function saveTheme(path: string, theme: Theme): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(theme, null, 2) + '\n')
  renameSync(tmp, path)
}
