import { type BrowserWindow, screen, type Rectangle } from 'electron'
import {
  advance,
  chatClosed,
  chatOpened,
  alerted,
  clamp,
  displayMode,
  dragEnd,
  dragStart,
  dropRoute,
  startEating,
  fellAsleep,
  goHome,
  initialState,
  nextWake,
  pause,
  requestEnded,
  responseStarted,
  resume,
  speechEnded,
  speechStarted,
  startRoute,
  submitted,
  voiceEnded,
  voiceStarted,
  woke,
  type PetState,
  type XRange
} from '../shared/brain'
import { Channels, type PetStateMessage } from '../shared/ipc'
import { BODY, boxOverlaps, eatSpotFor, pickFishSpot, planEdgeWalk, visibleAt, type Box, type EdgeWorld } from '../shared/perimeter'
import { CAT_ZOOM, GROUND_MARGIN, WINDOW_SIZE } from '../shared/sprite'

/** Where he may roam: around the edges of the open windows (default), anywhere on the desktop, or only along the bottom edge. */
export type RoamMode = 'edges' | 'desktop' | 'dock'
/** While walking around the edges, how often to check that where he is heading has not been covered by a window. */
const EDGE_CHECK_MS = 1500
/** Nothing bare to walk on (a window fills the screen): look again after this long. */
const EDGE_RETRY_MS = 4000
/** How long he spends on a fish, and when (into that) it is gone. */
const EAT_MS = 2800
const FISH_GONE_MS = 1600

const WALK_TICK_MS = 33
/** How often the cursor is checked against the pet window (a cheap rectangle test; the renderer is only asked while it is inside). */
const POINTER_TICK_MS = 50
const FALL_TICK_MS = 16
const FALL_MS = 320

const debug = process.env['PET_DEBUG'] === '1'

export interface ControllerOptions {
  rng?: () => number
  /** Inactivity before the pet falls asleep. */
  sleepAfterMs: number
  /** Called whenever the window moves, so anything anchored to the pet (the chat panel) can follow. */
  onMoved?: (bounds: Rectangle) => void
  /** Where the pet may wander (asked every time, so the menu can change it while running). */
  roam?: () => RoamMode
  /** The other apps' visible windows (for walking around their edges), or null if they could not be read. */
  windows?: () => Promise<Box[] | null>
  /** The desktop icons, which he walks around and never over (null if they cannot be read). */
  obstacles?: () => Promise<Box[] | null>
  /** Fish lying on the desktop for him to go and eat, and what to do when one has been eaten. */
  food?: { list(): Array<{ id: number; box: Box }>; eaten(id: number): void }
  /** Rest at home when not in use (asked every time). */
  rest?: () => boolean
  /** His saved home (window top-left), if any. */
  home?: () => { x: number; y: number } | null
  /** He was dragged while resting: this is his new home. */
  onHomeChanged?: (home: { x: number; y: number }) => void
}

/**
 * Owns the pet window's position and the clock behind the state machine in shared/brain.ts.
 * Timers only run when there is something to do: walking ticks at ~30 Hz; every other state uses at most one
 * one-shot timer; paused, hidden, asleep, dragging and conversation states use none (except the sleep timer).
 */
export class PetController {
  private state: PetState
  private hidden = false
  private walkTimer: NodeJS.Timeout | null = null
  private waitTimer: NodeJS.Timeout | null = null
  private fallTimer: NodeJS.Timeout | null = null
  private sleepTimer: NodeJS.Timeout | null = null
  private pointerTimer: NodeJS.Timeout | null = null
  private hovered = false
  private lastPointer = ''
  private lastTick = 0
  private lastPublished = ''
  private homePos: { x: number; y: number }
  private wasResting = false
  private drag: { cursor: { x: number; y: number }; origin: Rectangle } | null = null
  /** An edge walk is being planned / checked (the window list is read asynchronously). */
  private planning = false
  private lastEdgeCheck = 0
  /** The fish he is walking to (and which way to face when he gets there). */
  private goingFor: { id: number; dir: 1 | -1 } | null = null
  private readonly rng: () => number

