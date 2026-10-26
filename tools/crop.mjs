// node tools/crop.mjs in.png out.png col row cellW cellH [scale]  -- crop one cell of a contact sheet (for looking at details)
import { readFileSync, writeFileSync } from 'node:fs'
import { blit, decodePng, encodePng, newSheet } from './png.mjs'
const [inp, out, col, row, cw, ch, sc = '2'] = process.argv.slice(2)
const img = decodePng(readFileSync(inp))
const w = Number(cw), h = Number(ch), s = Number(sc)
const cell = { width: w, height: h, data: Buffer.alloc(w * h * 4) }
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) cell.data[(y * w + x) * 4 + k] = img.data[(((Number(row) * h + y) * img.width) + Number(col) * w + x) * 4 + k]
const sheet = newSheet(w * s, h * s, [0, 0, 0, 0])
blit(sheet, cell, 0, 0, s)
writeFileSync(out, encodePng(sheet))
