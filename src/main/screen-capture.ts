import { desktopCapturer, nativeImage, screen } from 'electron'
import { appendFileSync, readFileSync } from 'node:fs'
import { GRID_H, GRID_W, type PixelSampler } from '../services/screen/observer'
import type { Capturer, ScreenImage } from '../services/screen/screen-service'
import type { Rect } from '../services/screen/rules'

/**
 * Captures one display with Electron's desktopCapturer (which uses the macOS Screen Recording permission of the app that
 * launched the pet). The picture is scaled down so its longest side is at most `maxEdge`, encoded as JPEG in memory, and
 * returned; nothing is written to disk.
 */
export class ElectronCapturer implements Capturer {
  async capture(bounds: Rect, maxEdge: number): Promise<ScreenImage | 'denied' | 'empty'> {
    const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h })
    const full = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    const k = Math.min(1, maxEdge / Math.max(full.width, full.height))
    const size = { width: Math.max(1, Math.round(full.width * k)), height: Math.max(1, Math.round(full.height * k)) }
    let sources
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    } catch {
      return 'denied'
    }
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return 'empty'
    const img = src.thumbnail
    const { width, height } = img.getSize()
    const thumb = img.resize({ width: 320, quality: 'good' })
    return {
      base64: img.toJPEG(80).toString('base64'),
      mime: 'image/jpeg',
      width,
      height,
      thumbDataUrl: `data:image/jpeg;base64,${thumb.toJPEG(60).toString('base64')}`
    }
  }
}

/** Test double (tests only, see PET_FAKE_CAPTURE): a flat blue picture, no screen access and no permission needed. */
export class FakeCapturer implements Capturer {
  calls = 0
  async capture(_bounds: Rect, maxEdge: number): Promise<ScreenImage> {
    this.calls++
    const w = Math.min(640, maxEdge)
    const h = Math.round(w * 0.6)
    const buf = Buffer.alloc(w * h * 4)
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 0x2a // BGRA
      buf[i + 1] = 0x7a
      buf[i + 2] = 0xd8
      buf[i + 3] = 0xff
    }
    const img = nativeImage.createFromBitmap(buf, { width: w, height: h })
    return {
      base64: img.toJPEG(70).toString('base64'),
      mime: 'image/jpeg',
      width: w,
      height: h,
      thumbDataUrl: `data:image/jpeg;base64,${img.resize({ width: 160 }).toJPEG(50).toString('base64')}`
    }
  }
}

/**
 * A 48x30 grey thumbnail of the display, for noticing that the screen changed. Taken at thumbnail size, compared in this
 * process and thrown away: it is never encoded, saved or sent.
 */
export class ElectronSampler implements PixelSampler {
  async sample(bounds: Rect): Promise<Uint8Array | null> {
    const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h })
    let sources
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: GRID_W * 4, height: GRID_H * 4 } })
    } catch {
      return null
    }
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return null
    const small = src.thumbnail.resize({ width: GRID_W, height: GRID_H, quality: 'good' })
    const bmp = small.toBitmap() // BGRA
    const out = new Uint8Array(GRID_W * GRID_H)
    for (let i = 0; i < out.length; i++) out[i] = Math.round(0.114 * bmp[i * 4]! + 0.587 * bmp[i * 4 + 1]! + 0.299 * bmp[i * 4 + 2]!)
    return out
  }
}

/** Test double: a flat grey whose level is read from a file (so a test can "change the screen"); each call is logged beside it. */
export class FakeSampler implements PixelSampler {
  constructor(private readonly file: string) {}
  async sample(): Promise<Uint8Array | null> {
    try {
      appendFileSync(`${this.file}.log`, 'sample\n')
      return new Uint8Array(GRID_W * GRID_H).fill(Number(readFileSync(this.file, 'utf8').trim()) || 0)
    } catch {
      return null
    }
  }
}