  constructor(
    private readonly win: BrowserWindow,
    private readonly opts: ControllerOptions
  ) {
    this.rng = opts.rng ?? Math.random
    const wa = screen.getPrimaryDisplay().workArea
    this.homePos = opts.home?.() ?? { x: wa.x + wa.width - WINDOW_SIZE - 80, y: this.groundY(wa) }
    this.state = initialState(this.homePos.x, this.rangeFor(wa), this.rng, this.homePos.y)
    this.place(this.state.x, this.state.y)

    screen.on('display-metrics-changed', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
    screen.on('display-added', this.onDisplayChange)
  }

  // ---------- read-only views ----------
  get isPaused(): boolean {
    return this.state.paused
  }
  get isHidden(): boolean {
    return this.hidden
  }
  /** Asleep (at home, if he rests at home): costs no timer and almost no drawing. */
  get isResting(): boolean {
    return this.state.asleep
  }
  get home(): { x: number; y: number } {
    return { ...this.homePos }
  }
  get isChatOpen(): boolean {
    return this.state.chatOpen
  }
  getBounds(): Rectangle {
    return this.win.getBounds()
  }

  // ---------- lifecycle ----------
  start(): void {
    // A pet that rests at home starts the day asleep there, like an app waiting to be opened.
    if (this.restMode()) this.state = { ...this.state, asleep: true, x: this.homePos.x, y: this.homePos.y }
    this.win.showInactive()
    this.place(this.state.x, this.state.y) // AppKit nudges a freshly shown window; put it back
    this.publish()
    this.schedule()
    this.armSleep()
    this.pointerTimer = setInterval(this.pollPointer, POINTER_TICK_MS)
  }

  dispose(): void {
    this.clearTimers()
    if (this.pointerTimer) clearInterval(this.pointerTimer)
    this.pointerTimer = null
    screen.off('display-metrics-changed', this.onDisplayChange)
    screen.off('display-removed', this.onDisplayChange)
    screen.off('display-added', this.onDisplayChange)
  }

  // ---------- events (each one is a pure transition in shared/brain.ts) ----------
  /** `touch` = counts as user activity and postpones sleep. */
  private apply(fn: (s: PetState) => PetState, touch = true): void {
    this.state = fn(this.state)
    this.publish()
    this.schedule()
    if (touch) this.armSleep()
  }

  togglePause(): void {
    this.apply((s) => (s.paused ? resume(s) : pause(s)))
  }
  chatOpened(): void {
    this.apply(chatOpened)
  }
  chatClosed(): void {
    this.apply(chatClosed)
  }
  /** Perk up for a moment (a nudge, a reaction). Cosmetic: ignored while the chat is open, paused, dragged or hidden. */
  alert(ms = 6000): void {
    if (this.hidden) return
    this.apply((s) => alerted(s, ms), false) // does not count as user activity
    if (this.restMode()) this.armSleep(ms + 20_000) // a nudge that goes unanswered: back to rest soon after
  }
  chatSubmitted(): void {
    this.apply(submitted)
  }
  chatStarted(): void {
    this.apply(responseStarted)
  }
  chatEnded(): void {
    this.apply(requestEnded)
  }
  /** The microphone really opened / closed. */
  listening(on: boolean): void {
    this.apply(on ? voiceStarted : voiceEnded)
  }
  /** Text-to-speech started / stopped playing. */
  speaking(on: boolean): void {
    this.apply(on ? speechStarted : speechEnded)
  }

  toggleHidden(): void {
    this.hidden = !this.hidden
    if (this.hidden) {
      this.cancelDrag()
      this.win.hide()
      this.clearTimers()
    } else {
      this.win.showInactive()
      const b = this.win.getBounds()
      this.place(b.x, b.y) // where it was
      this.armSleep()
    }
    this.schedule()
  }

  // ---------- drag ----------
  beginDrag(): void {
    if (this.hidden || this.drag) return
    this.cancelFall()
    this.wasResting = this.state.asleep
    this.drag = { cursor: screen.getCursorScreenPoint(), origin: this.win.getBounds() }
    this.win.setIgnoreMouseEvents(false)
    this.apply(dragStart)
  }

  moveDrag(): void {
    if (!this.drag) return
    const cur = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(cur).workArea
    const x = clamp(this.drag.origin.x + (cur.x - this.drag.cursor.x), wa.x, wa.x + wa.width - WINDOW_SIZE)
    const y = clamp(this.drag.origin.y + (cur.y - this.drag.cursor.y), wa.y, this.groundY(wa))
    this.setBounds(Math.round(x), Math.round(y))
  }

  endDrag(): void {
    if (!this.drag) return
    this.drag = null
    const b = this.win.getBounds()
    const wa = screen.getDisplayMatching(b).workArea
    this.apply((s) => dragEnd(s, b.x, this.rangeFor(wa), b.y))
    // Desktop roaming: the cat stays exactly where it was dropped, at any height. Dock mode: it drops back to the bottom edge.
    if (this.roamMode() === 'dock') this.fallTo(this.groundY(wa), () => this.schedule())
    else this.schedule()
    if (this.wasResting) {
      // dragging a resting cat moves his home: he lies back down where he was put
      this.wasResting = false
      this.homePos = { x: Math.round(b.x), y: Math.round(this.roamMode() === 'dock' ? this.groundY(wa) : b.y) }
      this.opts.onHomeChanged?.({ ...this.homePos })
      if (this.restMode()) this.apply(fellAsleep, false)
    }
  }

  private cancelDrag(): void {
    if (!this.drag) return
    this.drag = null
    const b = this.win.getBounds()
    this.apply((s) => dragEnd(s, b.x, this.rangeFor(this.currentArea()), b.y), false)
  }

  /** Test hook (PET_E2E only): exactly what dragging the pet and letting go at (x, y) does. */
  debugDrop(x: number, y: number): void {
    if (this.hidden) return
    this.cancelFall()
    this.wasResting = this.state.asleep
    this.drag = { cursor: { x: 0, y: 0 }, origin: this.win.getBounds() }
    this.apply(dragStart)
    const wa = this.currentArea()
    this.setBounds(Math.round(clamp(x, wa.x, wa.x + wa.width - WINDOW_SIZE)), Math.round(clamp(y, wa.y, this.groundY(wa))))
    this.endDrag()
  }

  /** Test hook (PET_E2E only): poke him awake without opening the chat. */
  debugWake(): void {
    this.apply(woke)
  }

  /** Called when the pointer enters/leaves a visible sprite pixel. */
  setHover(over: boolean): void {
    if (this.drag) return // keep receiving events for the whole drag
    this.hovered = over
    this.win.setIgnoreMouseEvents(!over, { forward: true })
  }

  /** Cursor inside the window: let the renderer hit-test it. Outside: the window goes back to click-through. */
  private pollPointer = (): void => {
    if (this.hidden || this.drag || this.win.isDestroyed()) return
    const cur = screen.getCursorScreenPoint()
    const b = this.win.getBounds()
    const inside = cur.x >= b.x && cur.y >= b.y && cur.x < b.x + b.width && cur.y < b.y + b.height
    if (!inside) {
      if (this.lastPointer !== 'out') this.win.webContents.send(Channels.pointer, { x: -1, y: -1 }) // the renderer's hover flag follows
      this.lastPointer = 'out'
      if (this.hovered) this.setHover(false)
      return
    }
    // sent on every tick while inside, even if the cursor is still: he moves and changes pose under it, so whether it is
    // over him changes too (the renderer only answers when that flips)
    this.lastPointer = 'in'
    this.win.webContents.send(Channels.pointer, { x: cur.x - b.x, y: cur.y - b.y })
  }

  // ---------- geometry ----------
  private currentArea(): Rectangle {
    return screen.getDisplayMatching(this.win.getBounds()).workArea
  }
  private roamMode(): RoamMode {
    return this.opts.roam?.() ?? 'edges'
  }
  /**
   * Where the window's top-left may be: the whole work area (desktop roaming) or only the bottom edge (dock). Around the edges,
   * only his body has to stay on screen (the transparent part of his window may hang over), so he can hug the desktop's own edges.
   */
  private rangeFor(wa: Rectangle): XRange {
    const ground = this.groundY(wa)
    if (this.roamMode() === 'edges') {
      const s = WINDOW_SIZE
      return { minX: Math.floor(wa.x - BODY.l * s), maxX: Math.ceil(wa.x + wa.width - BODY.r * s), minY: Math.floor(wa.y - BODY.t * s), maxY: Math.ceil(wa.y + wa.height - BODY.b * s) }
    }
    return { minX: wa.x, maxX: wa.x + wa.width - WINDOW_SIZE, minY: this.roamMode() === 'dock' ? ground : wa.y, maxY: ground }
  }
  private groundY(wa: Rectangle): number {
    return wa.y + wa.height - WINDOW_SIZE + GROUND_MARGIN
  }
  private setBounds(x: number, y: number): void {
    this.win.setBounds({ x, y, width: WINDOW_SIZE, height: WINDOW_SIZE })
    this.opts.onMoved?.({ x, y, width: WINDOW_SIZE, height: WINDOW_SIZE })
  }
  private place(x: number, y: number = this.state.y): void {
    const wa = this.currentArea()
    const r = this.rangeFor(wa)
    const px = Math.round(clamp(x, r.minX, r.maxX))
    const py = Math.round(clamp(y, r.minY!, r.maxY!))
    this.state = { ...this.state, x: px, y: py }
    this.setBounds(px, py)
  }

  /** "Walk along the bottom edge only" on/off, applied right away: dock = drop to the edge; desktop = free again from where it stands. */
  roamChanged(): void {
    if (this.hidden || this.drag) return
    const wa = this.currentArea()
    if (this.roamMode() === 'dock') this.fallTo(this.groundY(wa), () => this.schedule())
    else this.schedule()
  }

  private onDisplayChange = (): void => {
    if (this.drag) return
    const b = this.win.getBounds()
    this.place(b.x, b.y)
  }

  // ---------- clock ----------
  private clearTimers(): void {
    if (this.walkTimer) clearInterval(this.walkTimer)
    if (this.waitTimer) clearTimeout(this.waitTimer)
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.cancelFall()
    this.walkTimer = this.waitTimer = this.sleepTimer = null
  }
  private cancelFall(): void {
    if (this.fallTimer) clearInterval(this.fallTimer)
    this.fallTimer = null
  }

  private restMode(): boolean {
    return this.opts.rest?.() === true
  }

  private armSleep(afterMs = this.opts.sleepAfterMs): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    if (this.hidden || this.state.asleep) return
    this.sleepTimer = setTimeout(() => this.restOrSleep(), afterMs)
  }

