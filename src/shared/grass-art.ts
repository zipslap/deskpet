/**
 * Procedural pixel-art grass for the chat panel (no DOM, so it is testable). The look matches the cat: a dark outline,
 * a few flat tones, hard pixel edges, and a pink flower or two. Every edge is a fringe of blades growing outwards
 * (up, down, left and right), drawn in FRAMES poses so the whole border sways.
 */
export const FRAMES = 4
/** Depth of the fringe ring on every side: blades grow up to FRINGE_ROWS - 2 pixels out from the solid patch. */
export const FRINGE_ROWS = 5

export type RGBA = [number, number, number, number]
type Pixels = Uint8ClampedArray<ArrayBuffer>
export interface GrassArt {
  w: number
  h: number
  /** FRAMES whole pictures of the patch, each w*h*4, row-major; only the blades on the edges differ between them. */
  frames: Pixels[]
}

export const GRASS_PALETTE = {
  outline: [16, 52, 56],
  deep: [38, 112, 58],
  base: [72, 168, 74],
  light: [124, 208, 96],
  pale: [178, 234, 140],
  flower: [232, 84, 138],
  flowerCore: [255, 255, 255]
} as const

/** A tiny deterministic generator so the art is identical on every run and in tests. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
const hash = (x: number, y: number, seed: number): number => {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 2246822519, 3266489917) ^ Math.imul(seed, 2654435761)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Blade height (0..3 rows above the shoulder line) per column, in clumps of 1-2 columns. */
function bladeHeights(w: number, seed: number): number[] {
  const r = prng(seed)
  const hs: number[] = []
  while (hs.length < w) {
    const height = r() < 0.22 ? 3 : r() < 0.5 ? 2 : r() < 0.75 ? 1 : 0
    const width = r() < 0.5 ? 1 : 2
    for (let i = 0; i < width && hs.length < w; i++) hs.push(height)
  }
  return hs
}

interface Edges {
  top: number[]
  bottom: number[]
  left: number[]
  right: number[]
}

/**
 * Is art pixel (x,y) inside the patch in sway `frame`? The solid patch is inset by FRINGE_ROWS - 1 on every side with stepped
 * corners; outside it, along each edge, blades stick out up to 3 pixels, their tips leaning to and fro along the edge.
 */
function inside(x: number, y: number, w: number, h: number, edges: Edges, frame: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false
  const r = FRINGE_ROWS - 1
  const l = r
  const t = r
  const rr = w - 1 - r
  const b = h - 1 - r
  const sway = (i: number): number => Math.round(Math.sin((frame * Math.PI) / 2 + i * 0.35) * 0.9)
  const blade = (hs: number[], i: number, depth: number): boolean => {
    const lean = (hs[i] ?? 0) > 0 ? sway(i) : 0
    return depth <= (hs[Math.min(hs.length - 1, Math.max(0, i - lean))] ?? 0)
  }
  const inX = x >= l && x <= rr
  const inY = y >= t && y <= b
  if (inX && inY) {
    // the solid patch, corners cut in steps
    const dx = Math.min(x - l, rr - x)
    const dy = Math.min(y - t, b - y)
    return !(dx + dy < 2 && dx < 3 && dy < 3)
  }
  // blades only grow along the straight part of each edge, clear of the corners
  if (inX && x - l >= 3 && rr - x >= 3) {
    if (y < t) return blade(edges.top, x, t - y)
    return blade(edges.bottom, x, y - b)
  }
  if (inY && y - t >= 3 && b - y >= 3) {
    if (x < l) return blade(edges.left, y, l - x)
    return blade(edges.right, y, x - rr)
  }
  return false
}

export function renderGrass(w: number, h: number, seed = 7): GrassArt {
  const edges: Edges = { top: bladeHeights(w, seed), bottom: bladeHeights(w, seed + 1), left: bladeHeights(h, seed + 2), right: bladeHeights(h, seed + 3) }
  const P = GRASS_PALETTE
  const flowers = new Map<string, true>()
  // flowers sit in the frame (the visible ring) along the bottom and sides
  const r = prng(seed + 99)
  const spots: Array<[number, number]> = []
  const r0 = FRINGE_ROWS - 1
  for (let i = 0; i < 4; i++) spots.push([r0 + 6 + Math.floor(r() * (w - 2 * r0 - 14)), h - r0 - 3])
  for (let i = 0; i < 2; i++) spots.push([r0 + 1, r0 + 6 + Math.floor(r() * (h - 2 * r0 - 16))], [w - r0 - 3, r0 + 6 + Math.floor(r() * (h - 2 * r0 - 16))])
  for (const [fx, fy] of spots) for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) flowers.set(`${fx + ox},${fy + oy}`, true)

  const colour = (x: number, y: number, frame: number): RGBA => {
    const m = (nx: number, ny: number): boolean => inside(nx, ny, w, h, edges, frame)
    // outline = any pixel of the patch with a 4-neighbour outside it
    if (!m(x - 1, y) || !m(x + 1, y) || !m(x, y - 1) || !m(x, y + 1)) return [...P.outline, 255]
    if (flowers.has(`${x},${y}`)) {
      const core = flowers.has(`${x - 1},${y}`) === false && flowers.has(`${x},${y - 1}`) === false
      return [...(core ? P.flowerCore : P.flower), 255]
    }
    const shade = y / h
    const n = hash(x, y, seed)
    // flat tones with ordered speckle: darker toward the bottom, lighter flecks and little vertical blade ticks
    let tone: readonly [number, number, number] = shade > 0.8 ? P.deep : P.base
    if (n > 0.9) tone = P.light
    else if (n < 0.1 && shade > 0.4) tone = P.deep
    if (hash(x, y + 1, seed) > 0.93 && hash(x, y, seed) > 0.5) tone = P.pale
    if ((x + y) % 7 === 0 && n > 0.55) tone = P.light
    return [...tone, 255]
  }

  const frames: Pixels[] = []
  for (let f = 0; f < FRAMES; f++) {
    const a = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!inside(x, y, w, h, edges, f)) continue
        a.set(colour(x, y, f), (y * w + x) * 4)
      }
    frames.push(a)
  }
  return { w, h, frames }
}
