/**
 * "Around the edges" roaming: the cat walks along the outlines of the open app windows (and the edges of the desktop),
 * always on bare desktop, never over a window. Pure functions only; the controller feeds in the window list and applies the route.
 *
 * Every position here is the pet window's top-left corner. The cat's body only fills part of that square (`BODY`), so an
 * outline is placed where his body, not his window, touches the app window: standing on its top edge, beside its sides, under it.
 */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}

/**
 * Where his body is inside the square pet window, as fractions of its size: measured in every pose and covering both looks
 * (the standing figure is tall, ears near the top; the four-legged cat is wide). A walking tail swings a little wider.
 */
export const BODY = { l: 0.12, r: 0.88, t: 0.08, b: 0.96 }

export interface EdgeWorld {
  /** The display's work area (no menu bar, no Dock). */
  area: Box
  /** Every visible app window, any order. They all cover the cat, who lives on the desktop layer. */
  windows: Box[]
  /** Things on the desktop he must not stand on or walk across: the icons (app shortcuts, files, folders). */
  obstacles?: Box[]
  /** Pet window size. */
  size: number
}

export interface EdgePlanOptions {
  /** How far one walk along an outline goes, in DIPs. */
  minLen: number
  maxLen: number
  /** Chance of heading over to another window's outline instead of carrying on along this one. */
  hopChance: number
}

/** Sampling step along the outlines, in DIPs. */
const STEP = 4
/** Within this distance of an outline point, he counts as standing on that outline. */
const ON_PATH = 3

export function bodyAt(p: Point, size: number): Box {
  return { x: p.x + BODY.l * size, y: p.y + BODY.t * size, w: (BODY.r - BODY.l) * size, h: (BODY.b - BODY.t) * size }
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** His body is on the bare desktop: inside the work area, under no window, and not on top of a desktop icon. */
export function visibleAt(p: Point, world: EdgeWorld): boolean {
  const b = bodyAt(p, world.size)
  const a = world.area
  if (b.x < a.x - 1 || b.y < a.y - 1 || b.x + b.w > a.x + a.w + 1 || b.y + b.h > a.y + a.h + 1) return false
  return !world.windows.some((w) => overlaps(b, w)) && !onIcon(p, world)
}

/** His body overlaps a desktop icon. */
export function onIcon(p: Point, world: EdgeWorld): boolean {
  const b = bodyAt(p, world.size)
  return (world.obstacles ?? []).some((o) => overlaps(b, o))
}

/** Walking straight from `a` to `b` never takes him across an icon (checked every few DIPs; leaving one he stands on is fine). */
export function clearPath(a: Point, b: Point, world: EdgeWorld): boolean {
  if (!world.obstacles?.length) return true
  const n = Math.max(1, Math.ceil(dist(a, b) / 6))
  let leaving = onIcon(a, world)
  for (let k = 1; k <= n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }
    const hit = onIcon(p, world)
    if (leaving) leaving = hit
    else if (hit) return false
  }
  return true
}

/** A way from `a` to `b` that crosses no icon: straight, or with one turn (across then down, or down then across). Null if neither. */
export function routeTo(a: Point, b: Point, world: EdgeWorld): Point[] | null {
  if (clearPath(a, b, world)) return [round(b)]
  for (const corner of [{ x: b.x, y: a.y }, { x: a.x, y: b.y }]) {
    if (visibleAt(corner, world) && clearPath(a, corner, world) && clearPath(corner, b, world)) return [round(corner), round(b)]
  }
  return null
}

/** The outlines he can walk, as closed loops of corners: one around every window, and the edges of the desktop itself. */
export function outlines(world: EdgeWorld): Point[][] {
  const s = world.size
  const loop = (l: number, t: number, r: number, b: number): Point[] => [
    { x: l, y: t },
    { x: r, y: t },
    { x: r, y: b },
    { x: l, y: b }
  ]
  const a = world.area
  // around the desktop, around every window, and around every icon (so he skirts the icons rather than walking over them)
  const paths = [loop(a.x - BODY.l * s, a.y - BODY.t * s, a.x + a.w - BODY.r * s, a.y + a.h - BODY.b * s)]
  for (const w of world.windows) {
    if (w.w < 40 || w.h < 40) continue
    // body just outside each edge: on top of it (feet on the edge), right of it, under it, left of it
    paths.push(loop(w.x - BODY.r * s, w.y - BODY.b * s, w.x + w.w - BODY.l * s, w.y + w.h - BODY.t * s))
  }
  for (const o of world.obstacles ?? []) paths.push(loop(o.x - BODY.r * s - 2, o.y - BODY.b * s - 2, o.x + o.w - BODY.l * s + 2, o.y + o.h - BODY.t * s + 2))
  return paths
}

interface Sample extends Point {
  path: number
  i: number
  ok: boolean
}

/** Points every STEP DIPs around each closed loop. */
function sample(paths: Point[][], world: EdgeWorld): Sample[][] {
  return paths.map((corners, path) => {
    const out: Sample[] = []
    for (let c = 0; c < corners.length; c++) {
      const a = corners[c]!
      const b = corners[(c + 1) % corners.length]!
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const n = Math.max(1, Math.round(len / STEP))
      for (let k = 0; k < n; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }
        out.push({ ...p, path, i: out.length, ok: visibleAt(p, world) })
      }
    }
    return out
  })
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) })