  /** No longer in use: walk home and rest there (or, with resting at home off, just doze off where he is). */
  private restOrSleep(): void {
    if (!this.restMode()) return void this.apply(fellAsleep, false)
    const b = this.win.getBounds()
    if (Math.abs(b.x - this.homePos.x) < 3 && Math.abs(b.y - this.homePos.y) < 3) this.apply(fellAsleep, false)
    else this.apply((s) => goHome(s, this.homePos), false)
  }

  /** "Close him": go home and rest now (the chat panel's close button, the menu). Does nothing mid-conversation. */
  goHome(): void {
    if (this.hidden) return
    this.restOrSleep()
  }

  /** The rest-at-home switch changed: on = go home now; off = he stays wherever he is. */
  restChanged(): void {
    if (this.restMode()) this.goHome()
    else this.apply((s) => ({ ...s, target: null }), false)
  }

  private schedule(): void {
    if (this.walkTimer) clearInterval(this.walkTimer)
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.walkTimer = this.waitTimer = null
    if (this.hidden || this.fallTimer) return

    const wake = nextWake(this.state)
    if (wake.kind === 'walk') {
      this.lastTick = performance.now()
      this.walkTimer = setInterval(() => {
        const now = performance.now()
        if (this.state.route && now - this.lastEdgeCheck > EDGE_CHECK_MS) void this.checkRoute()
        const prev = this.state
        this.state = advance(this.state, now - this.lastTick, this.rangeFor(this.currentArea()), this.rng)
        this.lastTick = now
        this.setBounds(Math.round(this.state.x), Math.round(this.state.y))
        if (prev.route && !this.state.route) this.arrived()
        if (prev.loco !== this.state.loco || prev.dir !== this.state.dir || prev.heading !== this.state.heading) {
          this.publish()
          this.schedule()
        }
      }, WALK_TICK_MS)
    } else if (wake.kind === 'wait') {
      this.waitTimer = setTimeout(() => {
        if (this.wantsEdgeWalk()) return void this.planEdges()
        this.state = advance(this.state, wake.ms, this.rangeFor(this.currentArea()), this.rng)
        this.publish()
        this.schedule()
      }, wake.ms)
    }
  }

