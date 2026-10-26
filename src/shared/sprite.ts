import meta from '../../assets/sprites/cat.json'
import type { Mode } from './brain'

/** CSS pixels per sprite pixel. 2.5 = a 100 px window: small enough to sit beside your windows without getting in the way. */
export const SCALE = 2.5
export const FRAME = meta.frame
export const SHEET_COLS = meta.cols
export const ROWS = meta.rows
export type AnimName = keyof typeof meta.rows
export const ANIM_NAMES = Object.keys(meta.rows) as AnimName[]
/** The pet window is exactly one frame, scaled up. */
export const WINDOW_SIZE = FRAME * SCALE
/** Transparent pixels below the paws, so the window can overlap the work-area edge by this much. */
export const GROUND_MARGIN = Math.round(meta.groundMarginRows * SCALE)
/** How big the cat is drawn compared with the original 160 px cat (3D scale and walking speed follow it, so his feet still match the ground). */
export const CAT_ZOOM = WINDOW_SIZE / 160

/** Which sheet row a pet mode plays. Paused keeps breathing (idle). */
export function animationFor(mode: Mode): AnimName {
  switch (mode) {
    case 'walking':
      return 'walk'
    case 'curious':
    case 'eating': // the sprite and the four-legged cat have no eating pose: they look interested
      return 'curious'
    case 'listening':
      return 'listening'
    case 'thinking':
      return 'thinking'
    case 'speaking':
      return 'speaking'
    case 'sleeping':
      return 'sleeping'
    default:
      return 'idle'
  }
}
