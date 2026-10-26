import { describe, expect, it } from 'vitest'
import { advance, chatOpened, dragStart, initialState, startEating, startRoute, WALK_SPEED, type XRange } from '../src/shared/brain'
import { bodyAt, BODY, boxOverlaps, clearPath, eatSpotFor, onIcon, outlines, pickFishSpot, planEdgeWalk, routeTo, visibleAt, type EdgeWorld, type Point } from '../src/shared/perimeter'

const S = 100
const area = { x: 0, y: 30, w: 1600, h: 1000 }
const term = { x: 400, y: 300, w: 600, h: 400 }
const world = (windows = [term]): EdgeWorld => ({ area, windows, size: S })
const seq = (...v: number[]) => {
  let i = 0
  return () => v[i++ % v.length]!
}
const opts = { minLen: 60, maxLen: 200, hopChance: 0.2 }
/** Walk the whole route in small steps and report every place he stood. */
function walk(start: Point, route: Point[]): Point[] {
  const range: XRange = { minX: -50, maxX: 1700, minY: -50, maxY: 1100 }
  let s = startRoute({ ...initialState(start.x, range, () => 0.5, start.y), x: start.x, y: start.y }, route)
  const seen: Point[] = []
  for (let k = 0; k < 4000 && s.loco === 'walking'; k++) {
    s = advance(s, 33, range, () => 0.5)
    seen.push({ x: s.x, y: s.y })
  }
  return seen
}

describe('perimeter: where his body is', () => {
  it('a point on top of a window has his feet on its top edge and his body clear of it', () => {
    const top = outlines(world())[1]![0]!
    const b = bodyAt({ x: top.x + 300, y: top.y }, S)
    expect(b.y + b.h).toBeCloseTo(term.y)
    expect(visibleAt({ x: top.x + 300, y: top.y }, world())).toBe(true)
  })
  it('is hidden when any window covers his body, or off the work area', () => {
    expect(visibleAt({ x: 600, y: 400 }, world())).toBe(false)
    expect(visibleAt({ x: 100, y: 100 }, world())).toBe(true)
    expect(visibleAt({ x: -40, y: 100 }, world())).toBe(false)
    expect(visibleAt({ x: 100, y: area.y + area.h - BODY.b * S + 5 }, world())).toBe(false)
  })
})

describe('planEdgeWalk', () => {
  it('heads for the outline of a window when he is out in the open', () => {
    const route = planEdgeWalk({ x: 150, y: 150 }, world(), seq(0.99, 0.1), opts)
    expect(route).toHaveLength(1)
    const p = route![0]!
    expect(visibleAt(p, world())).toBe(true)
    const onSomeOutline = outlines(world()).some((loop) =>
      loop.some((a, i) => {
        const b = loop[(i + 1) % loop.length]!
        const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
        return Math.abs(cross) / Math.hypot(b.x - a.x, b.y - a.y) < 3
      })
    )
    expect(onSomeOutline).toBe(true)
  })

  it('then walks along that outline, turning its corners, never over the window', () => {
    const top = outlines(world())[1]![0]! // top-left corner of the loop around the window
    const start = { x: top.x + 40, y: top.y }
    const route = planEdgeWalk(start, world(), seq(0.5, 0.99, 0.1), { minLen: 900, maxLen: 900, hopChance: 0 })!
    expect(route.length).toBeGreaterThan(1) // at least one corner
    const path = walk(start, route)
    expect(path.length).toBeGreaterThan(10)
    for (const p of path) expect(visibleAt(p, world())).toBe(true)
    const travelled = path.reduce((d, p, i) => d + (i ? Math.hypot(p.x - path[i - 1]!.x, p.y - path[i - 1]!.y) : 0), 0)
    expect(travelled).toBeGreaterThan(600)
  })

  it('stops where another window covers the outline', () => {
    const top = outlines(world())[1]![0]!
    const blocker = { x: term.x + 250, y: 0, w: 100, h: term.y + 20 } // stands on the window's top edge
    const w = world([term, blocker])
    const start = { x: top.x + 40, y: top.y }
    const route = planEdgeWalk(start, w, seq(0.5, 0.99, 0.1), { minLen: 2000, maxLen: 2000, hopChance: 0 })!
    for (const p of walk(start, route)) expect(visibleAt(p, w)).toBe(true)
  })

  it('a window moved over him: straight to the nearest bare spot', () => {
    const route = planEdgeWalk({ x: 600, y: 400 }, world(), () => 0.5, opts)!
    expect(route).toHaveLength(1)
    expect(visibleAt(route[0]!, world())).toBe(true)
    expect(Math.hypot(route[0]!.x - 600, route[0]!.y - 400)).toBeLessThan(260)
  })

  it('nothing bare to walk on (a window fills the screen): no walk', () => {
    expect(planEdgeWalk({ x: 600, y: 400 }, world([{ x: -10, y: 0, w: 1700, h: 1100 }]), () => 0.5, opts)).toBeNull()
  })
})

describe('brain: planned routes', () => {
  const range: XRange = { minX: 0, maxX: 1500, minY: 0, maxY: 900 }
  it('walks the waypoints in order at the walking speed, then rests', () => {
    let s = startRoute(initialState(100, range, () => 0.5, 100), [
      { x: 200, y: 100 },
      { x: 200, y: 300 }
    ])
    expect(s.loco).toBe('walking')
    s = advance(s, 100, range, () => 0.5)
    expect(s.x - 100).toBeCloseTo(WALK_SPEED * 0.1)
    for (let k = 0; k < 400 && s.loco === 'walking'; k++) s = advance(s, 100, range, () => 0.5)
    expect(s).toMatchObject({ x: 200, y: 300, loco: 'idle', route: null })
  })
  it('a drag throws the route away', () => {
    const s = startRoute(initialState(100, range, () => 0.5, 100), [{ x: 200, y: 100 }])
    expect(dragStart(s).route).toBeNull()
  })
})