  // ---------- around the edges ----------
  /** A rest is over and he is free to wander, around the window edges: plan the next walk instead of a random one. */
  private wantsEdgeWalk(): boolean {
    const s = this.state
    return this.roamMode() === 'edges' && s.loco === 'idle' && s.engagement === 'none' && !s.asleep && !s.paused && !s.dragging && !s.chatOpen && !s.target
  }

  private async edgeWorld(): Promise<EdgeWorld | null> {
    const [windows, obstacles] = await Promise.all([this.opts.windows?.() ?? null, this.opts.obstacles?.() ?? null])
    if (!windows) return null
    const wa = this.currentArea()
    return { area: { x: wa.x, y: wa.y, w: wa.width, h: wa.height }, windows, obstacles: obstacles ?? [], size: WINDOW_SIZE }
  }

  private async planEdges(): Promise<void> {
    if (this.planning) return
    this.planning = true
    let route: Array<{ x: number; y: number }> | null = null
    this.goingFor = null
    try {
      const world = await this.edgeWorld()
      if (world) {
        const pos = { x: this.state.x, y: this.state.y }
        // a fish in sight is the best reason to go somewhere: the nearest one he can reach without crossing an icon
        const fish = (this.opts.food?.list() ?? [])
          .filter((f) => !world.windows.some((w) => boxOverlaps(f.box, w))) // he can only see the ones not under a window
          .sort((a, b) => Math.hypot(a.box.x - pos.x, a.box.y - pos.y) - Math.hypot(b.box.x - pos.x, b.box.y - pos.y))
        for (const f of fish) {
          const go = eatSpotFor(f.box, pos, world)
          if (!go) continue
          route = go.way
          this.goingFor = { id: f.id, dir: go.dir }
          break
        }
        route ??= planEdgeWalk(pos, world, this.rng, { minLen: 60 * CAT_ZOOM, maxLen: 320 * CAT_ZOOM, hopChance: 0.2 })
      }
    } finally {
      this.planning = false
    }
    if (this.hidden || this.win.isDestroyed()) return
    // anything may have happened while the window list was read (a drag, a click): only a still-free cat sets off
    if (!this.wantsEdgeWalk()) return void this.schedule()
    this.lastEdgeCheck = performance.now()
    if (this.goingFor && route && Math.hypot(route[route.length - 1]!.x - this.state.x, route[route.length - 1]!.y - this.state.y) < 2) {
      // already standing by it
      this.state = startEating(this.state, EAT_MS, this.goingFor.dir)
      this.eat(this.goingFor.id)
      this.goingFor = null
    } else this.state = route ? startRoute(this.state, route) : { ...this.state, remainingMs: EDGE_RETRY_MS }
    if (debug) console.log(JSON.stringify({ t: Date.now(), event: 'edge-route', route, fish: this.goingFor?.id ?? null }))
    this.publish()
    this.schedule()
  }

