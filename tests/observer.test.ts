import { describe, expect, it } from 'vitest'
import { changeFraction, GRID_H, GRID_W, ScreenObserver, type ObserverDeps, type Trigger, type WatchState } from '../src/services/screen/observer'
import type { ObserveRule } from '../src/services/memory/settings'
import type { WindowSnapshot } from '../src/services/screen/rules'

const DISPLAY = { x: 0, y: 0, w: 1710, h: 1112 }
const snapOf = (front: string | null, extra: Array<{ owner: string; bundleId?: string }> = []): WindowSnapshot => ({
  frontmost: front ? { name: front, bundleId: `com.test.${front.toLowerCase()}`, pid: 1 } : null,
  windows: [...(front ? [{ id: 1, owner: front, bundleId: `com.test.${front.toLowerCase()}`, pid: 1, x: 10, y: 10, w: 500, h: 400 }] : []), ...extra.map((e, i) => ({ id: 10 + i, owner: e.owner, bundleId: e.bundleId ?? '', pid: 50 + i, x: 100, y: 100, w: 300, h: 300 }))],
  displays: [{ ...DISPLAY, main: true }]
})
const grid = (v: number): Uint8Array => new Uint8Array(GRID_W * GRID_H).fill(v)
const rule = (over: Partial<ObserveRule> = {}): ObserveRule => ({ app: 'Mail', action: 'nudge', minChange: 0, cooldownMinutes: 10, prompt: 'p', ...over })

function make(opts: { rules?: ObserveRule[]; enabled?: boolean; proactive?: boolean; maxPerHour?: number; exclude?: string[] } = {}) {
  let t = 1_000_000
  let snapshot: WindowSnapshot | null = snapOf('Notes')
  let pixels: Uint8Array | null = grid(100)
  const calls = { windows: 0, samples: 0 }
  const triggers: Trigger[] = []
  const states: WatchState[] = []
  let pending: (() => void) | null = null
  let timers = 0
  const deps: ObserverDeps = {
    settings: () => ({ observe: { enabled: opts.enabled ?? true, intervalSeconds: 20, maxPerHour: opts.maxPerHour ?? 6, rules: opts.rules ?? [] }, excludeApps: opts.exclude ?? ['1Password'], proactive: opts.proactive ?? false }),
    windows: { snapshot: async () => (calls.windows++, snapshot), screenCaptureGranted: async () => true },
    sampler: { sample: async () => (calls.samples++, pixels) },
    displayBounds: () => DISPLAY,
    now: () => t,
    onTrigger: (x) => void triggers.push(x),
    onState: (s) => void states.push(s),
    setTimer: (fn) => ((pending = fn), ++timers),
    clearTimer: () => void (pending = null)
  }
  const obs = new ScreenObserver(deps)
  /** Run the next scheduled tick to completion, then advance the clock by the interval. */
  const tick = async (advanceMs = 20_000): Promise<void> => {
    const fn = pending
    pending = null
    fn?.()
    await new Promise((r) => setImmediate(r))
    t += advanceMs
  }
  return {
    obs, calls, triggers, states, tick,
    setFront: (s: WindowSnapshot | null) => (snapshot = s),
    setPixels: (p: Uint8Array | null) => (pixels = p),
    hasTimer: () => pending !== null,
    advance: (ms: number) => (t += ms)
  }
}

describe('changeFraction', () => {
  it('is 0 for identical pictures and 1 for entirely different ones', () => {
    expect(changeFraction(grid(100), grid(100))).toBe(0)
    expect(changeFraction(grid(0), grid(255))).toBe(1)
  })
  it('ignores small brightness drift and counts big changes cell by cell', () => {
    const b = grid(100)
    for (let i = 0; i < 300; i++) b[i] = 200 // 300 of 1440 cells
    expect(changeFraction(grid(100), b)).toBeCloseTo(300 / 1440, 5)
    expect(changeFraction(grid(100), grid(110))).toBe(0)
  })
  it('handles empty input', () => expect(changeFraction(new Uint8Array(0), new Uint8Array(0))).toBe(0))
})

