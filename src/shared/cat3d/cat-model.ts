/**
 * The 3D cat, described as voxel parts plus the dimensions the skeleton uses.
 * Conventions (everything in voxel units): +y up, +z the way the cat faces, +x the cat's left.
 * The torso's local origin is the hip pivot; the head's is the neck; each ear/leg/tail part has its own origin at its joint.
 * Parts are built once, meshed once, and then only moved by the rig.
 */
import { voxelize, voxelizeBy, type Rgb, type Shape, type VoxelGrid } from './voxels'

// ---------- colours ----------
/** Palette indices (1-based, as stored in the voxel grids). */
export const FUR = 1
export const FUR_HI = 2
export const CHEST = 3
export const PINK = 4
export const NOSE = 5
export const MOUTH = 6
export const GLYPH = 7

export const COAT_NAMES = ['black', 'grey', 'orange', 'white', 'blue'] as const
export type CoatName = (typeof COAT_NAMES)[number]

export interface Coat {
  fur: string
  furHi: string
  chest: string
  pink: string
  nose: string
  mouth: string
  eye: string
  pupil: string
}

/** sRGB hex strings. The default is the black cat with a white bib. */
export const COATS: Record<CoatName, Coat> = {
  black: { fur: '#4b5068', furHi: '#7c86a8', chest: '#ece9e2', pink: '#cf8fa9', nose: '#e0809a', mouth: '#c4607d', eye: '#f0d94a', pupil: '#0b0b0f' },
  grey: { fur: '#7d8693', furHi: '#9aa3b0', chest: '#f1f1ee', pink: '#e2a0b4', nose: '#e58ea3', mouth: '#c96f88', eye: '#9fd14a', pupil: '#101216' },
  orange: { fur: '#d8873a', furHi: '#ecaa62', chest: '#fbf0dc', pink: '#e9a0a0', nose: '#e58a8a', mouth: '#c4607d', eye: '#6fb04a', pupil: '#141008' },
  white: { fur: '#e9e8e6', furHi: '#f8f7f5', chest: '#ffffff', pink: '#f0b0c0', nose: '#ec9aab', mouth: '#d2788f', eye: '#5aa7e0', pupil: '#101216' },
  blue: { fur: '#4f7bd8', furHi: '#76a0ee', chest: '#e8f0ff', pink: '#ee9fb6', nose: '#f08aa3', mouth: '#c4607d', eye: '#ffe066', pupil: '#0b0d18' }
}

export function isCoatName(v: unknown): v is CoatName {
  return typeof v === 'string' && (COAT_NAMES as readonly string[]).includes(v)
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** '#rrggbb' -> linear-light [r, g, b] in 0..1 (what the renderer's vertex colours expect). */
export function hexToLinear(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)]
}

export function paletteFor(coat: Coat): Rgb[] {
  return [coat.fur, coat.furHi, coat.chest, coat.pink, coat.nose, coat.mouth].map(hexToLinear).concat([hexToLinear('#ffffff')])
}

// ---------- skeleton dimensions ----------
export const BONES = {
  /** Upper and lower bone lengths of the front and hind legs. */
  front: { upper: 5.5, lower: 6.5 },
  hind: { upper: 6, lower: 6.5 },
  /** Distance between the ground and the ankle when a foot is planted (the paw is this tall). */
  ankle: 1.6
} as const

/** Joint positions in the torso's frame (origin = hip pivot). */
export const TORSO_FRAME = {
  /** Where the neck/head attaches. */
  neck: [0, 2.2, 13.5],
  shoulderX: 3.3,
  shoulderY: -1.7,
  shoulderZ: 12.0,
  hipX: 3.6,
  hipY: -0.5,
  hipZ: 1.0,
  /** Tail root. */
  tail: [0, 0.8, -1.2]
} as const

/** Positions in the head's frame (origin = neck). */
export const HEAD_FRAME = {
  earX: 2.35,
  earY: 4.9,
  earZ: 1.5,
  eyeX: 2.1,
  eyeY: 2.7,
  eyeZ: 5.35,
  jaw: [0, 0.2, 3.9]
} as const

export const TAIL_SEGMENTS = 7
export const TAIL_SEGMENT_LENGTH = 1.9

// ---------- parts ----------
const ell = (c: [number, number, number], r: [number, number, number], color: Shape['color']): Shape => ({ kind: 'ellipsoid', center: c, radii: r, color })
const box = (c: [number, number, number], r: [number, number, number], color: Shape['color']): Shape => ({ kind: 'box', center: c, radii: r, color })

/** White bib on the front of the chest (on the belly side, which faces forward when the cat sits up). */
const torsoColor = (x: number, y: number, z: number): number => {
  if (y < -1.1 && z > 7.6 && z < 14.5 && Math.abs(x) < 1.7 + Math.max(0, z - 12) * 0.5) return CHEST
  if (y < -2.2) return FUR_HI
  return FUR
}