  /** A planned walk just ended: if it was to a fish that is still there, eat it. */
  private arrived(): void {
    const g = this.goingFor
    this.goingFor = null
    if (!g || !this.opts.food?.list().some((f) => f.id === g.id)) return
    this.state = startEating(this.state, EAT_MS, g.dir)
    if (this.state.loco !== 'eating') return
    this.eat(g.id)
    this.publish()
    this.schedule()
  }
  private eat(id: number): void {
    if (debug) console.log(JSON.stringify({ t: Date.now(), event: 'eat', fish: id }))
    setTimeout(() => this.opts.food?.eaten(id), FISH_GONE_MS)
  }

  /** A free spot for a new fish (bare desktop, reachable, not on an icon), or null. */
  async fishSpot(): Promise<Box | null> {
    const world = await this.edgeWorld()
    if (!world) return null
    return pickFishSpot(world, { x: this.state.x, y: this.state.y }, this.rng, (this.opts.food?.list() ?? []).map((f) => f.box))
  }
  /** Free to go fishing: awake, wandering around the edges, not busy with you. */
  get canForage(): boolean {
    const s = this.state
    return !this.hidden && this.roamMode() === 'edges' && !s.asleep && !s.paused && !s.chatOpen && s.engagement === 'none'
  }

  /** Walking around the edges: if a window now covers the spot he is heading for, stop and plan again. */
  private async checkRoute(): Promise<void> {
    if (this.planning) return
    this.planning = true
    this.lastEdgeCheck = performance.now()
    let world: EdgeWorld | null = null
    try {
      world = await this.edgeWorld()
    } finally {
      this.planning = false
    }
    const end = this.state.route?.[this.state.route.length - 1]
    const fishGone = this.goingFor !== null && !this.opts.food?.list().some((f) => f.id === this.goingFor!.id)
    if (!world || !end || this.roamMode() !== 'edges' || (visibleAt(end, world) && !fishGone)) return
    this.goingFor = null
    this.apply((s) => dropRoute(s), false)
  }

