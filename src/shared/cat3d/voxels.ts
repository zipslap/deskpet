/**
 * A tiny voxel engine for the 3D cat: shapes are voxelized into a grid, then turned into mesh data with hidden faces
 * removed and ambient occlusion baked into the vertex colours (the soft creases between blocks in voxel art).
 * Pure functions, no WebGL, so the geometry can be unit-tested.
 */

export type Vec3 = readonly [number, number, number]
/** Linear-space colour, 0..1. */
export type Rgb = readonly [number, number, number]

/** Palette index of a voxel, 1-based; 0 means empty. */
export type ColorFn = (x: number, y: number, z: number) => number

export interface Shape {
  kind: 'ellipsoid' | 'box'
  /** Centre in the part's local space (units = voxels). */
  center: Vec3
  /** Half-extents (box) or radii (ellipsoid). */
  radii: Vec3
  /** A palette index, or a function of the voxel centre (local space) returning one (0 = leave unchanged). */
  color: number | ColorFn
  /** Remove voxels instead of adding them. */
  carve?: boolean
}

export class VoxelGrid {
  private readonly cells: Uint8Array
  constructor(
    /** Local-space corner of voxel (0,0,0); always an integer so every part sits on the unit lattice. */
    readonly min: Vec3,
    readonly size: Vec3
  ) {
    this.cells = new Uint8Array(size[0] * size[1] * size[2])
  }
  private index(i: number, j: number, k: number): number {
    return (k * this.size[1] + j) * this.size[0] + i
  }
  inside(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.size[0] && j < this.size[1] && k < this.size[2]
  }
  get(i: number, j: number, k: number): number {
    return this.inside(i, j, k) ? this.cells[this.index(i, j, k)]! : 0
  }
  set(i: number, j: number, k: number, v: number): void {
    if (this.inside(i, j, k)) this.cells[this.index(i, j, k)] = v
  }
  get count(): number {
    let n = 0
    for (const c of this.cells) if (c) n++
    return n
  }
}

/** Rasterise shapes (painter's order: later shapes overwrite earlier ones) into a grid on the unit lattice. */
export function voxelize(shapes: readonly Shape[]): VoxelGrid {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const s of shapes) {
    if (s.carve) continue
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, s.center[a]! - s.radii[a]!)
      hi[a] = Math.max(hi[a]!, s.center[a]! + s.radii[a]!)
    }
  }
  if (!Number.isFinite(lo[0])) return new VoxelGrid([0, 0, 0], [1, 1, 1])
  const min: Vec3 = [Math.floor(lo[0]), Math.floor(lo[1]), Math.floor(lo[2])]
  const size: Vec3 = [Math.ceil(hi[0]) - min[0], Math.ceil(hi[1]) - min[1], Math.ceil(hi[2]) - min[2]]
  const grid = new VoxelGrid(min, size)
  for (const s of shapes) {
    for (let k = 0; k < size[2]; k++)
      for (let j = 0; j < size[1]; j++)
        for (let i = 0; i < size[0]; i++) {
          const x = min[0] + i + 0.5
          const y = min[1] + j + 0.5
          const z = min[2] + k + 0.5
          const dx = (x - s.center[0]) / s.radii[0]
          const dy = (y - s.center[1]) / s.radii[1]
          const dz = (z - s.center[2]) / s.radii[2]
          const inside = s.kind === 'ellipsoid' ? dx * dx + dy * dy + dz * dz <= 1 : Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1
          if (!inside) continue
          if (s.carve) grid.set(i, j, k, 0)
          else {
            const c = typeof s.color === 'number' ? s.color : s.color(x, y, z)
            if (c > 0) grid.set(i, j, k, c)
          }
        }
  }
  return grid
}

/** Build a grid from a predicate on voxel centres (local space): the palette index to place, or 0 for empty. */
export function voxelizeBy(min: Vec3, size: Vec3, fn: ColorFn): VoxelGrid {
  const grid = new VoxelGrid(min, size)
  for (let k = 0; k < size[2]; k++)
    for (let j = 0; j < size[1]; j++)
      for (let i = 0; i < size[0]; i++) grid.set(i, j, k, fn(min[0] + i + 0.5, min[1] + j + 0.5, min[2] + k + 0.5))
  return grid
}

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
}

/** Brightness of a vertex by how many neighbours crowd it: 0 = fully enclosed corner .. 3 = open. */
export const AO_LEVELS = [0.5, 0.68, 0.84, 1] as const

