import { describe, expect, it } from 'vitest'
import { growMask } from '../src/shared/grab-mask'

describe('growMask', () => {
  it('grows a single drawn pixel into a square of side 2r+1, clipped at the edges', () => {
    const n = 9
    const m = new Uint8Array(n * n)
    m[4 * n + 4] = 1
    const g = growMask(m, n, 2)
    let on = 0
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g[y * n + x]) {
      on++
      expect(Math.abs(x - 4) <= 2 && Math.abs(y - 4) <= 2).toBe(true)
    }
    expect(on).toBe(25)
    const corner = new Uint8Array(n * n)
    corner[0] = 1
    expect(growMask(corner, n, 2).reduce((a, b) => a + b, 0)).toBe(9)
  })
  it('r = 0 leaves the mask as it is, and never changes the input', () => {
    const m = new Uint8Array([0, 1, 0, 0])
    expect([...growMask(m, 2, 0)]).toEqual([0, 1, 0, 0])
    growMask(m, 2, 1)
    expect([...m]).toEqual([0, 1, 0, 0])
  })
})