/** Keep only the corners of a run of samples (where the heading changes) and its end. */
function corners(run: Point[]): Point[] {
  const out: Point[] = []
  for (let k = 1; k < run.length; k++) {
    const p = run[k - 1]!
    const q = run[k]!
    const r = run[k + 1]
    if (!r) break
    const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)
    if (Math.abs(cross) > 0.5) out.push(round(q))
  }
  if (run.length > 1) out.push(round(run[run.length - 1]!))
  return out
}

/**
 * The next walk, as waypoints (window top-left positions) to visit in order, or null when there is no bare desktop to walk on.
 *   standing on an outline: carry on along it (either way) for a while, as far as it stays uncovered;
 *   otherwise, or now and then (`hopChance`), or when a window has just covered him: head for the nearest point of some outline.
 */
export function planEdgeWalk(pos: Point, world: EdgeWorld, rng: () => number, opts: EdgePlanOptions): Point[] | null {
  const loops = sample(outlines(world), world)
  const all = loops.flat().filter((p) => p.ok)
  if (all.length === 0) return null

  let here: Sample | null = null
  for (const p of all) if (dist(p, pos) <= ON_PATH && (!here || dist(p, pos) < dist(here, pos))) here = p

  if (here && rng() >= opts.hopChance) {
    const loop = loops[here.path]!
    const want = opts.minLen + rng() * (opts.maxLen - opts.minLen)
    const first: 1 | -1 = rng() < 0.5 ? 1 : -1
    for (const dir of [first, -first]) {
      const run: Point[] = [pos]
      for (let k = 1; k < loop.length && (run.length - 1) * STEP < want; k++) {
        const p = loop[(((here.i + dir * k) % loop.length) + loop.length) % loop.length]!
        if (!p.ok) break
        run.push(p)
      }
      if ((run.length - 1) * STEP >= 12) return corners(run)
    }
  }

  // Head for another outline: pick one at random among those with a bare stretch, then walk to its nearest bare point.
  // Not visible where he is (a window moved over him): straight to the nearest bare point of any outline.
  // Every walk avoids crossing icons: a target is only taken if there is a clear way to it (straight or with one turn).
  const nearestOn = (pts: Sample[]): Sample => pts.reduce((m, p) => (dist(p, pos) < dist(m, pos) ? p : m))
  const byDistance = (pts: Sample[]): Sample[] => [...pts].sort((p, q) => dist(p, pos) - dist(q, pos))
  if (!visibleAt(pos, world) && !here) {
    // covered by a window, or standing on an icon: the nearest bare spot he can get to without crossing another icon
    const near = byDistance(all)
    for (const p of near.slice(0, 200)) {
      const way = routeTo(pos, p, world)
      if (way) return way
    }
    return [round(near[0]!)]
  }
  const reachable = loops
    .map((l) => l.filter((p) => p.ok && (!here || p.path !== here.path)))
    .filter((l) => l.length > 0)
    .map(nearestOn)
    .filter((p) => dist(p, pos) > ON_PATH)
  // closer outlines are likelier, so he mostly explores his neighbourhood; try them in that weighted random order
  const order = reachable.map((p) => ({ p, key: rng() ** (1 + dist(p, pos) / 200) })).sort((x, y) => y.key - x.key)
  for (const { p } of order) {
    const way = routeTo(pos, p, world)
    if (way) return way
  }
  return null
}

// ---------- fish ----------
/** A fish on the desktop, in DIPs (the window it is drawn in). */
export const FISH = { w: 28, h: 20 }

export const boxOverlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Where he stands to eat `fish`: beside it, his feet level with it and his paws just over it, on the side he is coming from
 * (the other side if that one is blocked). Null if neither side is free and reachable.
 */
export function eatSpotFor(fish: Box, from: Point, world: EdgeWorld): { spot: Point; way: Point[]; dir: 1 | -1 } | null {
  const s = world.size
  const y = fish.y + fish.h - BODY.b * s + 2
  const left = { spot: { x: fish.x - BODY.r * s + 8, y }, dir: 1 as const }
  const right = { spot: { x: fish.x + fish.w - BODY.l * s - 8, y }, dir: -1 as const }
  const sides = from.x + (s / 2) < fish.x + fish.w / 2 ? [left, right] : [right, left]
  for (const side of sides) {
    if (!visibleAt(side.spot, world)) continue
    const way = routeTo(from, side.spot, world)
    if (way) return { spot: round(side.spot), way, dir: side.dir }
  }
  return null
}

/**
 * A spot for a new fish: on bare desktop (inside the work area, under no window, clear of every icon and other fish), not too
 * close to him so he has somewhere to go, and with a free place beside it where he can stand and eat. Null if there is none.
 */
export function pickFishSpot(world: EdgeWorld, cat: Point, rng: () => number, others: Box[] = []): Box | null {
  const a = world.area
  const blockers = [...world.windows, ...(world.obstacles ?? []), ...others]
  for (let k = 0; k < 300; k++) {
    const fish = { x: Math.round(a.x + 40 + rng() * (a.w - 80 - FISH.w)), y: Math.round(a.y + 40 + rng() * (a.h - 60 - FISH.h)), ...FISH }
    if (blockers.some((b) => boxOverlaps(fish, b))) continue
    if (dist({ x: fish.x, y: fish.y }, { x: cat.x + world.size / 2, y: cat.y + world.size / 2 }) < 160) continue
    if (eatSpotFor(fish, cat, world)) return fish
  }
  return null
}
