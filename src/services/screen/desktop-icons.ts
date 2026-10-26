import { execFile } from 'node:child_process'
import type { Box } from '../../shared/perimeter'

/**
 * Where the icons on the desktop are (app shortcuts, files, folders), so the cat can walk around them instead of over them.
 * Asked from Finder with AppleScript (macOS asks once whether DeskPet may control Finder; saying no just means he cannot see
 * the icons). Only positions are read, never names or contents. Cached, because icons rarely move.
 */
const SCRIPT = `tell application "Finder"
  set out to ""
  try
    set sz to icon size of (icon view options of window of desktop)
  on error
    set sz to 64
  end try
  set out to (sz as text) & ";"
  try
    set ps to desktop position of every item of desktop
    repeat with p in ps
      set out to out & (item 1 of p) & "," & (item 2 of p) & ";"
    end repeat
  end try
  return out
end tell`

/** Parse "64;652,78;404,78;" (icon size, then icon centres) into the box each icon and its label take up. */
export function parseIconPositions(text: string): Box[] | null {
  const parts = text.trim().split(';').filter(Boolean)
  const size = Number(parts.shift())
  if (!Number.isFinite(size) || size < 16 || size > 512) return null
  const boxes: Box[] = []
  for (const p of parts.slice(0, 500)) {
    const [x, y] = p.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    // the icon is centred on its position; the name sits under it (up to two lines) and is a little wider than the icon
    const half = size / 2
    boxes.push({ x: x! - half - 14, y: y! - half - 4, w: size + 28, h: size + 40 })
  }
  return boxes
}

export class DesktopIcons {
  private cache: { at: number; boxes: Box[] | null } | null = null
  private pending: Promise<Box[] | null> | null = null
  private denied = false

  constructor(private readonly opts: { ttlMs?: number; onDenied?: () => void } = {}) {}

  /** The icons' boxes, or null if they cannot be read (Finder access refused, or Finder not running). */
  async boxes(): Promise<Box[] | null> {
    if (process.platform !== 'darwin') return null // only macOS (Finder) can say where the desktop icons are
    const ttl = this.opts.ttlMs ?? 15_000
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.boxes
    if (this.denied) return null
    this.pending ??= new Promise<Box[] | null>((resolve) => {
      execFile('/usr/bin/osascript', ['-e', SCRIPT], { timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          if (/-1743|not allowed|Not authorized/i.test(String(stderr))) {
            this.denied = true // asked and refused: never ask again this run
            this.opts.onDenied?.()
          }
          return resolve(null)
        }
        resolve(parseIconPositions(stdout))
      })
    }).then((boxes) => {
      this.cache = { at: Date.now(), boxes }
      this.pending = null
      return boxes
    })
    return this.pending
  }
}
