import { describe, expect, it } from 'vitest'
import {
  CURIOUS_MS,
  MAX_SLOPE,
  MAX_STEP_MS,
  WALK_SPEED,
  advance,
  alerted,
  chatClosed,
  chatOpened,
  clamp,
  displayMode,
  dragEnd,
  dragStart,
  fellAsleep,
  goHome,
  initialState,
  nextWake,
  pause,
  requestEnded,
  responseStarted,
  resume,
  submitted,
  voiceEnded,
  speechEnded,
  speechStarted,
  voiceStarted,
  woke,
  type PetState,
  type Rng
} from '../src/shared/brain'

const range = { minX: 0, maxX: 1000 }
const seq = (...v: number[]): Rng => {
  let i = 0
  return () => v[i++ % v.length]!
}
const base: PetState = {
  loco: 'idle',
  engagement: 'none',
  asleep: false,
  paused: false,
  dragging: false,
  chatOpen: false,
  requestActive: false,
  voiceOut: false,
  dir: 1,
  heading: 'side',
  x: 500,
  y: 0,
  slope: 0,
  target: null,
  route: null,
  remainingMs: 1000
}
const st = (over: Partial<PetState> = {}): PetState => ({ ...base, ...over })
const walking = (over: Partial<PetState> = {}): PetState => st({ loco: 'walking', remainingMs: 5000, ...over })

describe('clamp', () => {
  it('limits to range and tolerates an inverted range', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
    expect(clamp(5, 10, 0)).toBe(10)
  })
})

describe('displayMode priority', () => {
  it('engagement beats sleep beats pause beats locomotion', () => {
    expect(displayMode(st())).toBe('idle')
    expect(displayMode(walking())).toBe('walking')
    expect(displayMode(walking({ paused: true }))).toBe('paused')
    expect(displayMode(st({ paused: true, asleep: true }))).toBe('sleeping')
    expect(displayMode(st({ asleep: true, engagement: 'curious' }))).toBe('curious')
    for (const e of ['curious', 'listening', 'thinking', 'speaking'] as const) expect(displayMode(st({ engagement: e, paused: true }))).toBe(e)
  })
})

describe('advance: locomotion', () => {
  it('idle stays idle until its timer runs out, then walks', () => {
    const s = advance(st({ remainingMs: 1000 }), 400, range, seq(0.9))
    expect(s.loco).toBe('idle')
    expect(s.remainingMs).toBe(600)
    const w = advance(st({ remainingMs: 100 }), 100, range, seq(0.1, 0.5))
    expect(w.loco).toBe('walking')
    expect(w.dir).toBe(1)
    expect(w.remainingMs).toBeGreaterThanOrEqual(2500)
  })

  it('walks at WALK_SPEED in the facing direction', () => {
    expect(advance(walking({ dir: -1 }), 50, range, seq(0.5)).x).toBeCloseTo(500 - WALK_SPEED * 0.05)
  })

  it('caps a stalled tick so the pet cannot teleport', () => {
    expect(advance(walking(), 60_000, range, seq(0.5)).x).toBeCloseTo(500 + WALK_SPEED * (MAX_STEP_MS / 1000))
  })

  it('turns around at both screen edges and never leaves the range', () => {
    const right = advance(walking({ x: 999.9, dir: 1 }), 100, range, seq(0.5))
    expect([right.x, right.dir]).toEqual([1000, -1])
    const left = advance(walking({ x: 0.1, dir: -1 }), 100, range, seq(0.5))
    expect([left.x, left.dir]).toEqual([0, 1])
  })

  it('starts walking away from the wall when idle at an edge', () => {
    expect(advance(st({ x: 0, remainingMs: 0 }), 0, range, seq(0.9)).dir).toBe(1)
    expect(advance(st({ x: 1000, remainingMs: 0 }), 0, range, seq(0.1)).dir).toBe(-1)
  })

  it('returns to idle when the walk segment ends', () => {
    expect(advance(walking({ remainingMs: 20 }), 33, range, seq(0.5)).loco).toBe('idle')
  })

  it('pulls x back into range after the screen shrinks', () => {
    expect(advance(st({ x: 5000 }), 10, { minX: 0, maxX: 800 }, seq(0.5)).x).toBe(800)
  })
})

describe('advance: nothing moves unless the pet is free', () => {
  it.each([
    ['paused', { paused: true }],
    ['dragging', { dragging: true }],
    ['asleep', { asleep: true }],
    ['thinking', { engagement: 'thinking' }],
    ['speaking', { engagement: 'speaking' }],
    ['listening', { engagement: 'listening' }],
    ['curious with chat open', { engagement: 'curious', chatOpen: true }]
  ] as const)('%s', (_n, over) => {
    const s = walking(over as Partial<PetState>)
    expect(advance(s, 1000, range, seq(0.5))).toEqual(s)
  })
})

