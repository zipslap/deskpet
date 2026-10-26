/**
 * What is on screen and what must never be captured. Pure functions over data from the window helper, so the rules can be
 * tested without a screen. Window *titles* are never involved: only app names, bundle ids and geometry.
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface FrontApp {
  name: string
  bundleId: string
  pid: number
}
export interface WinInfo extends Rect {
  id: number
  owner: string
  bundleId: string
  pid: number
}
export interface DisplayInfo extends Rect {
  main: boolean
}
export interface WindowSnapshot {
  frontmost: FrontApp | null
  /** Visible, normal-layer windows, front to back. */
  windows: WinInfo[]
  displays: DisplayInfo[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Validate the helper's JSON (treated as untrusted). */
export function parseWindowSnapshot(raw: unknown): WindowSnapshot | null {
  if (!isObj(raw) || !Array.isArray(raw['windows']) || !Array.isArray(raw['displays'])) return null
  let frontmost: FrontApp | null = null
  const f = raw['frontmost']
  if (isObj(f) && num(f['pid']) !== null) frontmost = { name: str(f['name']), bundleId: str(f['bundleId']), pid: f['pid'] as number }
  const windows: WinInfo[] = []
  for (const w of raw['windows'].slice(0, 500)) {
    if (!isObj(w)) continue
    const [x, y, ww, h, id, pid] = [num(w['x']), num(w['y']), num(w['w']), num(w['h']), num(w['id']), num(w['pid'])]
    if (x === null || y === null || ww === null || h === null || id === null || pid === null) continue
    windows.push({ id, owner: str(w['owner']), bundleId: str(w['bundleId']), pid, x, y, w: ww, h })
  }
  const displays: DisplayInfo[] = []
  for (const d of raw['displays'].slice(0, 16)) {
    if (!isObj(d)) continue
    const [x, y, w, h] = [num(d['x']), num(d['y']), num(d['w']), num(d['h'])]
    if (x === null || y === null || w === null || h === null) continue
    displays.push({ x, y, w, h, main: d['main'] === true })
  }
  return { frontmost, windows, displays }
}

export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const norm = (s: string): string => s.trim().toLowerCase()

/** An exclusion entry matches an app's name or bundle id exactly (case-insensitive), or a bundle-id prefix ending in ".". */
export function isExcluded(app: { name: string; bundleId: string }, excludes: readonly string[]): boolean {
  const name = norm(app.name)
  const id = norm(app.bundleId)
  return excludes.some((e) => {
    const x = norm(e)
    if (!x) return false
    if (x === name || (id !== '' && x === id)) return true
    return x.endsWith('.') && id.startsWith(x)
  })
}

export interface CaptureCheck {
  /** Names of excluded apps with a visible window on the display. Empty = fine to capture. */
  blockedBy: string[]
}

/** Which excluded apps would be in the picture if this display were captured now. */
export function checkCapture(snapshot: WindowSnapshot, display: Rect, excludes: readonly string[]): CaptureCheck {
  const blocked = new Set<string>()
  for (const w of snapshot.windows) {
    if (!intersects(w, display)) continue
    if (isExcluded({ name: w.owner, bundleId: w.bundleId }, excludes)) blocked.add(w.owner || w.bundleId)
  }
  return { blockedBy: [...blocked] }
}