describe('ScreenObserver: lifecycle', () => {
  it('does not start unless observe.enabled is true', async () => {
    const m = make({ enabled: false })
    expect(m.obs.start()).toBe(false)
    expect(m.obs.watching).toBe(false)
    expect(m.hasTimer()).toBe(false)
    expect(m.calls.windows).toBe(0)
  })
  it('watching asks which app is in front and reads no pixels when no rule needs them', async () => {
    const m = make({ rules: [rule({ app: 'Mail' })] })
    expect(m.obs.start()).toBe(true)
    await m.tick()
    await m.tick()
    expect(m.calls.windows).toBe(2)
    expect(m.calls.samples).toBe(0)
    expect(m.obs.state()).toMatchObject({ phase: 'watching', app: 'Notes' })
    expect(m.obs.state().stats.pixelSamples).toBe(0)
  })
  it('stop() is instant: no more timers, in-flight results ignored, state cleared', async () => {
    const m = make({ rules: [rule()] })
    m.obs.start()
    m.setFront(snapOf('Mail'))
    const p = m.tick()
    m.obs.stop() // while the check is in flight
    await p
    expect(m.triggers).toEqual([])
    expect(m.hasTimer()).toBe(false)
    expect(m.obs.state()).toMatchObject({ phase: 'off', app: null })
  })
  it('can be restarted and begins with fresh counters', async () => {
    const m = make()
    m.obs.start()
    await m.tick()
    m.obs.stop()
    m.obs.start()
    expect(m.obs.state().stats.ticks).toBe(0)
  })
  it('suspend pauses everything until resumed, and resume checks again at once', async () => {
    const m = make()
    m.obs.start()
    await m.tick()
    const before = m.calls.windows
    m.obs.suspend(true)
    expect(m.obs.state().phase).toBe('suspended')
    expect(m.hasTimer()).toBe(false)
    expect(m.calls.windows).toBe(before)
    m.obs.suspend(false)
    expect(m.hasTimer()).toBe(true)
    await m.tick()
    expect(m.calls.windows).toBe(before + 1)
    expect(m.obs.state().phase).toBe('watching')
  })
})