describe('curious timeout (woken without a chat panel)', () => {
  it('relaxes to idle after CURIOUS_MS', () => {
    let s = woke(st({ asleep: true }))
    expect(displayMode(s)).toBe('curious')
    expect(s.remainingMs).toBe(CURIOUS_MS)
    s = advance(s, CURIOUS_MS - 1, range, seq(0.5))
    expect(displayMode(s)).toBe('curious')
    s = advance(s, 5, range, seq(0.5))
    expect(displayMode(s)).toBe('idle')
  })
})

describe('nextWake: the controller only needs timers when something is time-driven', () => {
  it('maps states to timers', () => {
    expect(nextWake(walking())).toEqual({ kind: 'walk' })
    expect(nextWake(st({ remainingMs: 1234 }))).toEqual({ kind: 'wait', ms: 1234 })
    expect(nextWake(st({ engagement: 'curious', remainingMs: 77 }))).toEqual({ kind: 'wait', ms: 77 })
    for (const over of [{ paused: true }, { dragging: true }, { asleep: true }, { engagement: 'thinking' }, { engagement: 'speaking' }, { engagement: 'curious', chatOpen: true }] as const)
      expect(nextWake(st(over as Partial<PetState>))).toEqual({ kind: 'none' })
  })
})

describe('conversation lifecycle', () => {
  it('open -> submit -> first text -> done -> close', () => {
    let s = chatOpened(st())
    expect(displayMode(s)).toBe('curious')
    s = submitted(s)
    expect(displayMode(s)).toBe('thinking')
    s = responseStarted(s)
    expect(displayMode(s)).toBe('speaking')
    s = requestEnded(s)
    expect(displayMode(s)).toBe('curious')
    s = chatClosed(s)
    expect(displayMode(s)).toBe('idle')
    expect(s.chatOpen).toBe(false)
  })

  it('cancelling while thinking returns to curious and a late first-chunk is ignored', () => {
    let s = submitted(chatOpened(st()))
    s = requestEnded(s) // cancelled
    expect(displayMode(s)).toBe('curious')
    expect(responseStarted(s)).toBe(s) // stale chunk after cancel changes nothing
  })

  it('repeated and out-of-order events are harmless', () => {
    const open = chatOpened(st())
    expect(chatOpened(open).engagement).toBe('curious')
    expect(requestEnded(open)).toBe(open)
    expect(requestEnded(requestEnded(submitted(open)))).toEqual(requestEnded(submitted(open)))
    expect(submitted(st())).toEqual(st()) // cannot submit with no panel
    expect(chatClosed(st())).toEqual(st())
  })

  it('closing the panel mid-request ends the engagement; late events do nothing', () => {
    let s = submitted(chatOpened(st()))
    s = chatClosed(s)
    expect(displayMode(s)).toBe('idle')
    expect(responseStarted(s)).toBe(s)
    expect(requestEnded(s)).toBe(s)
  })

  it('reopening the panel while a request is in flight keeps thinking', () => {
    const s = chatOpened(submitted(chatOpened(st())))
    expect(displayMode(s)).toBe('thinking')
  })

  it('voice input states are consistent', () => {
    expect(voiceStarted(st())).toEqual(st()) // needs the panel
    const s = voiceStarted(chatOpened(st()))
    expect(displayMode(s)).toBe('listening')
    expect(displayMode(voiceEnded(s))).toBe('curious')
    expect(voiceStarted(submitted(chatOpened(st()))).engagement).toBe('thinking') // cannot interrupt a request
  })
})

