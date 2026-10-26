/**
 * The pet's explicit state machine. Pure functions only: no Electron, no timers, no randomness except through
 * the injected `rng`. The main-process controller owns the clock and applies the results.
 *
 * State is kept as a few small orthogonal parts instead of one big enum, so that e.g. dragging the pet while a
 * reply is being "spoken" or pausing it mid-conversation cannot lose the conversation state:
 *
 *   loco        what the pet does on its own: idle | walking (along a straight line, which may be diagonal when there is vertical room)
 *   engagement  what the user is doing with it: none | curious | listening | thinking | speaking
 *   asleep, paused, dragging, chatOpen   flags
 *
 * `displayMode` collapses them into the single mode the sprite shows. Nothing here depends on how long a
 * model takes: every transition is triggered by an explicit event and is safe to repeat or to receive late.
 */
import { CAT_ZOOM } from './sprite'

export type Loco = 'idle' | 'walking' | 'eating'
export type Engagement = 'none' | 'curious' | 'listening' | 'thinking' | 'speaking'
export type Mode = 'idle' | 'walking' | 'eating' | 'curious' | 'listening' | 'thinking' | 'speaking' | 'sleeping' | 'paused'
/** Which way he is going on screen: sideways (then `dir` says left or right), down towards you, or up away from you. */
export type Heading = 'side' | 'toward' | 'away'
export type Dir = 1 | -1

export interface PetState {
  loco: Loco
  engagement: Engagement
  asleep: boolean
  paused: boolean
  dragging: boolean
  chatOpen: boolean
  /** A request to the assistant is in flight (from submit until it completes, fails or is cancelled). */
  requestActive: boolean
  /** The reply is being read aloud (text-to-speech is playing). */
  voiceOut: boolean
  dir: Dir
  heading: Heading
  /** Window left edge in DIPs. */
  x: number
  /** Window top edge in DIPs. */
  y: number
  /** Walking home to rest: the spot to reach, then the pet falls asleep there. Null when not heading anywhere. */
  target: { x: number; y: number } | null
  /** A planned walk (around the edges of the windows): waypoints still to visit, in order. Null or empty = free wandering. */
  route: Array<{ x: number; y: number }> | null
  /** While walking: vertical speed as a fraction of the walking speed, signed (+ = down the screen). 0 = straight along x. */
  slope: number
  /** Time left in the current timed segment (idle wait, walk, or curious-without-chat). */
  remainingMs: number
}

export interface XRange {
  minX: number
  maxX: number
  /** Vertical room for the window's top edge. Absent or (nearly) equal = no vertical room: the pet walks along x only (the Dock-edge mode). */
  minY?: number
  maxY?: number
}
/** Steepest wander, as a fraction of walking speed: about 37 degrees, so it always reads as walking sideways, never as crab-walking up the screen. */
export const MAX_SLOPE = 0.75
const hasRoomY = (r: XRange): boolean => r.minY !== undefined && r.maxY !== undefined && r.maxY - r.minY > 8
export type Rng = () => number

/** Walking speed in DIPs per second (40 for the original 160 px cat, scaled with his size). */
export const WALK_SPEED = 40 * CAT_ZOOM
/** A single walking step never covers more than this, so a stalled timer can't teleport the pet. */
export const MAX_STEP_MS = 100
/** How long the pet stays curious after being woken when no chat panel is open. */
export const CURIOUS_MS = 2500

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))
const between = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo)

export function initialState(x: number, range: XRange, rng: Rng, y?: number): PetState {
  return {
    loco: 'idle',
    engagement: 'none',
    asleep: false,
    paused: false,
    dragging: false,
    chatOpen: false,
    requestActive: false,
    voiceOut: false,
    dir: rng() < 0.5 ? 1 : -1,
    heading: 'side',
    x: clamp(x, range.minX, range.maxX),
    y: clampY(y ?? range.maxY ?? 0, range),
    slope: 0,
    target: null,
    route: null,
    remainingMs: between(rng, 1500, 4000)
  }
}

const clampY = (y: number, r: XRange): number => (r.minY !== undefined && r.maxY !== undefined ? clamp(y, r.minY, r.maxY) : y)

