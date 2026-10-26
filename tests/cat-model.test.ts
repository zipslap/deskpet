import { describe, expect, it } from 'vitest'
import {
  BONES, buildArc, buildPart, buildZGlyph, CHEST, COAT_NAMES, COATS, faceFrontZ, FUR, hexToLinear, isCoatName, paletteFor, PART_SHAPES, PINK, TAIL_SEGMENTS,
  type PartName
} from '../src/shared/cat3d/cat-model'
import { meshFromGrid, voxelize } from '../src/shared/cat3d/voxels'

const PARTS = Object.keys(PART_SHAPES) as PartName[]

describe('coats and palette', () => {
  it('has the five coats, each with every colour as a valid #rrggbb', () => {
    expect([...COAT_NAMES]).toEqual(['black', 'grey', 'orange', 'white', 'blue'])
    for (const n of COAT_NAMES) for (const v of Object.values(COATS[n])) expect(v).toMatch(/^#[0-9a-f]{6}$/i)
  })
  it('isCoatName accepts only coat names', () => {
    for (const n of COAT_NAMES) expect(isCoatName(n)).toBe(true)
    for (const bad of ['', 'Black', 'purple', 5, null, undefined, {}, 'constructor', '__proto__']) expect(isCoatName(bad)).toBe(false)
  })
  it('converts sRGB hex to linear light', () => {
    expect(hexToLinear('#000000')).toEqual([0, 0, 0])
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1])
    const [r] = hexToLinear('#808080')
    expect(r).toBeCloseTo(0.2159, 3)
  })
  it('builds a palette that covers every colour index the parts use', () => {
    const pal = paletteFor(COATS.black)
    for (const part of PARTS) {
      const g = buildPart(part)
      let max = 0
      for (let k = 0; k < g.size[2]; k++) for (let j = 0; j < g.size[1]; j++) for (let i = 0; i < g.size[0]; i++) max = Math.max(max, g.get(i, j, k))
      expect(max, part).toBeLessThanOrEqual(pal.length)
    }
  })
})

describe('parts', () => {
  it.each(PARTS)('%s is a non-empty voxel body that meshes without error', (name) => {
    const g = buildPart(name)
    expect(g.count).toBeGreaterThanOrEqual(8)
    const m = meshFromGrid(g, paletteFor(COATS.black), { jitter: 0.05 })
    expect(m.indices.length).toBeGreaterThan(0)
    expect(m.positions.every(Number.isFinite)).toBe(true)
  })
  it('stays small enough to be cheap (whole cat well under 12k triangles)', () => {
    // torso + head + jaw + 2 ears + 4x(upper, lower, paw) + tail chain
    const count = (n: PartName): number => meshFromGrid(buildPart(n), paletteFor(COATS.black)).indices.length / 3
    const total =
      count('torso') + count('head') + count('jaw') + 2 * count('ear') + 2 * (count('frontUpper') + count('frontLower')) + 2 * (count('hindUpper') + count('hindLower')) + 4 * count('paw') + TAIL_SEGMENTS * count('tailSegment')
    expect(total).toBeLessThan(12000)
    expect(total).toBeGreaterThan(1500)
  })
  it('left/right symmetric parts really are mirror images', () => {
    for (const name of ['torso', 'head', 'jaw', 'ear', 'frontUpper', 'hindUpper', 'paw', 'tailSegment'] as const) {
      const g = buildPart(name)
      const [sx, sy, sz] = g.size
      // the lattice must be centred on x = 0 for the mirror to be exact
      expect(g.min[0] + sx / 2, name).toBe(0)
      let diff = 0
      for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) if (g.get(i, j, k) !== g.get(sx - 1 - i, j, k)) diff++
      expect(diff, name).toBe(0)
    }
  })
  it('the torso carries the white bib on its belly-front, and nowhere on the back', () => {
    const g = buildPart('torso')
    let bib = 0
    let backBib = 0
    for (let k = 0; k < g.size[2]; k++) for (let j = 0; j < g.size[1]; j++) for (let i = 0; i < g.size[0]; i++) {
      if (g.get(i, j, k) !== CHEST) continue
      const y = g.min[1] + j + 0.5
      bib++
      if (y > 0) backBib++
    }
    expect(bib).toBeGreaterThan(10)
    expect(backBib).toBe(0)
  })
  it('ears are pink on the inside only and have a fur tip', () => {
    const g = buildPart('ear')
    let pink = 0
    let fur = 0
    for (let k = 0; k < g.size[2]; k++) for (let j = 0; j < g.size[1]; j++) for (let i = 0; i < g.size[0]; i++) {
      const v = g.get(i, j, k)
      if (v === PINK) pink++
      if (v === FUR) fur++
    }
    expect(pink).toBeGreaterThan(3)
    expect(fur).toBeGreaterThan(pink)
    const topLayer = g.size[1] - 1
    for (let k = 0; k < g.size[2]; k++) for (let i = 0; i < g.size[0]; i++) expect(g.get(i, topLayer, k)).not.toBe(PINK)
  })
  it('leg bones are about as long as the skeleton says (the mesh covers its bone, with a little overlap)', () => {
    for (const [name, len] of [['frontUpper', BONES.front.upper], ['frontLower', BONES.front.lower], ['hindUpper', BONES.hind.upper], ['hindLower', BONES.hind.lower]] as const) {
      const g = buildPart(name)
      const top = g.min[1] + g.size[1]
      const bottom = g.min[1]
      expect(top, name).toBeGreaterThanOrEqual(0) // reaches the joint it hangs from
      expect(-bottom, name).toBeGreaterThanOrEqual(len - 0.01) // reaches the next joint
      expect(-bottom, name).toBeLessThanOrEqual(len + 1.5) // but does not poke far past it
    }
  })
})