describe('speech output (text-to-speech)', () => {
  const speakingReply = () => responseStarted(submitted(chatOpened(st())))

  it('the pet keeps speaking after the text is complete, until the voice finishes', () => {
    let s = speechStarted(speakingReply())
    expect(s.voiceOut).toBe(true)
    s = requestEnded(s) // text stream done, audio still playing
    expect(displayMode(s)).toBe('speaking')
    expect(s.requestActive).toBe(false)
    s = speechEnded(s)
    expect(displayMode(s)).toBe('curious')
    expect(s.voiceOut).toBe(false)
  })

  it('the voice can finish before the text does without ending the reply', () => {
    let s = speechStarted(speakingReply())
    s = speechEnded(s) // gap between sentences
    expect(displayMode(s)).toBe('speaking') // request still active
    s = speechStarted(s)
    s = requestEnded(speechEnded(requestEnded(s)))
    expect(displayMode(s)).toBe('curious')
  })

  it('stopping the voice mid-reply (user interrupts) settles the pet once the request is over too', () => {
    let s = speechStarted(speakingReply())
    s = speechEnded(s)
    s = requestEnded(s)
    expect(displayMode(s)).toBe('curious')
  })

  it('cancelling the request while the voice plays leaves the pet speaking until the voice is stopped', () => {
    let s = requestEnded(speechStarted(speakingReply()))
    expect(displayMode(s)).toBe('speaking')
    s = speechEnded(s)
    expect(displayMode(s)).toBe('curious')
  })

  it('submitting a new message silences the old speech state', () => {
    const s = submitted(requestEnded(speechStarted(speakingReply())))
    expect(s.voiceOut).toBe(false)
    expect(displayMode(s)).toBe('thinking')
    expect(speechEnded(s)).toBe(s) // a late "voice finished" does nothing
  })

  it('closing the panel clears speech and request flags', () => {
    const s = chatClosed(speechStarted(speakingReply()))
    expect([s.voiceOut, s.requestActive, s.engagement]).toEqual([false, false, 'none'])
    expect(speechStarted(s)).toBe(s) // no panel, no speech state
  })

  it('cannot start listening while speaking or thinking', () => {
    expect(voiceStarted(speechStarted(speakingReply())).engagement).toBe('speaking')
    expect(voiceStarted(submitted(chatOpened(st()))).engagement).toBe('thinking')
  })
})

describe('interaction with drag / pause / sleep', () => {
  it('dragging while a reply is being spoken does not lose the conversation', () => {
    let s = responseStarted(submitted(chatOpened(st())))
    s = dragStart(s)
    expect(displayMode(s)).toBe('speaking')
    s = dragEnd(s, 300, range)
    expect(displayMode(s)).toBe('speaking')
    expect(s.x).toBe(300)
    expect(s.chatOpen).toBe(true)
  })

  it('pause does not cancel a conversation, and resume restores walking only after a pause', () => {
    const s = pause(submitted(chatOpened(st())))
    expect(displayMode(s)).toBe('thinking')
    expect(resume(s).paused).toBe(false)
    expect(resume(st())).toEqual(st())
    expect(displayMode(pause(walking()))).toBe('paused')
    expect(displayMode(resume(pause(walking())))).toBe('idle')
  })

  it('drag works while paused and keeps it paused', () => {
    const s = dragEnd(dragStart(pause(walking())), 300, range)
    expect(displayMode(s)).toBe('paused')
    expect(s.x).toBe(300)
  })

  it('dragEnd outside a drag is a no-op; dragStart twice is a no-op', () => {
    expect(dragEnd(st(), 10, range)).toEqual(st())
    const d = dragStart(st())
    expect(dragStart(d)).toBe(d)
  })

  it('only a free pet falls asleep', () => {
    expect(displayMode(fellAsleep(st()))).toBe('sleeping')
    expect(fellAsleep(st({ engagement: 'curious' })).asleep).toBe(false)
    expect(fellAsleep(st({ chatOpen: true })).asleep).toBe(false)
    expect(fellAsleep(st({ dragging: true })).asleep).toBe(false)
  })

  it('opening the chat or dragging wakes a sleeper; woke is a no-op when awake', () => {
    const asleep = fellAsleep(st())
    expect(displayMode(chatOpened(asleep))).toBe('curious')
    expect(chatOpened(asleep).asleep).toBe(false)
    expect(dragStart(asleep).asleep).toBe(false)
    expect(woke(st())).toEqual(st())
  })
})

describe('initialState', () => {
  it('starts idle and inside the range', () => {
    const s = initialState(-50, range, seq(0.2, 0.3))
    expect(displayMode(s)).toBe('idle')
    expect(s.x).toBe(0)
  })
})

