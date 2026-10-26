import { describe, expect, it } from 'vitest'
import { AO_LEVELS, hash3, meshFromGrid, voxelize, VoxelGrid, type Rgb, type Shape } from '../src/shared/cat3d/voxels'

const WHITE: Rgb = [1, 1, 1]
const box = (center: [number, number, number], radii: [number, number, number], color: Shape['color'] = 1, carve = false): Shape => ({ kind: 'box', center, radii, color, carve })

/** Every triangle must wind counter-clockwise seen from outside: its geometric normal agrees with the stored normal. */
function windingErrors(m: ReturnType<typeof meshFromGrid>): number {
  let bad = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
    const p = (i: number): number[] => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]
    const [pa, pb, pc] = [p(a), p(b), p(c)]
    const e1 = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!]
    const e2 = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!]
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const stored = [m.normals[a * 3]!, m.normals[a * 3 + 1]!, m.normals[a * 3 + 2]!]
    if (n[0]! * stored[0]! + n[1]! * stored[1]! + n[2]! * stored[2]! <= 0) bad++
  }
  return bad
}

describe('voxelize', () => {
  it('fills a box exactly, on the integer lattice', () => {
    const g = voxelize([box([0, 0, 0], [1, 1, 1])]) // spans -1..1 on each axis => 2x2x2
    expect(g.size).toEqual([2, 2, 2])
    expect(g.min).toEqual([-1, -1, -1])
    expect(g.count).toBe(8)
  })
  it('keeps x-symmetric shapes symmetric', () => {
    const g = voxelize([{ kind: 'ellipsoid', center: [0, 2, 1], radii: [4.5, 3.7, 3.7], color: 1 }])
    const [sx, sy, sz] = g.size
    let asym = 0
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) if (g.get(i, j, k) !== g.get(sx - 1 - i, j, k)) asym++
    expect(asym).toBe(0)
    expect(g.count).toBeGreaterThan(100)
  })
  it('later shapes overwrite earlier ones and carving removes', () => {
    const g = voxelize([box([0, 0, 0], [2, 2, 2], 1), box([0, 0, 0], [1, 1, 1], 2), box([-1.5, -1.5, -1.5], [0.4, 0.4, 0.4], 1, true)])
    expect(g.get(g.size[0] / 2, g.size[1] / 2, g.size[2] / 2)).toBe(2) // centre is the second colour
    expect(g.get(0, 0, 0)).toBe(0) // carved (exactly one voxel)
    expect(g.count).toBe(64 - 1)
  })
  it('a colour function can paint regions and leave others untouched (0)', () => {
    const g = voxelize([box([0, 0, 0], [2, 1, 1], 1), box([0, 0, 0], [2, 1, 1], (x) => (x > 0 ? 2 : 0))])
    let one = 0
    let two = 0
    for (let i = 0; i < 4; i++) {
      const v = g.get(i, 0, 0)
      if (v === 1) one++
      if (v === 2) two++
    }
    expect([one, two]).toEqual([2, 2])
  })
  it('an empty shape list gives an empty grid', () => {
    expect(voxelize([]).count).toBe(0)
  })
})

describe('meshFromGrid', () => {
  const single = (): VoxelGrid => voxelize([box([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])])
  it('a single voxel is six quads, fully lit', () => {
    const m = meshFromGrid(single(), [WHITE])
    expect(m.positions.length / 3).toBe(24)
    expect(m.indices.length).toBe(36)
    for (const c of m.colors) expect(c).toBeCloseTo(1, 5)
  })
  it('hides faces between neighbours', () => {
    const g = voxelize([box([1, 0.5, 0.5], [1, 0.5, 0.5])]) // two voxels side by side
    expect(g.count).toBe(2)
    expect(meshFromGrid(g, [WHITE]).indices.length / 6).toBe(10) // 12 quad faces minus the 2 that touch
  })
  it('a solid 3x3x3 cube shows only its 54 outer faces', () => {
    const m = meshFromGrid(voxelize([box([0.5, 0.5, 0.5], [1.5, 1.5, 1.5])]), [WHITE])
    expect(m.indices.length / 6).toBe(54)
  })
  it('all triangles are counter-clockwise from outside and normals are unit axes', () => {
    const g = voxelize([{ kind: 'ellipsoid', center: [0, 0, 0], radii: [3, 2.5, 3.5], color: 1 }, box([0, 3, 0], [0.5, 1, 0.5])])
    const m = meshFromGrid(g, [WHITE])
    expect(windingErrors(m)).toBe(0)
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.abs(m.normals[i]!) + Math.abs(m.normals[i + 1]!) + Math.abs(m.normals[i + 2]!)).toBe(1)
  })
  it('all vertices lie on lattice points of the local space', () => {
    const m = meshFromGrid(voxelize([{ kind: 'ellipsoid', center: [0.5, 1, -2], radii: [2, 2, 2], color: 1 }]), [WHITE])
    for (const p of m.positions) expect(Number.isInteger(p)).toBe(true)
  })
  it('uses the palette colour of each voxel', () => {
    const g = voxelize([box([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 2)])
    const m = meshFromGrid(g, [[1, 0, 0], [0, 1, 0]], { ao: false })
    expect([m.colors[0], m.colors[1], m.colors[2]]).toEqual([0, 1, 0])
  })
  it('darkens crease vertices (ambient occlusion) and never brightens beyond the palette', () => {
    // An L: floor row plus one block on top at the end. The floor face next to the block is occluded at the crease.
    const g = new VoxelGrid([0, 0, 0], [3, 2, 1])
    for (let i = 0; i < 3; i++) g.set(i, 0, 0, 1)
    g.set(2, 1, 0, 1)
    const m = meshFromGrid(g, [WHITE])
    const lit = new Set<number>()
    for (const c of m.colors) lit.add(Math.round(c * 1000) / 1000)
    expect(Math.max(...lit)).toBeLessThanOrEqual(1)
    expect(Math.min(...lit)).toBeLessThan(1)
    expect([...lit].every((c) => AO_LEVELS.some((l) => Math.abs(l - c) < 0.002))).toBe(true)
    expect(meshFromGrid(g, [WHITE], { ao: false }).colors.every((c) => c === 1)).toBe(true)
  })
  it('jitter stays within its bound and is deterministic', () => {
    const g = voxelize([{ kind: 'ellipsoid', center: [0, 0, 0], radii: [3, 3, 3], color: 1 }])
    const a = meshFromGrid(g, [WHITE], { ao: false, jitter: 0.06 })
    const b = meshFromGrid(g, [WHITE], { ao: false, jitter: 0.06 })
    expect(a.colors).toEqual(b.colors)
    expect(Math.max(...a.colors)).toBeLessThanOrEqual(1.06 + 1e-6)
    expect(Math.min(...a.colors)).toBeGreaterThanOrEqual(0.94 - 1e-6)
    expect(new Set(a.colors).size).toBeGreaterThan(5)
  })
  it('an empty grid meshes to nothing', () => {
    expect(meshFromGrid(voxelize([]), [WHITE]).indices.length).toBe(0)
  })
})

describe('hash3', () => {
  it('is deterministic and in [0, 1)', () => {
    for (let i = -5; i < 5; i++) for (let j = -5; j < 5; j++) {
      const h = hash3(i, j, 3)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
      expect(hash3(i, j, 3)).toBe(h)
    }
  })
  it('varies', () => {
    const s = new Set<number>()
    for (let i = 0; i < 50; i++) s.add(hash3(i, 0, 0))
    expect(s.size).toBeGreaterThan(45)
  })
})
