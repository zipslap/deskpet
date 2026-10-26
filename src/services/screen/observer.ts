import type { ObserveRule, ObserveSettings } from '../memory/settings'
import { checkCapture, isExcluded, type Rect } from './rules'
import type { WindowSource } from './windows'

/**
 * Continuous local observation, in the narrowest form that is still useful: every `intervalSeconds` it asks which app is in
 * front (no pixels) and, only if a rule needs it, takes a tiny 48x30 grey thumbnail to measure how much the screen changed.
 * Thumbnails stay in this process, are compared with each other and thrown away; nothing is sent anywhere by this class.
 * It only *reports* that one of the user's rules fired; what happens next (a nudge, or - if allowed - an ask) is the caller's.
 *
 * Off by default, instantly stoppable, never samples while an excluded app is visible, and rate-limited per rule and per hour.
 */
export const GRID_W = 48
export const GRID_H = 30

export interface PixelSampler {
  /** A GRID_W x GRID_H grey thumbnail of the display, or null if it could not be read. */
  sample(bounds: Rect): Promise<Uint8Array | null>
}

/** Fraction of grid cells whose brightness differs by more than `cellDelta` (0..255). */
export function changeFraction(a: Uint8Array, b: Uint8Array, cellDelta = 20): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let changed = 0
  for (let i = 0; i < n; i++) if (Math.abs(a[i]! - b[i]!) > cellDelta) changed++
  return changed / n
}

export type WatchPhase = 'off' | 'watching' | 'paused-excluded' | 'suspended'

export interface ObserveStats {
  ticks: number
  /** Times the window helper was asked (no pixels). */
  windowChecks: number
  /** Tiny local thumbnails taken for change detection (never sent). */
  pixelSamples: number
  /** Ticks skipped because an excluded app was on screen. */
  excludedSkips: number
  /** Rules that fired. */
  triggers: number
  /** Rules that would have fired but hit the per-hour limit. */
  rateLimited: number
  /** "ask" rules turned into nudges because proactive behaviour is off. */
  downgraded: number
}

export interface WatchState {
  phase: WatchPhase
  /** Frontmost app at the last check, or null. */
  app: string | null
  stats: ObserveStats
  lastTrigger: { rule: string; action: 'nudge' | 'ask'; at: number } | null
}

export interface Trigger {
  rule: ObserveRule
  /** What will actually happen: an "ask" rule is a "nudge" unless proactive behaviour is on. */
  action: 'nudge' | 'ask'
  app: string
  /** How much the screen changed since the last look (0 for rules that do not look). */
  change: number
}

export interface ObserverDeps {
  settings: () => { observe: ObserveSettings; excludeApps: string[]; proactive: boolean }
  windows: WindowSource
  sampler: PixelSampler
  displayBounds: () => Rect
  now?: () => number
  onTrigger: (t: Trigger) => void
  onState?: (s: WatchState) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

const emptyStats = (): ObserveStats => ({ ticks: 0, windowChecks: 0, pixelSamples: 0, excludedSkips: 0, triggers: 0, rateLimited: 0, downgraded: 0 })
const key = (a: { name: string; bundleId: string }): string => `${a.bundleId}|${a.name}`.toLowerCase()
const matches = (rule: ObserveRule, app: { name: string; bundleId: string }): boolean => isExcluded(app, [rule.app])

export class ScreenObserver {
  private phase: WatchPhase = 'off'
  private generation = 0
  private timer: unknown = null
  private app: string | null = null
  private lastKey: string | null = null
  private stats = emptyStats()
  private baseline: Uint8Array | null = null
  private readonly fired = new Map<ObserveRule, number>()
  private readonly recent: number[] = []
  private lastTrigger: WatchState['lastTrigger'] = null
  private suspended = false

  constructor(private readonly d: ObserverDeps) {}

  get watching(): boolean {
    return this.phase !== 'off'
  }
  state(): WatchState {
    return { phase: this.phase, app: this.app, stats: { ...this.stats }, lastTrigger: this.lastTrigger ? { ...this.lastTrigger } : null }
  }

  /** Begin watching (the user turned it on). No-op unless observe.enabled. Returns whether it is now watching. */
  start(): boolean {
    if (!this.d.settings().observe.enabled) return false
    if (this.watching) return true
    this.generation++
    this.stats = emptyStats()
    this.phase = this.suspended ? 'suspended' : 'watching'
    this.emit()
    if (!this.suspended) this.schedule(0)
    return true
  }