describe('fuzz: random event sequences keep the invariants', () => {
  it('20k random events', () => {
    const events: Array<(s: PetState) => PetState> = [
      chatOpened,
      chatClosed,
      submitted,
      responseStarted,
      requestEnded,
      voiceStarted,
      voiceEnded,
      speechStarted,
      speechEnded,
      pause,
      resume,
      dragStart,
      (s) => dragEnd(s, Math.random() * 3000 - 1000, range),
      fellAsleep,
      woke,
      (s) => advance(s, Math.random() * 400, range, Math.random)
    ]
    let s = initialState(500, range, Math.random)
    for (let i = 0; i < 20_000; i++) {
      s = events[Math.floor(Math.random() * events.length)]!(s)
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(1000)
      if (['thinking', 'speaking', 'listening'].includes(s.engagement)) expect(s.chatOpen).toBe(true)
      if (s.asleep) expect(s.engagement).toBe('none')
      if (s.voiceOut || s.requestActive) expect(s.chatOpen).toBe(true)
      if (s.requestActive) expect(['thinking', 'speaking']).toContain(s.engagement)
      if (s.paused || s.engagement !== 'none') expect(nextWake(s).kind).not.toBe('walk')
    }
  })
})

describe('alerted (a nudge or reaction perks the cat up, cosmetically)', () => {
  const range = { minX: 0, maxX: 1000 }
  const base = () => initialState(500, range, () => 0.5)
  it('turns an unengaged cat curious for the given time, then it settles on its own', () => {
    const s = alerted(base(), 4000)
    expect(displayMode(s)).toBe('curious')
    expect(nextWake(s)).toEqual({ kind: 'wait', ms: 4000 })
    expect(displayMode(advance(s, 4001, range, () => 0.5))).not.toBe('curious')
  })
  it('wakes a sleeping cat', () => {
    expect(displayMode(alerted({ ...base(), asleep: true }, 3000))).toBe('curious')
    expect(alerted({ ...base(), asleep: true }, 3000).asleep).toBe(false)
  })
  it.each([
    ['dragging', { dragging: true }],
    ['paused', { paused: true }],
    ['chat open', { chatOpen: true }],
    ['thinking', { engagement: 'thinking' as const }],
    ['listening', { engagement: 'listening' as const }]
  ])('does nothing while %s', (_n, over) => {
    const s = { ...base(), ...over }
    expect(alerted(s, 3000)).toBe(s)
  })
})

describe('2D walking (the whole desktop surface)', () => {
  const area = { minX: 0, maxX: 1000, minY: 0, maxY: 600 }
  const walking = (over: Partial<PetState> = {}): PetState => ({ ...base, loco: 'walking', dir: 1, x: 500, y: 300, slope: 0.5, remainingMs: 10_000, ...over })

  it('starts each walk at its own angle when there is vertical room, within the steepest allowed', () => {
    const slopes = [0.0, 0.25, 0.5, 0.75, 1.0].map((r) => advance({ ...base, y: 300, remainingMs: 0 }, 1, area, seq(0.9, r, 0.5, 0.5)).slope)
    expect(new Set(slopes).size).toBeGreaterThan(3)
    for (const sl of slopes) expect(Math.abs(sl)).toBeLessThanOrEqual(MAX_SLOPE + 1e-9)
  })
  it('walks diagonally: x and y both change, at exactly the walking speed along the heading', () => {
    const s = advance(walking(), 100, area, seq(0.5))
    expect(s.x).toBeGreaterThan(500)
    expect(s.y).toBeGreaterThan(300)
    const dist = Math.hypot(s.x - 500, s.y - 300)
    expect(dist).toBeCloseTo(WALK_SPEED * 0.1, 5)
    expect((s.y - 300) / (s.x - 500)).toBeCloseTo(0.5, 5)
  })
  it('up the screen as well as down (negative slope)', () => {
    expect(advance(walking({ slope: -0.5 }), 100, area, seq(0.5)).y).toBeLessThan(300)
  })
  it('reflects off the top and bottom edges and never leaves the area', () => {
    const down = advance(walking({ y: 599.9, slope: 0.7 }), 100, area, seq(0.5))
    expect(down.y).toBe(600)
    expect(down.slope).toBeLessThan(0)
    const up = advance(walking({ y: 0.1, slope: -0.7 }), 100, area, seq(0.5))
    expect(up.y).toBe(0)
    expect(up.slope).toBeGreaterThan(0)
  })
  it('long walks stay inside the area', () => {
    let s = walking({ x: 10, y: 10, slope: 0.7 })
    for (let i = 0; i < 2000; i++) {
      s = advance({ ...s, remainingMs: 5000 }, 33, area, seq(0.3, 0.8, 0.1, 0.9))
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(1000)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(600)
    }
  })
  it('turns to face the way it is going (dir follows x only)', () => {
    expect(advance(walking({ dir: -1, slope: 0.7 }), 100, area, seq(0.5)).dir).toBe(-1)
  })
  it('with no vertical room it is exactly the old straight walk along x (and draws no extra random number)', () => {
    const flat = { minX: 0, maxX: 1000, minY: 500, maxY: 500 }
    const started = advance({ ...base, y: 500, remainingMs: 0 }, 1, flat, seq(0.9, 0.5))
    expect(started.slope).toBe(0)
    const s = advance({ ...started, remainingMs: 10_000 }, 100, flat, seq(0.5))
    expect(s.y).toBe(500)
    expect(s.x).toBeCloseTo(started.x + started.dir * WALK_SPEED * 0.1, 5)
    expect(advance({ ...base, y: 0, remainingMs: 0 }, 1, { minX: 0, maxX: 1000 }, seq(0.9, 0.5)).slope).toBe(0)
  })
  it('a pet dropped anywhere stays exactly where it was dropped', () => {
    const dragged = dragStart({ ...base, x: 100, y: 100 })
    const dropped = dragEnd(dragged, 640, area, 275)
    expect(dropped).toMatchObject({ x: 640, y: 275, dragging: false, loco: 'idle', slope: 0 })
    expect(dragEnd(dragged, 5000, area, 9000)).toMatchObject({ x: 1000, y: 600 }) // clamped to the screen, not teleported
  })
  it('a drop without a y keeps the current height', () => {
    expect(dragEnd(dragStart({ ...base, y: 222 }), 10, area).y).toBe(222)
  })
})

