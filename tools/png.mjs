// Minimal PNG decode/encode (8-bit, non-interlaced RGB/RGBA) for the screenshot tools; no dependencies.
import { deflateSync, inflateSync } from 'node:zlib'

export function decodePng(buf) {
  let pos = 8
  let w = 0, h = 0, depth = 0, type = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const kind = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12] !== 0) throw new Error('interlaced PNG not supported') }
    else if (kind === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (depth !== 8 || (type !== 6 && type !== 2)) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`)
  const bpp = type === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(w * h * 4, 255)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      line[i] = v & 255
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < bpp; k++) out[(y * w + x) * 4 + k] = line[x * bpp + k]
    prev = line
  }
  return { width: w, height: h, data: out }
}

const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(kind, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Paste `img` into `sheet` at (ox, oy), scaled up by an integer factor with nearest-neighbour. */
export function blit(sheet, img, ox, oy, scale = 1) {
  for (let y = 0; y < img.height * scale; y++)
    for (let x = 0; x < img.width * scale; x++) {
      const sx = Math.floor(x / scale), sy = Math.floor(y / scale)
      const di = ((oy + y) * sheet.width + ox + x) * 4, si = (sy * img.width + sx) * 4
      if (ox + x < sheet.width && oy + y < sheet.height) for (let k = 0; k < 4; k++) sheet.data[di + k] = img.data[si + k]
    }
}
export const newSheet = (width, height, rgba) => { const data = Buffer.alloc(width * height * 4); for (let i = 0; i < width * height; i++) for (let k = 0; k < 4; k++) data[i * 4 + k] = rgba[k]; return { width, height, data } }