  /** Stop at once: timer cancelled, anything in flight ignored, memory of the screen dropped. */
  stop(): void {
    this.generation++
    this.cancelTimer()
    this.phase = 'off'
    this.app = null
    this.lastKey = null
    this.baseline = null
    this.emit()
  }

  /** The pet is hidden, the screen is locked, the Mac is asleep: nothing is checked until resumed. */
  suspend(on: boolean): void {
    if (this.suspended === on) return
    this.suspended = on
    if (!this.watching) return
    this.generation++
    this.cancelTimer()
    this.baseline = null
    this.lastKey = null
    this.phase = on ? 'suspended' : 'watching'
    this.emit()
    if (!on) this.schedule(0)
  }

  // ---------- internals ----------
  private schedule(ms: number): void {
    const gen = this.generation
    const set = this.d.setTimer ?? ((fn, t) => setTimeout(fn, t).unref())
    this.cancelTimer()
    this.timer = set(() => void this.tick(gen), ms)
  }
  private cancelTimer(): void {
    if (this.timer !== null) (this.d.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = null
  }
  private emit(): void {
    this.d.onState?.(this.state())
  }

  private async tick(gen: number): Promise<void> {
    const now = (this.d.now ?? Date.now)()
    const cfg = this.d.settings()
    this.stats.ticks++
    try {
      this.stats.windowChecks++
      const snap = await this.d.windows.snapshot()
      if (gen !== this.generation) return
      if (!snap) {
        this.app = null
      } else {
        const bounds = this.d.displayBounds()
        const front = snap.frontmost
        const blocked = checkCapture(snap, bounds, cfg.excludeApps).blockedBy.length > 0 || (front !== null && isExcluded(front, cfg.excludeApps))
        if (blocked) {
          // An excluded app is up: look at nothing, remember nothing, and show only that we are paused.
          this.stats.excludedSkips++
          this.phase = 'paused-excluded'
          this.app = null
          this.lastKey = null
          this.baseline = null
        } else {
          this.phase = 'watching'
          this.app = front?.name || null
          const changedApp = front !== null && key(front) !== this.lastKey
          this.lastKey = front ? key(front) : null
          if (front) await this.evaluate(gen, front, changedApp, now, cfg, bounds)
          if (gen !== this.generation) return
        }
      }
    } catch {
      /* a failed check is just a skipped one */
    }
    if (gen !== this.generation) return
    this.emit()
    this.schedule(cfg.observe.intervalSeconds * 1000)
  }

  private async evaluate(
    gen: number,
    front: { name: string; bundleId: string },
    changedApp: boolean,
    now: number,
    cfg: ReturnType<ObserverDeps['settings']>,
    bounds: Rect
  ): Promise<void> {
    const rules = cfg.observe.rules.filter((r) => matches(r, front))
    if (rules.length === 0) return
    let current: Uint8Array | null | undefined
    for (const rule of rules) {
      const last = this.fired.get(rule)
      if (last !== undefined && now - last < rule.cooldownMinutes * 60_000) continue
      let change = 0
      if (rule.minChange > 0) {
        if (current === undefined) {
          this.stats.pixelSamples++
          current = await this.d.sampler.sample(bounds)
          if (gen !== this.generation) return
        }
        if (!current) continue
        if (!this.baseline) {
          this.baseline = current // the first look is the reference, not a change
          continue
        }
        change = changeFraction(this.baseline, current)
        if (change < rule.minChange) continue
      } else if (!changedApp) continue // a plain rule fires when the app comes to the front, not on every tick while it stays there
      while (this.recent.length > 0 && now - this.recent[0]! > 3_600_000) this.recent.shift()
      if (this.recent.length >= cfg.observe.maxPerHour) {
        this.stats.rateLimited++
        continue
      }
      let action = rule.action
      if (action === 'ask' && !cfg.proactive) {
        action = 'nudge'
        this.stats.downgraded++
      }
      this.fired.set(rule, now)
      this.recent.push(now)
      this.stats.triggers++
      this.lastTrigger = { rule: rule.app, action, at: now }
      if (current) this.baseline = current
      this.d.onTrigger({ rule, action, app: front.name, change })
    }
  }
}