/** The one mode the sprite should show. Engagement beats sleep, sleep beats pause, pause beats locomotion. */
export function displayMode(s: PetState): Mode {
  if (s.engagement !== 'none') return s.engagement
  if (s.asleep) return 'sleeping'
  if (s.paused) return 'paused'
  return s.loco
}

/** What timer the controller needs next: a 30 Hz walk tick, a one-shot wait, or nothing at all. */
export type Wake = { kind: 'walk' } | { kind: 'wait'; ms: number } | { kind: 'none' }
export function nextWake(s: PetState): Wake {
  if (s.dragging || s.asleep) return { kind: 'none' }
  if (s.engagement === 'curious' && !s.chatOpen) return { kind: 'wait', ms: Math.max(s.remainingMs, 0) }
  if (s.engagement !== 'none' || s.paused) return { kind: 'none' }
  return s.loco === 'walking' ? { kind: 'walk' } : { kind: 'wait', ms: Math.max(s.remainingMs, 0) } // idle or eating: a one-shot wait
}

/** Advance the clock. Only locomotion and the curious-timeout are time-driven. */
export function advance(s: PetState, dtMs: number, range: XRange, rng: Rng): PetState {
  if (s.dragging || s.asleep) return s

  if (s.engagement === 'curious' && !s.chatOpen) {
    const remainingMs = s.remainingMs - dtMs
    if (remainingMs > 0) return { ...s, remainingMs }
    return { ...s, engagement: 'none', loco: s.target ? 'walking' : 'idle', remainingMs: 1500 }
  }
  if (s.engagement !== 'none' || s.paused) return s

  if (s.loco === 'eating') {
    const remainingMs = s.remainingMs - dtMs
    return remainingMs > 0 ? { ...s, remainingMs } : { ...s, loco: 'idle', heading: 'side', remainingMs: between(rng, 1500, 3500) }
  }

  const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS)
  const x = clamp(s.x, range.minX, range.maxX)

  if (s.target) {
    // heading home in a straight line (any angle) at the walking speed, then lie down there
    const tx = clamp(s.target.x, range.minX, range.maxX)
    const y0 = clampY(s.y, range)
    const ty = clampY(s.target.y, range)
    const dx = tx - x
    const dy = ty - y0
    const dist = Math.hypot(dx, dy)
    const step = WALK_SPEED * (dt / 1000)
    if (dist <= step + 0.5) return { ...s, x: tx, y: ty, target: null, loco: 'idle', slope: 0, asleep: true, remainingMs: 3000 }
    const dir: Dir = Math.abs(dx) < 0.5 ? s.dir : dx > 0 ? 1 : -1
    return { ...s, loco: 'walking', dir, x: x + (dx / dist) * step, y: y0 + (dy / dist) * step, slope: 0 }
  }

  if (s.route && s.route.length > 0 && s.loco === 'walking') {
    // a planned walk: straight from waypoint to waypoint at the walking speed, then a rest before the next one
    let x0 = x
    let y0 = clampY(s.y, range)
    let left = WALK_SPEED * (dt / 1000)
    const route = [...s.route]
    let dir = s.dir
    let heading = s.heading
    while (route.length > 0) {
      const tx = clamp(route[0]!.x, range.minX, range.maxX)
      const ty = clampY(route[0]!.y, range)
      const d = Math.hypot(tx - x0, ty - y0)
      if (Math.abs(tx - x0) > 0.5) dir = tx > x0 ? 1 : -1
      // mostly up or down the screen: he turns to face you (down) or shows his back (up), so the direction reads
      if (d > 0.5) heading = Math.abs(ty - y0) > 1.5 * Math.abs(tx - x0) ? (ty > y0 ? 'toward' : 'away') : 'side'
      if (d > left) {
        x0 += ((tx - x0) / d) * left
        y0 += ((ty - y0) / d) * left
        return { ...s, dir, heading, x: x0, y: y0, route, slope: 0 }
      }
      left -= d
      x0 = tx
      y0 = ty
      route.shift()
    }
    return { ...s, dir, heading: 'side', x: x0, y: y0, route: null, loco: 'idle', slope: 0, remainingMs: between(rng, 2500, 8000) }
  }

  if (s.loco === 'idle') {
    const remainingMs = s.remainingMs - dtMs // idle waits are one-shot sleeps, not capped
    if (remainingMs > 0) return { ...s, x, remainingMs }
    const dir: Dir = x <= range.minX ? 1 : x >= range.maxX ? -1 : rng() < 0.5 ? 1 : -1
    const y = clampY(s.y, range)
    // with vertical room each walk heads off at its own angle (a different slope every time), so the pet wanders the whole surface
    const slope = hasRoomY(range) ? (rng() * 2 - 1) * MAX_SLOPE : 0
    return { ...s, loco: 'walking', dir, x, y, slope, remainingMs: between(rng, 2500, 7000) }
  }

  // speed along the heading: x gets cos, y gets sin, so the pet always moves at WALK_SPEED however steep the walk
  const norm = Math.sqrt(1 + s.slope * s.slope)
  let nx = x + s.dir * (WALK_SPEED / norm) * (dt / 1000)
  let ny = clampY(s.y, range) + s.slope * (WALK_SPEED / norm) * (dt / 1000)
  let slope = s.slope
  if (hasRoomY(range)) {
    if (ny <= range.minY!) {
      ny = range.minY!
      slope = Math.abs(slope)
    } else if (ny >= range.maxY!) {
      ny = range.maxY!
      slope = -Math.abs(slope)
    }
  }
  let dir = s.dir
  if (nx <= range.minX) {
    nx = range.minX
    dir = 1
  } else if (nx >= range.maxX) {
    nx = range.maxX
    dir = -1
  }
  const remainingMs = s.remainingMs - dt
  if (remainingMs <= 0) return { ...s, loco: 'idle', dir, x: nx, y: ny, slope: 0, remainingMs: between(rng, 3000, 9000) }
  return { ...s, dir, x: nx, y: ny, slope, remainingMs }
}

