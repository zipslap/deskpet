/**
 * The click mask around the cat: every drawn pixel, grown by `r` pixels in every direction (a square, done as two cheap passes),
 * so he is easy to grab: a click just beside an ear, a paw or the tail still counts. `mask` is size*size, 1 = drawn.
 */
export function growMask(mask: Uint8Array, size: number, r: number): Uint8Array<ArrayBuffer> {
  if (r <= 0) return mask.slice()
  const rows = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    let last = -Infinity // the nearest drawn pixel to the left (or under the cursor)
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x]) last = x
      if (x - last <= r) rows[y * size + x] = 1
    }
    last = Infinity
    for (let x = size - 1; x >= 0; x--) {
      if (mask[y * size + x]) last = x
      if (last - x <= r) rows[y * size + x] = 1
    }
  }
  const out = new Uint8Array(size * size)
  for (let x = 0; x < size; x++) {
    let last = -Infinity
    for (let y = 0; y < size; y++) {
      if (rows[y * size + x]) last = y
      if (y - last <= r) out[y * size + x] = 1
    }
    last = Infinity
    for (let y = size - 1; y >= 0; y--) {
      if (rows[y * size + x]) last = y
      if (last - y <= r) out[y * size + x] = 1
    }
  }
  return out
}