describe('going home to rest', () => {
  const area = { minX: 0, maxX: 1000, minY: 0, maxY: 600 }
  const home = { x: 900, y: 500 }
  it('walks straight to the spot (diagonally) at the walking speed, then falls asleep there', () => {
    let s = goHome({ ...base, x: 100, y: 100 }, home)
    expect(s.target).toEqual(home)
    expect(nextWake(s)).toEqual({ kind: 'walk' })
    const one = advance(s, 100, area, () => 0.5)
    expect(Math.hypot(one.x - 100, one.y - 100)).toBeCloseTo(WALK_SPEED * 0.1, 5)
    expect((one.y - 100) / (one.x - 100)).toBeCloseTo(400 / 800, 5) // along the line to home
    let steps = 0
    for (; s.target && steps < 5000; steps++) s = advance(s, 33, area, () => 0.5)
    expect(steps).toBeLessThan(5000)
    expect(s).toMatchObject({ x: 900, y: 500, asleep: true, target: null, loco: 'idle' })
    expect(displayMode(s)).toBe('sleeping')
    expect(nextWake(s)).toEqual({ kind: 'none' }) // resting costs no timer at all
  })
  it('faces the way it walks', () => {
    expect(advance(goHome({ ...base, x: 100, y: 100 }, home), 100, area, () => 0.5).dir).toBe(1)
    expect(advance(goHome({ ...base, x: 950, y: 100 }, { x: 100, y: 100 }), 100, area, () => 0.5).dir).toBe(-1)
  })
  it('already there: lies down at once', () => {
    expect(advance(goHome({ ...base, x: 900, y: 500 }, home), 33, area, () => 0.5)).toMatchObject({ asleep: true, target: null })
  })
  it('only the bottom edge (dock mode): goes along x to the home x and ignores any height', () => {
    const flat = { minX: 0, maxX: 1000, minY: 560, maxY: 560 }
    let s = goHome({ ...base, x: 100, y: 560 }, { x: 800, y: 123 })
    for (let i = 0; i < 5000 && s.target; i++) s = advance(s, 33, flat, () => 0.5)
    expect(s).toMatchObject({ x: 800, y: 560, asleep: true })
  })
  it.each([
    ['asleep (already resting)', { asleep: true }],
    ['dragging', { dragging: true }],
    ['chat open', { chatOpen: true }],
    ['thinking', { engagement: 'thinking' as const }],
    ['listening', { engagement: 'listening' as const }]
  ])('does nothing while %s', (_n, over) => {
    const s = { ...base, ...over }
    expect(goHome(s, home)).toBe(s)
  })
  it('wins over "paused"', () => {
    expect(goHome({ ...base, paused: true }, home)).toMatchObject({ paused: false, target: home })
  })
  it('opening the chat, grabbing the cat or waking it cancels the trip', () => {
    const heading = goHome(base, home)
    expect(chatOpened(heading).target).toBeNull()
    expect(dragStart(heading).target).toBeNull()
  })
  it('an alert while heading home perks it up, then it carries on home', () => {
    let s = alerted(goHome({ ...base, x: 100, y: 100 }, home), 1000)
    expect(displayMode(s)).toBe('curious')
    expect(s.target).toEqual(home)
    s = advance(s, 1001, area, () => 0.5)
    expect(displayMode(s)).toBe('walking')
  })
})
