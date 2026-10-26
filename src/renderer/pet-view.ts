import type { Heading, Mode } from '../shared/brain'
import type { PetSpec } from '../shared/cat3d/pet-spec'

/** What the pet page draws: the 3D cat, or the 2D sprite as a fallback. Input handling lives in main.ts and only needs these. */
export interface PetView {
  kind: '3d' | 'sprite'
  /** `heading`: walking down towards you / up away from you (only the standing figure shows it). */
  setState(mode: Mode, dir: 1 | -1, dragging: boolean, heading?: Heading): void
  /** Is the CSS-pixel point (relative to the pet window) over a visible pixel of the pet? */
  hit(x: number, y: number): boolean
  /** Restyle from a pet spec; absent on views that cannot (the four-legged cat, the sprite). */
  setSpec?(spec: PetSpec | null): void
  dispose(): void
}
