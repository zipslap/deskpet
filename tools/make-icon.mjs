// Draws the app icon: a pixel-art cat tree / play house, 32x32 art scaled with hard edges to 1024 px, then builds
// assets/icon/deskpet.icns (needs macOS `sips` and `iconutil`). No dependencies.
//   node tools/make-icon.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from './png.mjs'

const N = 32
const px = Array.from({ length: N * N }, () => null)
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255]
const C = {
  sky: '#bfe3ff', sky2: '#a9d6fb', grass: '#7bbf5a', grass2: '#5e9f45', grassD: '#3f7a30',
  wood: '#d9a56b', woodL: '#ecc48f', woodD: '#a8743d', woodDD: '#7a4f26',
  rope: '#ead9a8', ropeD: '#c4a96a',
  roof: '#d9503f', roofL: '#ef7a5f', roofD: '#a43326',
  door: '#2a1e2c', doorL: '#47334a',
  cat: '#3b3f52', catL: '#5c6280', eye: '#f2dc4a', nose: '#e8879f', ear: '#cf8fa9', white: '#f1ede4',
  toy: '#e0457b', toyL: '#f7829f', string: '#6b5a48', outline: '#1d2a44'
}
const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) px[y * N + x] = c ? hex(C[c]) : null }
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c) }

// --- plate (a rounded square, like any app icon) with sky and a grassy floor
const R = 6
for (let y = 1; y < N - 1; y++)
  for (let x = 1; x < N - 1; x++) {
    const dx = Math.max(R + 1 - x, x - (N - 2 - R), 0)
    const dy = Math.max(R + 1 - y, y - (N - 2 - R), 0)
    if (dx * dx + dy * dy > R * R) continue
    set(x, y, y < 25 ? (y % 6 < 3 || y < 4 ? 'sky' : 'sky2') : y < 27 ? 'grass' : y < 29 ? 'grass2' : 'grassD')
  }
for (let x = 3; x < 29; x += 3) { set(x, 25, 'grass2'); set(x + 1, 24, 'grass') } // blades

// --- base platform (carpet) and the scratching post
rect(4, 23, 27, 25, 'wood'); rect(4, 23, 27, 23, 'woodL'); rect(4, 25, 27, 25, 'woodD'); rect(4, 26, 27, 26, 'woodDD')
rect(14, 14, 17, 22, 'rope')
for (let y = 15; y <= 22; y += 2) rect(14, y, 17, y, 'ropeD')
rect(13, 14, 13, 22, 'woodD'); rect(18, 14, 18, 22, 'woodD')

// --- lower shelf with a sleeping cat (a loaf) on it
rect(3, 19, 12, 20, 'wood'); rect(3, 19, 12, 19, 'woodL'); rect(3, 21, 12, 21, 'woodD')
rect(6, 17, 11, 18, 'cat'); rect(6, 17, 11, 17, 'catL') // body
rect(4, 16, 6, 18, 'cat'); set(4, 15, 'cat'); set(6, 15, 'cat'); set(5, 15, 'ear') // head with two ears
set(5, 17, 'eye'); set(12, 18, 'cat'); set(12, 17, 'cat') // eye, and the tail curling round

// --- the house on top: box, door, a cat looking out
rect(10, 7, 21, 13, 'wood'); rect(10, 7, 21, 7, 'woodL'); rect(10, 13, 21, 13, 'woodD')
rect(10, 7, 10, 13, 'woodL'); rect(21, 7, 21, 13, 'woodD')
rect(13, 9, 18, 13, 'door'); rect(14, 8, 17, 8, 'door'); set(13, 9, 'door')
rect(13, 10, 18, 13, 'cat'); rect(13, 10, 18, 10, 'catL') // head
set(13, 9, 'cat'); set(18, 9, 'cat'); set(14, 9, 'ear'); set(17, 9, 'ear') // ears
set(14, 11, 'eye'); set(17, 11, 'eye'); set(15, 12, 'nose'); set(16, 12, 'nose')

// --- hip roof
const widths = [[15, 16], [13, 18], [11, 20], [9, 22], [8, 23], [8, 23]]
widths.forEach(([a, b], k) => rect(a, 1 + k, b, 1 + k, k === 5 ? 'roofD' : k % 2 ? 'roof' : 'roofL'))
rect(8, 6, 23, 6, 'roofD')

// --- a toy on a string, and a pom-pom
rect(24, 7, 24, 13, 'string'); rect(23, 14, 25, 16, 'toy'); set(23, 14, 'toyL'); set(24, 15, 'toyL')

// --- scale up with hard edges and write the PNGs
function scaled(size) {
  const k = size / N
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = px[Math.floor(y / k) * N + Math.floor(x / k)]
      if (c) data.set(c, (y * size + x) * 4)
    }
  return encodePng({ width: size, height: size, data })
}
const out = new URL('../assets/icon/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'deskpet.png'), scaled(1024))
const set_ = join(out, 'deskpet.iconset')
rmSync(set_, { recursive: true, force: true })
mkdirSync(set_)
for (const s of [16, 32, 64, 128, 256, 512, 1024]) writeFileSync(join(set_, `tmp${s}.png`), scaled(s))
const names = { 16: ['icon_16x16'], 32: ['icon_16x16@2x', 'icon_32x32'], 64: ['icon_32x32@2x'], 128: ['icon_128x128'], 256: ['icon_128x128@2x', 'icon_256x256'], 512: ['icon_256x256@2x', 'icon_512x512'], 1024: ['icon_512x512@2x'] }
for (const [s, list] of Object.entries(names)) for (const n of list) writeFileSync(join(set_, `${n}.png`), scaled(Number(s)))
for (const s of Object.keys(names)) rmSync(join(set_, `tmp${s}.png`), { force: true })
execFileSync('iconutil', ['-c', 'icns', set_, '-o', join(out, 'deskpet.icns')])
rmSync(set_, { recursive: true, force: true })
console.log('wrote assets/icon/deskpet.png and deskpet.icns')