describe('faceFrontZ', () => {
  it('finds the furthest-forward face voxel in the footprint, not just under one column', () => {
    const g = voxelize([{ kind: 'box', center: [0, 0, 0], radii: [3, 3, 3], color: 1 }, { kind: 'box', center: [1.5, 0.5, 4], radii: [0.5, 0.5, 1], color: 1 }])
    expect(faceFrontZ(g, 0, 0, 1)).toBe(3) // away from the bump: the block's front face
    expect(faceFrontZ(g, 1.5, 0.5, 1)).toBe(5) // bump sticks out to z = 5
    expect(faceFrontZ(g, 0.5, 0.5, 1.5)).toBe(5) // a wider footprint reaches it
  })
  it('returns -Infinity where nothing is there', () => {
    expect(faceFrontZ(voxelize([{ kind: 'box', center: [0, 0, 0], radii: [1, 1, 1], color: 1 }]), 20, 20)).toBe(-Infinity)
  })
  it('puts the eyes on the real head, in front of the skull but not floating', () => {
    const head = buildPart('head')
    for (const side of [1, -1]) {
      const z = faceFrontZ(head, side * 2.1, 2.7, 1)
      expect(z).toBeGreaterThan(4.5)
      expect(z).toBeLessThan(7)
    }
  })
})

describe('decoration glyphs', () => {
  it('the Z is a recognisable Z: top row, bottom row, a diagonal between', () => {
    const g = buildZGlyph()
    const row = (y: number): number => {
      let n = 0
      for (let i = 0; i < g.size[0]; i++) if (g.get(i, y, 0)) n++
      return n
    }
    expect([row(0), row(4)]).toEqual([5, 5])
    for (const y of [1, 2, 3]) expect(row(y)).toBe(1)
    expect(g.count).toBe(5 + 3 + 5)
  })
  it('an arc is a thin curved band opening toward +x', () => {
    const g = buildArc(6, 0.85)
    expect(g.count).toBeGreaterThan(8)
    for (let k = 0; k < g.size[2]; k++) for (let j = 0; j < g.size[1]; j++) for (let i = 0; i < g.size[0]; i++) {
      if (!g.get(i, j, k)) continue
      const x = g.min[0] + i + 0.5
      const y = g.min[1] + j + 0.5
      expect(Math.abs(Math.hypot(x, y) - 6)).toBeLessThanOrEqual(0.6)
      expect(x).toBeGreaterThan(0)
    }
  })
})
