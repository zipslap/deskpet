/** Pixel hit-testing for the click-through window. Pure functions so they can be unit-tested. */

/**
 * Union of the opaque pixels of every frame in one sheet row, dilated by one pixel so thin features
 * (whiskers, tail tip) are easy to grab. `rgba` is the whole sheet, `sheetWidth` px wide.
 */
export function buildRowMask(rgba: Uint8ClampedArray | Uint8Array, sheetWidth: number, row: number, frames: number, frame: number): Uint8Array {
  const m = new Uint8Array(frame * frame)
  for (let f = 0; f < frames; f++)
    for (let y = 0; y < frame; y++)
      for (let x = 0; x < frame; x++) {
        const i = ((row * frame + y) * sheetWidth + f * frame + x) * 4
        if ((rgba[i + 3] ?? 0) > 0) m[y * frame + x] = 1
      }
  const d = m.slice()
  for (let y = 0; y < frame; y++)
    for (let x = 0; x < frame; x++) {
      if (!m[y * frame + x]) continue
      if (x > 0) d[y * frame + x - 1] = 1
      if (x < frame - 1) d[y * frame + x + 1] = 1
      if (y > 0) d[(y - 1) * frame + x] = 1
      if (y < frame - 1) d[(y + 1) * frame + x] = 1
    }
  return d
}

/** Is the CSS-pixel point (x, y) inside the sprite's mask? `facing` -1 means the sprite is mirrored. */
export function maskHit(mask: Uint8Array, frame: number, scale: number, x: number, y: number, facing: 1 | -1): boolean {
  let px = Math.floor(x / scale)
  const py = Math.floor(y / scale)
  if (!(px >= 0 && py >= 0 && px < frame && py < frame)) return false
  if (facing === -1) px = frame - 1 - px
  return mask[py * frame + px] === 1
}
