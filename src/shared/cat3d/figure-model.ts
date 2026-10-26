/**
 * The standing figure: the black voxel cat (black fur, a small white blaze on the chest, pink inner ears, yellow eyes), with a
 * person's posture: upright on his hind legs, front legs used as arms, a slightly big head for expression.
 * Same conventions as cat-model.ts: voxel units, +y up, +z the way he faces, +x his left; each part's origin is its joint.
 */
import { CHEST, FUR, FUR_HI, PINK } from './cat-model'
import { voxelize, type Shape, type VoxelGrid } from './voxels'

const ell = (c: [number, number, number], r: [number, number, number], color: Shape['color']): Shape => ({ kind: 'ellipsoid', center: c, radii: r, color })
const box = (c: [number, number, number], r: [number, number, number], color: Shape['color']): Shape => ({ kind: 'box', center: c, radii: r, color })

/** Hip to sole. */
export const FIG_LEG = 5.4
/** Joint positions in the hips' frame (origin = hip pivot, between the legs). */
export const FIG_FRAME = {
  neck: 6.2,
  shoulderX: 2.1,
  shoulderY: 5.0,
  hipX: 1.2,
  tail: [0, 0.6, -1.6] as const,
  /** in the head's frame (origin = neck) */
  eyeX: 1.55,
  eyeY: 3.4,
  earX: 2.1,
  earY: 4.9
}

/** A small, uneven white blaze on the chest, like the cat in the picture: a patch with a little drip below it. */
const chest = (x: number, y: number, z: number): number => {
  if (z < 1.0) return FUR
  if (y > 3.9 && y < 5.0 && x > -0.9 && x < 0.9) return CHEST
  if (y > 3.0 && y < 3.9 && x > -0.9 && x < 0.1) return CHEST
  return FUR
}

export type FigurePart = 'torso' | 'head' | 'ear' | 'upperArm' | 'foreArm' | 'leg' | 'tailSegment' | 'phone'

export const FIGURE_SHAPES: Record<FigurePart, readonly Shape[]> = {
  torso: [
    ell([0, 1.0, -0.1], [2.3, 1.9, 2.0], FUR), // hips
    ell([0, 3.4, 0], [2.0, 2.8, 1.8], chest), // chest
    ell([0, 5.3, 0], [2.2, 1.0, 1.5], FUR) // shoulders
  ],
  head: [
    ell([0, 0.3, 0], [1.4, 1.2, 1.3], FUR), // neck
    ell([0, 3.2, 0.2], [3.5, 3.0, 3.0], FUR), // skull
    ell([2.3, 2.1, 1.2], [1.4, 1.2, 1.4], FUR), // cheeks
    ell([-2.3, 2.1, 1.2], [1.4, 1.2, 1.4], FUR),
    ell([0, 1.9, 2.5], [1.5, 1.0, 1.1], FUR_HI) // muzzle (the nose is a small separate piece, centred, in the renderer)
  ],
  // a slim pyramid with a pink inside, a bit taller than a real cat's
  ear: [
    box([0, 0.5, 0], [2.0, 0.5, 1.0], (x, _y, z) => (z > 0.1 && Math.abs(x) < 1.1 ? PINK : FUR)),
    box([0, 1.5, 0], [1.5, 0.5, 0.9], (x, _y, z) => (z > 0.1 && Math.abs(x) < 0.6 ? PINK : FUR)),
    box([0, 2.5, 0], [1.0, 0.5, 0.7], FUR),
    box([0, 3.5, 0], [0.5, 0.5, 0.5], FUR)
  ],
  upperArm: [ell([0, -1.2, 0], [0.95, 1.7, 0.95], FUR)],
  foreArm: [ell([0, -1.1, 0], [0.85, 1.5, 0.85], FUR), box([0, -2.4, 0.15], [0.9, 0.6, 0.9], FUR_HI)],
  // a cat's haunch on top, a slim shin, a long hind paw
  leg: [ell([0, -1.5, 0.2], [1.3, 2.0, 1.5], FUR), ell([0, -3.6, 0], [0.85, 1.7, 0.85], FUR), box([0, -FIG_LEG + 0.5, 0.7], [0.9, 0.5, 1.5], FUR_HI)],
  tailSegment: [ell([0, 0, 0.8], [0.95, 0.95, 1.1], FUR)],
  phone: [box([0, 0, 0], [0.9, 1.4, 0.3], PINK)]
}

export function buildFigurePart(name: FigurePart, shapes: readonly Shape[] = FIGURE_SHAPES[name]): VoxelGrid {
  return voxelize(shapes)
}
export const FIG_TAIL_SEGMENTS = 8
export const FIG_TAIL_LENGTH = 1.5