/** Deterministic 0..1 noise from a lattice position, for a little fur-like variation between neighbouring voxels. */
export function hash3(i: number, j: number, k: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export interface MeshOptions {
  /** Bake ambient occlusion into vertex colours. Default true. */
  ao?: boolean
  /** Per-voxel brightness variation, e.g. 0.06 = ±6 %. Default 0. */
  jitter?: number
}

// For each of the six face directions: the axis it points along, its sign, and the two tangent axes.
const FACES: ReadonlyArray<{ axis: 0 | 1 | 2; sign: 1 | -1; u: 0 | 1 | 2; v: 0 | 1 | 2 }> = [
  { axis: 0, sign: 1, u: 1, v: 2 },
  { axis: 0, sign: -1, u: 2, v: 1 },
  { axis: 1, sign: 1, u: 2, v: 0 },
  { axis: 1, sign: -1, u: 0, v: 2 },
  { axis: 2, sign: 1, u: 0, v: 1 },
  { axis: 2, sign: -1, u: 1, v: 0 }
]

/**
 * Turn a grid into triangles. Only faces that border an empty cell are emitted. Each vertex gets the voxel's palette colour
 * times its ambient-occlusion level, so blocks look softly shaded where they meet. `palette[v - 1]` colours voxel value v.
 * Triangles are counter-clockwise seen from outside.
 */
export function meshFromGrid(grid: VoxelGrid, palette: readonly Rgb[], opts: MeshOptions = {}): MeshData {
  const useAo = opts.ao !== false
  const jitter = opts.jitter ?? 0
  const pos: number[] = []
  const nor: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const [sx, sy, sz] = grid.size
  const cell: [number, number, number] = [0, 0, 0]
  const occ = (base: readonly number[], da: readonly number[]): number => (grid.get(base[0]! + da[0]!, base[1]! + da[1]!, base[2]! + da[2]!) ? 1 : 0)

  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) {
        const v = grid.get(i, j, k)
        if (!v) continue
        cell[0] = i
        cell[1] = j
        cell[2] = k
        const rgb = palette[v - 1] ?? [1, 0, 1]
        const jit = jitter ? 1 + jitter * (hash3(i + grid.min[0], j + grid.min[1], k + grid.min[2]) * 2 - 1) : 1
        for (const f of FACES) {
          const n = [0, 0, 0]
          n[f.axis] = f.sign
          if (grid.get(i + n[0]!, j + n[1]!, k + n[2]!)) continue // hidden by a neighbour
          // The face plane sits at +1 along the axis for a positive face, 0 for a negative one.
          const corners: Array<[number, number, number]> = []
          const levels: number[] = []
          for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
            const p: [number, number, number] = [i + grid.min[0], j + grid.min[1], k + grid.min[2]]
            p[f.axis] += f.sign > 0 ? 1 : 0
            p[f.u] += cu > 0 ? 1 : 0
            p[f.v] += cv > 0 ? 1 : 0
            corners.push(p)
            let lvl = 3
            if (useAo) {
              const du = [0, 0, 0]
              const dv = [0, 0, 0]
              const duv = [0, 0, 0]
              du[f.axis] = f.sign
              dv[f.axis] = f.sign
              duv[f.axis] = f.sign
              du[f.u] = cu
              dv[f.v] = cv
              duv[f.u] = cu
              duv[f.v] = cv
              const s1 = occ(cell, du)
              const s2 = occ(cell, dv)
              const c = occ(cell, duv)
              lvl = s1 && s2 ? 0 : 3 - (s1 + s2 + c)
            }
            levels.push(lvl)
          }
          const base = pos.length / 3
          for (let c = 0; c < 4; c++) {
            const p = corners[c]!
            pos.push(p[0], p[1], p[2])
            nor.push(n[0]!, n[1]!, n[2]!)
            const b = AO_LEVELS[levels[c]!]! * jit
            col.push(rgb[0] * b, rgb[1] * b, rgb[2] * b)
          }
          // FACES lists tangents so that u x v points along the outward normal, hence corners (-,-) (+,-) (+,+) (-,+) run counter-clockwise.
          // Split along the diagonal that keeps the AO gradient smooth.
          const flip = levels[0]! + levels[2]! < levels[1]! + levels[3]!
          const quad = flip ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3]
          for (let t = 0; t < 6; t += 3) {
            const a = base + quad[t]!
            const b = base + quad[t + 1]!
            const c = base + quad[t + 2]!
            idx.push(a, b, c)
          }
        }
      }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors: new Float32Array(col), indices: new Uint32Array(idx) }
}