describe('ScreenObserver: rules', () => {
  it('a plain rule fires when its app comes to the front, once, not on every tick while it stays', async () => {
    const m = make({ rules: [rule({ app: 'Mail' })] })
    m.obs.start()
    await m.tick()
    expect(m.triggers).toHaveLength(0)
    m.setFront(snapOf('Mail'))
    await m.tick()
    await m.tick()
    await m.tick()
    expect(m.triggers).toHaveLength(1)
    expect(m.triggers[0]).toMatchObject({ app: 'Mail', action: 'nudge', change: 0 })
  })
  it('matches by bundle id too, case-insensitively', async () => {
    const m = make({ rules: [rule({ app: 'COM.TEST.MAIL' })] })
    m.obs.start()
    m.setFront(snapOf('Mail'))
    await m.tick()
    expect(m.triggers).toHaveLength(1)
  })
  it('respects the cooldown, then fires again when the app returns', async () => {
    const m = make({ rules: [rule({ cooldownMinutes: 10 })] })
    m.obs.start()
    for (let i = 0; i < 3; i++) {
      m.setFront(snapOf('Mail'))
      await m.tick(60_000)
      m.setFront(snapOf('Notes'))
      await m.tick(60_000)
    }
    expect(m.triggers).toHaveLength(1) // 3 visits within 6 minutes
    m.advance(11 * 60_000)
    m.setFront(snapOf('Mail'))
    await m.tick()
    expect(m.triggers).toHaveLength(2)
  })
  it('a change rule samples only while its app is in front, treats the first look as the reference, then fires on a big change', async () => {
    const m = make({ rules: [rule({ minChange: 0.2 })] })
    m.obs.start()
    await m.tick() // Notes in front: no sampling
    expect(m.calls.samples).toBe(0)
    m.setFront(snapOf('Mail'))
    await m.tick() // first look: reference only
    expect(m.calls.samples).toBe(1)
    expect(m.triggers).toHaveLength(0)
    const changed = grid(100)
    for (let i = 0; i < 500; i++) changed[i] = 250
    m.setPixels(changed)
    await m.tick()
    expect(m.triggers).toHaveLength(1)
    expect(m.triggers[0]!.change).toBeGreaterThan(0.3)
  })
  it('a small change does not fire a change rule', async () => {
    const m = make({ rules: [rule({ minChange: 0.5 })] })
    m.obs.start()
    m.setFront(snapOf('Mail'))
    await m.tick()
    const small = grid(100)
    for (let i = 0; i < 100; i++) small[i] = 250
    m.setPixels(small)
    await m.tick()
    await m.tick()
    expect(m.triggers).toHaveLength(0)
  })
  it('an unreadable thumbnail is skipped quietly', async () => {
    const m = make({ rules: [rule({ minChange: 0.2 })] })
    m.obs.start()
    m.setFront(snapOf('Mail'))
    m.setPixels(null)
    await m.tick()
    await m.tick()
    expect(m.triggers).toHaveLength(0)
    expect(m.obs.watching).toBe(true)
  })
  it('never fires more than maxPerHour times in an hour, and counts what it held back', async () => {
    const m = make({ rules: [rule({ cooldownMinutes: 1 })], maxPerHour: 2 })
    m.obs.start()
    for (let i = 0; i < 5; i++) {
      m.setFront(snapOf('Mail'))
      await m.tick(2 * 60_000)
      m.setFront(snapOf('Notes'))
      await m.tick(2 * 60_000)
    }
    expect(m.triggers).toHaveLength(2)
    expect(m.obs.state().stats.rateLimited).toBeGreaterThan(0)
    m.advance(61 * 60_000)
    m.setFront(snapOf('Mail'))
    await m.tick()
    expect(m.triggers).toHaveLength(3)
  })
  it('an "ask" rule is only a nudge unless proactive behaviour is on', async () => {
    const off = make({ rules: [rule({ action: 'ask' })], proactive: false })
    off.obs.start()
    off.setFront(snapOf('Mail'))
    await off.tick()
    expect(off.triggers[0]!.action).toBe('nudge')
    expect(off.obs.state().stats.downgraded).toBe(1)
    const on = make({ rules: [rule({ action: 'ask' })], proactive: true })
    on.obs.start()
    on.setFront(snapOf('Mail'))
    await on.tick()
    expect(on.triggers[0]!.action).toBe('ask')
  })
})

describe('ScreenObserver: exclusions', () => {
  it('while an excluded app is on screen nothing is looked at and nothing fires', async () => {
    const m = make({ rules: [rule({ app: 'Mail', minChange: 0.2 })] })
    m.obs.start()
    m.setFront(snapOf('Mail', [{ owner: '1Password' }]))
    await m.tick()
    await m.tick()
    expect(m.calls.samples).toBe(0)
    expect(m.triggers).toHaveLength(0)
    expect(m.obs.state()).toMatchObject({ phase: 'paused-excluded', app: null })
    expect(m.obs.state().stats.excludedSkips).toBe(2)
  })
  it('an excluded frontmost app pauses it even with no visible window reported', async () => {
    const m = make({ rules: [rule({ app: 'Mail' })] })
    m.obs.start()
    m.setFront({ ...snapOf('Notes'), frontmost: { name: '1Password', bundleId: '', pid: 9 } })
    await m.tick()
    expect(m.obs.state().phase).toBe('paused-excluded')
  })
  it('forgets the previous picture so returning from an excluded app is not a "change"', async () => {
    const m = make({ rules: [rule({ app: 'Mail', minChange: 0.2 })] })
    m.obs.start()
    m.setFront(snapOf('Mail'))
    await m.tick() // reference taken
    m.setFront(snapOf('Mail', [{ owner: '1Password' }]))
    await m.tick()
    m.setFront(snapOf('Mail'))
    m.setPixels(grid(250))
    await m.tick() // would be a 100% change against the old reference; it is a new reference instead
    expect(m.triggers).toHaveLength(0)
    expect(m.obs.state().phase).toBe('watching')
  })
  it('a failed window check does not crash the loop', async () => {
    const m = make({ rules: [rule()] })
    m.obs.start()
    m.setFront(null)
    await m.tick()
    expect(m.obs.state().phase).toBe('watching')
    expect(m.hasTimer()).toBe(true)
  })
})