// ---------- events ----------

/** Set off on a planned walk (shared/perimeter.ts). Only a pet that is free to wander takes it; an empty route is ignored. */
export const startRoute = (s: PetState, route: Array<{ x: number; y: number }>): PetState =>
  route.length === 0 || s.asleep || s.paused || s.dragging || s.chatOpen || s.target || s.engagement !== 'none'
    ? s
    : { ...s, route: route.map((p) => ({ ...p })), loco: 'walking', slope: 0 }
/** He has reached a fish: eat it for `ms`, facing `dir`. Only a pet that is free to wander does; anything else wins over it. */
export const startEating = (s: PetState, ms: number, dir: Dir = s.dir): PetState =>
  s.asleep || s.paused || s.dragging || s.chatOpen || s.target || s.engagement !== 'none'
    ? s
    : { ...s, loco: 'eating', route: null, dir, heading: 'side', slope: 0, remainingMs: Math.max(ms, 0) }
/** Stop a planned walk where he is (the spot he was heading for got covered): stand still briefly, then plan again. */
export const dropRoute = (s: PetState, restMs = 400): PetState =>
  s.route ? { ...s, route: null, loco: s.target ? s.loco : 'idle', remainingMs: s.target ? s.remainingMs : restMs } : s

export const pause = (s: PetState): PetState => (s.paused ? s : { ...s, paused: true, loco: 'idle', route: null })
export const resume = (s: PetState): PetState => (s.paused ? { ...s, paused: false, loco: 'idle', remainingMs: 1500 } : s)

/** Dragging is always allowed (also while paused, asleep or mid-conversation). It wakes a sleeping pet. */
export const dragStart = (s: PetState): PetState => (s.dragging ? s : { ...s, dragging: true, asleep: false, target: null, route: null })
export const dragEnd = (s: PetState, x: number, range: XRange, y?: number): PetState =>
  s.dragging ? { ...s, dragging: false, loco: 'idle', slope: 0, x: clamp(x, range.minX, range.maxX), y: clampY(y ?? s.y, range), remainingMs: 2000 } : s