  private fallTo(targetY: number, done: () => void): void {
    this.cancelFall()
    const from = this.win.getBounds()
    if (Math.abs(from.y - targetY) < 2) {
      this.place(from.x, targetY)
      done()
      return
    }
    const t0 = performance.now()
    this.fallTimer = setInterval(() => {
      const t = Math.min((performance.now() - t0) / FALL_MS, 1)
      this.setBounds(from.x, Math.round(from.y + (targetY - from.y) * t * t))
      if (t >= 1) {
        this.cancelFall()
        this.state = { ...this.state, y: targetY }
        done()
      }
    }, FALL_TICK_MS)
  }

  private publish(): void {
    const msg: PetStateMessage = { mode: displayMode(this.state), dir: this.state.dir, heading: this.state.heading, dragging: this.state.dragging }
    const key = `${msg.mode}:${msg.dir}:${msg.heading}:${msg.dragging}`
    if (key === this.lastPublished) return
    this.lastPublished = key
    if (!this.win.isDestroyed()) this.win.webContents.send(Channels.state, msg)
    if (debug) console.log(JSON.stringify({ t: Date.now(), event: 'state', ...msg, bounds: this.win.getBounds() }))
  }

  /** Re-send the current state, e.g. after the renderer (re)loads. */
  resync(): void {
    this.lastPublished = ''
    this.publish()
  }
}
