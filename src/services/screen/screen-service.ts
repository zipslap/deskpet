import type { ScreenSettings } from '../memory/settings'
import { checkCapture, type Rect } from './rules'
import type { WindowSource } from './windows'

/** What was captured. Lives in memory only: it is handed to the request and then dropped; nothing here is ever written to disk. */
export interface ScreenImage {
  base64: string
  mime: 'image/jpeg'
  width: number
  height: number
  /** A small preview shown in the chat so the user can see exactly what was sent. */
  thumbDataUrl: string
}

export type ScreenFix = 'screen' | null
export type ScreenResult =
  | { ok: true; image: ScreenImage; description: string }
  | { ok: false; message: string; fix: ScreenFix }

export interface Capturer {
  /** Grab the display at `bounds`. The caller has already checked that nothing excluded is on it. */
  capture(bounds: Rect, maxEdge: number): Promise<ScreenImage | 'denied' | 'empty'>
}

export interface ScreenDeps {
  settings: () => ScreenSettings
  windows: WindowSource
  capturer: Capturer
  /** The display to capture: where the pet is (or the main display). */
  displayBounds: (which: ScreenSettings['display']) => Rect
  /** Make the app's own windows invisible for the instant of capture; returns the function that brings them back. */
  hideOwnWindows: () => Promise<() => void>
  /** Electron's own view of the Screen Recording permission. */
  permission: () => 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  /** Pids belonging to this app, ignored when deciding what is on screen. */
  ownPids?: () => number[]
  /** What to tell the user when the windows on screen cannot be listed (differs by OS). */
  windowCheckHelp?: string
}

const PERMISSION_HELP =
  'Screen Recording is off for the app that launched the pet. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen the pet and try again.'

/**
 * "Look at my screen", on request only. Order matters: switch-off check, permission, exclusion check (before any pixel is
 * read), capture with the pet's own windows hidden, and the image returned to the caller in memory.
 */
export class ScreenService {
  private busy = false

  constructor(private readonly d: ScreenDeps) {}

  get enabled(): boolean {
    return this.d.settings().enabled
  }

  async captureForRequest(): Promise<ScreenResult> {
    const s = this.d.settings()
    if (!s.enabled) return { ok: false, message: 'Screen access is switched off (screen.enabled in settings.json).', fix: null }
    if (this.busy) return { ok: false, message: 'Already looking at the screen. One moment.', fix: null }
    this.busy = true
    try {
      const perm = this.d.permission()
      if (perm === 'denied' || perm === 'restricted') return { ok: false, message: PERMISSION_HELP, fix: 'screen' }

      const bounds = this.d.displayBounds(s.display)
      const snap = await this.d.windows.snapshot()
      if (snap) {
        const own = new Set(this.d.ownPids?.() ?? [])
        const visible = { ...snap, windows: snap.windows.filter((w) => !own.has(w.pid)) }
        const { blockedBy } = checkCapture(visible, bounds, s.excludeApps)
        if (blockedBy.length > 0) {
          return {
            ok: false,
            message: `Not captured: ${blockedBy.join(', ')} ${blockedBy.length === 1 ? 'is' : 'are'} on your exclusion list and visible on that display. Close or move ${blockedBy.length === 1 ? 'it' : 'them'} and ask again.`,
            fix: null
          }
        }
      } else if (s.excludeApps.length > 0 && !s.allowUnchecked) {
        // Cannot tell what is on screen, so the exclusion list cannot be honoured: do not capture (unless the user accepted that).
        return { ok: false, message: this.d.windowCheckHelp ?? "Not captured: I couldn't check which apps are on screen (the window helper isn't available), so I can't honour your exclusion list. Run `npm run helper`.", fix: null }
      }

      const restore = await this.d.hideOwnWindows()
      let got: Awaited<ReturnType<Capturer['capture']>>
      try {
        got = await this.d.capturer.capture(bounds, s.maxEdge)
      } finally {
        restore()
      }
      if (got === 'denied') return { ok: false, message: PERMISSION_HELP, fix: 'screen' }
      if (got === 'empty') return { ok: false, message: 'The screen capture came back empty. If you just allowed Screen Recording, quit and reopen the pet.', fix: 'screen' }
      const front = snap?.frontmost?.name
      return {
        ok: true,
        image: got,
        description: `Looked at ${s.display === 'pet' ? 'the display the pet is on' : 'the main display'}${front ? ` (frontmost app: ${front})` : ''}.`
      }
    } finally {
      this.busy = false
    }
  }
}