describe('desktop icons', () => {
  // a column of icons on the right, like a real desktop, plus the window
  const icons = [0, 1, 2, 3, 4].map((i) => ({ x: 1450, y: 60 + i * 112, w: 96, h: 100 }))
  const w = (): EdgeWorld => ({ area, windows: [term], obstacles: icons, size: S })
  const pathOf = (start: Point, route: Point[]): Point[] => [start, ...walk(start, route)]

  it('standing on an icon does not count as a free spot', () => {
    expect(onIcon({ x: 1440, y: 100 }, w())).toBe(true)
    expect(visibleAt({ x: 1440, y: 100 }, w())).toBe(false)
    expect(visibleAt({ x: 1200, y: 100 }, w())).toBe(true)
  })

  it('a straight line across an icon is not a clear path; one going round it is', () => {
    expect(clearPath({ x: 1300, y: 160 }, { x: 1500, y: 160 }, w())).toBe(false)
    expect(clearPath({ x: 1300, y: 160 }, { x: 1300, y: 700 }, w())).toBe(true)
    // from above the window to below the icon column: no straight line, but a turn works
    const way = routeTo({ x: 1350, y: 650 }, { x: 1500, y: 700 }, w())
    expect(way === null || way.every((p) => !onIcon(p, w()))).toBe(true)
  })

  it('every planned walk, many times over, never puts him on an icon', () => {
    let seed = 1
    const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    let pos: Point = { x: 1300, y: 300 }
    for (let n = 0; n < 60; n++) {
      const route = planEdgeWalk(pos, w(), rng, { minLen: 60, maxLen: 300, hopChance: 0.3 })
      if (!route) continue
      const path = pathOf(pos, route)
      for (const p of path.slice(1)) expect(onIcon(p, w()), JSON.stringify({ n, p })).toBe(false)
      pos = path[path.length - 1]!
    }
  })

  it('dropped on an icon: he walks off it to the nearest free spot', () => {
    const route = planEdgeWalk({ x: 1440, y: 280 }, w(), () => 0.5, { minLen: 60, maxLen: 300, hopChance: 0.2 })!
    const end = route[route.length - 1]!
    expect(onIcon(end, w())).toBe(false)
    expect(visibleAt(end, w())).toBe(true)
  })
})

describe('fish', () => {
  const icons = [0, 1, 2].map((i) => ({ x: 1450, y: 60 + i * 112, w: 96, h: 100 }))
  const w = (): EdgeWorld => ({ area, windows: [term], obstacles: icons, size: S })
  let seed = 7
  const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)

  it('new fish only land on bare desktop: never under a window, on an icon or on another fish, and never right next to him', () => {
    const others: Array<{ x: number; y: number; w: number; h: number }> = []
    for (let n = 0; n < 40; n++) {
      const f = pickFishSpot(w(), { x: 100, y: 100 }, rng, others)!
      expect(f).not.toBeNull()
      for (const b of [term, ...icons, ...others]) expect(boxOverlaps(f, b)).toBe(false)
      expect(Math.hypot(f.x - 150, f.y - 150)).toBeGreaterThan(150)
      if (others.length < 3) others.push(f)
    }
  })

  it('he walks to stand beside the fish, facing it, without crossing an icon, then eats it', () => {
    const fish = { x: 300, y: 800, w: 28, h: 20 }
    const from = { x: 900, y: 850 }
    const go = eatSpotFor(fish, from, w())!
    expect(go.dir).toBe(-1) // coming from the right: stands on its right, facing left
    const path = walk(from, go.way)
    const end = path[path.length - 1]!
    expect(Math.hypot(end.x - go.spot.x, end.y - go.spot.y)).toBeLessThan(1)
    for (const p of path) expect(onIcon(p, w())).toBe(false)
    // feet level with the fish
    expect(bodyAt(end, S).y + bodyAt(end, S).h).toBeCloseTo(fish.y + fish.h + 2, 0)
  })

  it('eating: a few seconds, then back to wandering; a chat or a drag wins over it', () => {
    const range: XRange = { minX: 0, maxX: 1500, minY: 0, maxY: 900 }
    let s = startEating(initialState(100, range, () => 0.5, 100), 2800, -1)
    expect(s).toMatchObject({ loco: 'eating', dir: -1, route: null })
    s = advance(s, 2000, range, () => 0.5)
    expect(s.loco).toBe('eating')
    s = advance(s, 900, range, () => 0.5)
    expect(s.loco).toBe('idle')
    expect(startEating(chatOpened(initialState(100, range, () => 0.5, 100)), 2800).loco).toBe('idle')
  })

  it('walking down or up the screen shows it (facing you / his back), sideways is the default', () => {
    const range: XRange = { minX: 0, maxX: 1500, minY: 0, maxY: 900 }
    const down = advance(startRoute(initialState(100, range, () => 0.5, 100), [{ x: 105, y: 400 }]), 100, range, () => 0.5)
    expect(down.heading).toBe('toward')
    const up = advance(startRoute(initialState(100, range, () => 0.5, 600), [{ x: 100, y: 100 }]), 100, range, () => 0.5)
    expect(up.heading).toBe('away')
    const side = advance(startRoute(initialState(100, range, () => 0.5, 100), [{ x: 600, y: 120 }]), 100, range, () => 0.5)
    expect(side.heading).toBe('side')
  })
})