export type PartName = 'torso' | 'head' | 'jaw' | 'ear' | 'frontUpper' | 'frontLower' | 'hindUpper' | 'hindLower' | 'paw' | 'tailSegment'

export const PART_SHAPES: Record<PartName, readonly Shape[]> = {
  torso: [
    ell([0, 0.5, 6.6], [4.9, 4.4, 7.8], torsoColor),
    ell([0, 0.1, 12.0], [3.8, 4.1, 3.4], torsoColor), // chest
    ell([0, 0.9, 2.2], [4.5, 4.0, 3.7], FUR) // rump
  ],
  head: [
    ell([0, 0.1, -0.2], [3.3, 3.0, 2.8], FUR), // neck, overlaps the chest
    ell([0, 2.0, 2.2], [4.6, 3.7, 3.7], FUR), // skull
    ell([3.1, 0.5, 3.0], [2.0, 1.6, 1.7], FUR_HI), // cheeks
    ell([-3.1, 0.5, 3.0], [2.0, 1.6, 1.7], FUR_HI),
    ell([0, 0.8, 5.3], [2.2, 1.6, 1.3], FUR_HI), // muzzle
    box([0, 1.5, 6.5], [0.5, 0.5, 0.5], NOSE)
  ],
  jaw: [ell([0, -0.6, 1.4], [1.9, 1.0, 1.8], (_x, y) => (y > 0 ? MOUTH : FUR_HI))],
  // Ears: a slim pyramid pointing up (+y), pink only on a small inner triangle facing forward.
  ear: [
    box([0, 0.5, 0], [1.7, 0.5, 1.0], (x, _y, z) => (z > 0.2 && Math.abs(x) < 0.9 ? PINK : FUR)),
    box([0, 1.5, 0], [1.4, 0.5, 0.9], (x, _y, z) => (z > 0.2 && Math.abs(x) < 0.9 ? PINK : FUR)),
    box([0, 2.5, 0], [1.0, 0.5, 0.8], (x, _y, z) => (z > 0.2 && Math.abs(x) < 0.5 ? PINK : FUR)),
    box([0, 3.5, 0], [0.7, 0.5, 0.65], FUR),
    box([0, 4.5, 0], [0.4, 0.5, 0.5], FUR),
    box([0, 5.5, 0], [0.4, 0.5, 0.4], FUR)
  ],
  // Bones hang straight down from their joint (local -y), so a bone's angle is just a rotation about x.
  frontUpper: [ell([0, -2.75, 0], [1.9, 3.5, 2.0], FUR)],
  frontLower: [ell([0, -3.0, 0], [1.6, 3.5, 1.7], FUR)],
  hindUpper: [ell([0, -2.5, 0.4], [2.7, 4.2, 3.0], FUR)],
  hindLower: [ell([0, -3.2, 0], [1.5, 3.7, 1.6], FUR)],
  paw: [box([0, 0.7, 0.7], [1.5, 0.7, 1.6], FUR_HI)],
  tailSegment: [ell([0, 0, 0.8], [1.4, 1.4, 1.5], FUR)]
}

export function buildPart(name: PartName): VoxelGrid {
  return voxelize(PART_SHAPES[name])
}

/**
 * z of the head's front surface over a small footprint around (x, y) in head space, so the eyes can sit flush on the blocky
 * face instead of being half buried in it. Returns the furthest-forward voxel face in that footprint.
 */
export function faceFrontZ(head: VoxelGrid, x: number, y: number, reach = 1): number {
  let best = -Infinity
  for (let k = 0; k < head.size[2]; k++)
    for (let j = 0; j < head.size[1]; j++)
      for (let i = 0; i < head.size[0]; i++) {
        if (!head.get(i, j, k)) continue
        const cx = head.min[0] + i + 0.5
        const cy = head.min[1] + j + 0.5
        if (Math.abs(cx - x) <= reach && Math.abs(cy - y) <= reach) best = Math.max(best, head.min[2] + k + 1)
      }
  return best
}

// ---------- decoration (thought dots, sleep Zs, sound waves) ----------
const Z_PATTERN = ['#####', '...#.', '..#..', '.#...', '#####']

/** A chunky "Z", one voxel deep, centred on the origin. */
export function buildZGlyph(): VoxelGrid {
  return voxelizeBy([-3, -2, 0], [5, 5, 1], (x, y) => {
    const col = Math.round(x + 2.5)
    const row = Math.round(2.5 - y)
    return Z_PATTERN[row]?.[col] === '#' ? GLYPH : 0
  })
}

/** An arc of a ring in the xy plane, opening toward +x: radius `r`, thickness about one voxel, `half` radians either side. */
export function buildArc(r: number, half: number): VoxelGrid {
  const n = Math.ceil(r + 1)
  return voxelizeBy([0, -n, 0], [n, 2 * n, 1], (x, y) => {
    const d = Math.hypot(x, y)
    return Math.abs(d - r) <= 0.6 && Math.abs(Math.atan2(y, x)) <= half ? GLYPH : 0
  })
}
