import { describe, expect, it } from 'vitest'
import { FRAMES, FRINGE_ROWS, GRASS_PALETTE, renderGrass } from '../src/shared/grass-art'

const W = 90
const H = 80
const R = FRINGE_ROWS - 1 // the solid patch starts this far in on every side
const px = (a: Uint8ClampedArray, w: number, x: number, y: number): number[] => [...a.slice((y * w + x) * 4, (y * w + x) * 4 + 4)]
const opaque = (a: Uint8ClampedArray, w: number, x: number, y: number): boolean => a[(y * w + x) * 4 + 3] === 255

describe('renderGrass', () => {
  const art = renderGrass(W, H)
  const f0 = art.frames[0]!

  it('is deterministic (same art every run) and differs by seed', () => {
    expect(renderGrass(W, H).frames).toEqual(art.frames)
    expect(renderGrass(W, H, 8).frames[0]).not.toEqual(f0)
  })
  it('has the documented shape: FRAMES whole pictures of w*h', () => {
    expect(art.frames).toHaveLength(FRAMES)
    for (const f of art.frames) expect(f.length).toBe(W * H * 4)
  })
  it('only uses fully opaque or fully transparent pixels (hard pixel edges, no blending)', () => {
    for (const a of art.frames) for (let i = 3; i < a.length; i += 4) expect([0, 255]).toContain(a[i])
  })
  it('only uses the palette (so it matches the cat: flat tones, one outline colour)', () => {
    const allowed = new Set(Object.values(GRASS_PALETTE).map((c) => c.join(',')))
    for (const a of art.frames) for (let i = 0; i < a.length; i += 4) if (a[i + 3] === 255) expect(allowed.has(`${a[i]},${a[i + 1]},${a[i + 2]}`)).toBe(true)
  })
  it('has stepped (cut) corners, a filled interior and a dark outline', () => {
    for (const f of art.frames) for (const [x, y] of [[R, R], [W - 1 - R, R], [R, H - 1 - R], [W - 1 - R, H - 1 - R]] as const) expect(opaque(f, W, x, y)).toBe(false)
    expect(px(f0, W, W >> 1, H >> 1)[3]).toBe(255)
    // walking in from the middle of each side, the first pixel of the patch is the outline colour
    const outline = [...GRASS_PALETTE.outline, 255]
    const firstFrom = (xs: number[], ys: number[]): number[] => {
      for (let i = 0; i < xs.length; i++) if (opaque(f0, W, xs[i]!, ys[i]!)) return px(f0, W, xs[i]!, ys[i]!)
      return []
    }
    const n = Array.from({ length: 10 }, (_, i) => i)
    expect(firstFrom(n.map(() => W >> 1), n)).toEqual(outline)
    expect(firstFrom(n.map(() => W >> 1), n.map((i) => H - 1 - i))).toEqual(outline)
    expect(firstFrom(n, n.map(() => H >> 1))).toEqual(outline)
    expect(firstFrom(n.map((i) => W - 1 - i), n.map(() => H >> 1))).toEqual(outline)
  })
  it('grows blades out of every edge, and they all sway', () => {
    const count = (f: Uint8ClampedArray, cells: Array<[number, number]>): number => cells.filter(([x, y]) => opaque(f, W, x, y)).length
    const sides: Record<string, Array<[number, number]>> = {
      top: Array.from({ length: W }, (_, x) => [x, R - 1] as [number, number]),
      bottom: Array.from({ length: W }, (_, x) => [x, H - R] as [number, number]),
      left: Array.from({ length: H }, (_, y) => [R - 1, y] as [number, number]),
      right: Array.from({ length: H }, (_, y) => [W - R, y] as [number, number])
    }
    for (const [side, cells] of Object.entries(sides)) {
      for (const f of art.frames) {
        expect(count(f, cells), side).toBeGreaterThan(0)
        expect(count(f, cells), side).toBeLessThan(cells.length)
      }
      const outer = side === 'top' ? cells.map(([x]) => [x, R - 2] as [number, number]) : side === 'bottom' ? cells.map(([x]) => [x, H - R + 1] as [number, number]) : side === 'left' ? cells.map(([, y]) => [R - 2, y] as [number, number]) : cells.map(([, y]) => [W - R + 1, y] as [number, number])
      const shapes = art.frames.map((f) => outer.map(([x, y]) => (opaque(f, W, x, y) ? 1 : 0)).join(''))
      expect(new Set(shapes).size, side).toBeGreaterThan(1)
    }
  })
  it('has a few pink flowers in the frame', () => {
    let n = 0
    for (let i = 0; i < f0.length; i += 4) if (f0[i] === GRASS_PALETTE.flower[0] && f0[i + 1] === GRASS_PALETTE.flower[1] && f0[i + 3] === 255) n++
    expect(n).toBeGreaterThanOrEqual(8)
  })
  it('works at other sizes', () => {
    const small = renderGrass(30, 24)
    expect(small.frames).toHaveLength(FRAMES)
    expect(small.frames[0]!.length).toBe(30 * 24 * 4)
  })
})