export const chatOpened = (s: PetState): PetState => ({
  ...s,
  chatOpen: true,
  asleep: false,
  target: null,
  route: null,
  engagement: s.engagement === 'none' ? 'curious' : s.engagement
})
/** Closing the panel ends any engagement. The caller is responsible for cancelling a request and stopping speech. */
export const chatClosed = (s: PetState): PetState =>
  s.chatOpen || s.engagement !== 'none' || s.requestActive || s.voiceOut
    ? { ...s, chatOpen: false, engagement: 'none', requestActive: false, voiceOut: false, loco: 'idle', route: null, remainingMs: 1500 }
    : s

/** The user sent a message. Ignored unless the panel is open. Anything still being read aloud has been stopped. */
export const submitted = (s: PetState): PetState =>
  s.chatOpen ? { ...s, engagement: 'thinking', requestActive: true, voiceOut: false } : s
/** First text arrived. Ignored unless we are actually waiting (a late chunk after cancel changes nothing). */
export const responseStarted = (s: PetState): PetState => (s.engagement === 'thinking' ? { ...s, engagement: 'speaking' } : s)
/**
 * Completed, cancelled or failed. Back to attentive, unless the reply is still being read aloud: then the pet keeps
 * "speaking" until the voice finishes. Repeating it is harmless.
 */
export const requestEnded = (s: PetState): PetState => {
  const ended = { ...s, requestActive: false }
  if (s.engagement === 'speaking' && s.voiceOut) return ended
  if (s.engagement === 'thinking' || s.engagement === 'speaking') return { ...ended, engagement: s.chatOpen ? 'curious' : 'none' }
  return s.requestActive ? ended : s
}

/** Text-to-speech began playing. Only meaningful while the panel is open. */
export const speechStarted = (s: PetState): PetState =>
  !s.chatOpen ? s : { ...s, voiceOut: true, engagement: s.engagement === 'none' || s.engagement === 'curious' ? 'speaking' : s.engagement }
/** Text-to-speech finished or was stopped. If the request is also over, the pet settles. */
export const speechEnded = (s: PetState): PetState => {
  if (!s.voiceOut) return s
  const e = { ...s, voiceOut: false }
  return s.engagement === 'speaking' && !s.requestActive ? { ...e, engagement: s.chatOpen ? 'curious' : 'none' } : e
}

/** The microphone is open (push-to-talk). Not possible while a request or speech is in progress. */
export const voiceStarted = (s: PetState): PetState =>
  s.chatOpen && (s.engagement === 'none' || s.engagement === 'curious') ? { ...s, engagement: 'listening' } : s
export const voiceEnded = (s: PetState): PetState => (s.engagement === 'listening' ? { ...s, engagement: 'curious' } : s)

/** Only an unengaged, undisturbed pet falls asleep. */
export const fellAsleep = (s: PetState): PetState =>
  s.engagement === 'none' && !s.dragging && !s.chatOpen && !s.asleep ? { ...s, asleep: true } : s
/** Poke: wake up and look around for a moment. */
export const woke = (s: PetState): PetState =>
  s.asleep ? { ...s, asleep: false, engagement: 'curious', remainingMs: CURIOUS_MS } : s

/**
 * Time to go and rest at `home`. Only for a pet that is idle and awake (not in a conversation, being dragged, listening or
 * speaking); a sleeping pet is already resting wherever it is, and a pet that is not at home gets there first. Overrides "paused".
 */
export const goHome = (s: PetState, home: { x: number; y: number }): PetState =>
  s.asleep || s.dragging || s.chatOpen || s.engagement !== 'none' ? s : { ...s, paused: false, target: { ...home }, route: null, loco: 'walking' }

/**
 * Something wants attention (a nudge, a reaction to the app you just opened): perk up for `ms`, even from sleep. It never
 * interrupts a conversation or a drag, and a pet that is paused or hidden stays as it is: this is cosmetic only.
 */
export const alerted = (s: PetState, ms: number): PetState =>
  s.engagement !== 'none' || s.dragging || s.paused || s.chatOpen ? s : { ...s, asleep: false, engagement: 'curious', route: null, remainingMs: Math.max(ms, 0) }
