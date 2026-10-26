import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildRowMask, maskHit } from '../src/shared/hit-mask'
import { ANIM_NAMES, FRAME, ROWS, SCALE } from '../src/shared/sprite'

/** Minimal decoder for the filter-0 RGBA PNGs written by tools/make-sprites.mjs. */
function decodePng(path: string): { w: number; h: number; rgba: Uint8Array } {
  const buf = readFileSync(path)
  let off = 8
  let w = 0
  let h = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
    } else if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    expect(raw[y * (w * 4 + 1)]).toBe(0) // filter type 0
    rgba.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4)
  }
  return { w, h, rgba }
}

const sheet = decodePng(new URL('../assets/sprites/cat.png', import.meta.url).pathname)
const mask = (name: (typeof ANIM_NAMES)[number]): Uint8Array => buildRowMask(sheet.rgba, sheet.w, ROWS[name].row, ROWS[name].frames, FRAME)
const idle = mask('idle')
const walk = mask('walk')
const css = (spritePx: number): number => spritePx * SCALE + SCALE / 2

describe('sprite sheet', () => {
  it('has the dimensions the metadata promises', () => {
    expect(sheet.h).toBe(FRAME * ANIM_NAMES.length)
    expect(sheet.w % FRAME).toBe(0)
  })
  it.each(ANIM_NAMES)('%s: every frame has a transparent corner and some opaque pixels', (name) => {
    const { row, frames } = ROWS[name]
    for (let f = 0; f < frames; f++) {
      expect(sheet.rgba[((row * FRAME) * sheet.w + f * FRAME) * 4 + 3]).toBe(0)
      let opaque = 0
      for (let y = 0; y < FRAME; y++) for (let x = 0; x < FRAME; x++) if (sheet.rgba[(((row * FRAME + y) * sheet.w) + f * FRAME + x) * 4 + 3]) opaque++
      expect(opaque).toBeGreaterThan(150)
    }
  })
  it('standing animations rest on the same ground line', () => {
    const lowest = (name: (typeof ANIM_NAMES)[number]): number => {
      let low = 0
      const { row, frames } = ROWS[name]
      for (let y = 0; y < FRAME; y++) for (let x = 0; x < frames * FRAME; x++) if (sheet.rgba[(((row * FRAME + y) * sheet.w) + x) * 4 + 3]) low = Math.max(low, y)
      return low
    }
    const ground = lowest('idle')
    for (const n of ANIM_NAMES) expect(lowest(n)).toBeLessThanOrEqual(ground) // nothing hangs below the paws
  })
})

describe('hit-testing', () => {
  it.each([
    ['idle', idle],
    ['walk', walk]
  ] as const)('%s: body is hit, corners are click-through', (_n, mask) => {
    expect(maskHit(mask, FRAME, SCALE, css(16), css(24), 1)).toBe(true) // middle of the body
    expect(maskHit(mask, FRAME, SCALE, css(1), css(1), 1)).toBe(false)
    expect(maskHit(mask, FRAME, SCALE, css(FRAME - 2), css(2), 1)).toBe(false)
    expect(maskHit(mask, FRAME, SCALE, css(2), css(FRAME - 2), 1)).toBe(false)
  })
  it('the sleeping pose is low: the standing head position is click-through', () => {
    expect(maskHit(mask('sleeping'), FRAME, SCALE, css(16), css(20), 1)).toBe(false)
    expect(maskHit(mask('sleeping'), FRAME, SCALE, css(16), css(31), 1)).toBe(true)
  })
  it('mirrors exactly when the pet faces left, and the mask is not symmetric', () => {
    let asymmetric = 0
    for (let y = 0; y < FRAME; y++)
      for (let x = 0; x < FRAME; x++) {
        const right = maskHit(idle, FRAME, SCALE, css(x), css(y), 1)
        expect(maskHit(idle, FRAME, SCALE, css(FRAME - 1 - x), css(y), -1)).toBe(right)
        if (right !== maskHit(idle, FRAME, SCALE, css(x), css(y), -1)) asymmetric++
      }
    expect(asymmetric).toBeGreaterThan(50) // mirroring really changes which pixels are hit
  })
  it('is false outside the window', () => {
    expect(maskHit(idle, FRAME, SCALE, -1, 10, 1)).toBe(false)
    expect(maskHit(idle, FRAME, SCALE, 10, FRAME * SCALE, 1)).toBe(false)
    expect(maskHit(idle, FRAME, SCALE, NaN, 10, 1)).toBe(false)
  })
})
