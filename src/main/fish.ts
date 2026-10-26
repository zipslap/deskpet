import { BrowserWindow, nativeImage } from 'electron'
import { FISH, type Box } from '../shared/perimeter'
import { applyLevel } from './pet-window'

/** 14x8 pixel fish, facing left. '#' outline, '+' body, '-' belly, 'o' eye, '*' shine. */
const FISH_ART = [
  '....####....#.',
  '..##*+++#..##.',
  '.#+o+++++####.',
  '#++++++++++#..',
  '#-------+++#..',
  '.#-----+####..',
  '..##--+#..##..',
  '....####....#.'
]
const COLOURS: Record<string, [number, number, number]> = {
  '#': [24, 46, 74],
  '+': [92, 168, 222],
  '-': [196, 226, 244],
  o: [12, 14, 20],
  '*': [255, 255, 255]
}

/** The fish as a PNG data URL (built once). */
let fishPng = ''
function fishImage(): string {
  if (fishPng) return fishPng
  const w = FISH_ART[0]!.length
  const h = FISH_ART.length
  const buf = Buffer.alloc(w * h * 4)
  FISH_ART.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const c = COLOURS[ch]
      if (!c) return
      const i = (y * w + x) * 4
      buf[i] = c[2] // BGRA
      buf[i + 1] = c[1]
      buf[i + 2] = c[0]
      buf[i + 3] = 255
    })
  )
  fishPng = nativeImage.createFromBitmap(buf, { width: w, height: h }).toDataURL()
  return fishPng
}

function fishPage(flip: boolean): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
html,body{margin:0;background:transparent;overflow:hidden}
img{position:absolute;left:0;top:3px;width:28px;height:16px;image-rendering:pixelated;transform:scaleX(${flip ? -1 : 1});animation:flop 1.4s steps(2) infinite}
@keyframes flop{50%{top:1px}}
</style></head><body><img src="${fishImage()}" alt=""></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export interface FishOptions {
  /** Where a new fish can go (or null: nowhere free right now). */
  spot(): Promise<Box | null>
  /** He is free to go and eat (awake, wandering, not busy with you). */
  canForage(): boolean
  /** Above other apps ("bring the cat with me") or on the desktop with him. */
  bringWithMe(): boolean
  /** At most this many fish lie around at once. */
  max?: number
}

/**
 * Fish that turn up on bare bits of the desktop now and then, for the cat to go and eat: a reason to cross the desktop.
 * Each is a tiny click-through window on the same layer as the cat (so app windows cover it, just as they cover him).
 */
export class FishPond {
  private fish: Array<{ id: number; box: Box; win: BrowserWindow }> = []
  private nextId = 1
  private timer: NodeJS.Timeout | null = null
  private hidden = false

  constructor(private readonly opts: FishOptions) {}

  list(): Array<{ id: number; box: Box }> {
    return this.fish.map(({ id, box }) => ({ id, box }))
  }

  /** First fish soon after he wakes up, then one every so often. */
  start(firstMs = 8000): void {
    this.schedule(firstMs)
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    if (!this.hidden && this.opts.canForage() && this.fish.length < (this.opts.max ?? 2)) {
      const box = await this.opts.spot()
      if (box) this.add(box)
    }
    this.schedule(25_000 + Math.random() * 35_000)
  }

  private add(box: Box): void {
    const win = new BrowserWindow({
      x: box.x,
      y: box.y,
      width: FISH.w,
      height: FISH.h,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      type: 'panel',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false }
    })
    win.setIgnoreMouseEvents(true) // never in the way of a click
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    void win.loadURL(fishPage(Math.random() < 0.5))
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      applyLevel(win, this.opts.bringWithMe())
      if (!this.hidden) win.showInactive()
    })
    this.fish.push({ id: this.nextId++, box, win })
  }

  /** He ate it. */
  eaten(id: number): void {
    const i = this.fish.findIndex((f) => f.id === id)
    if (i < 0) return
    const [f] = this.fish.splice(i, 1)
    if (f && !f.win.isDestroyed()) f.win.destroy()
  }

  /** "Bring the cat with me" changed: the fish follow his layer. */
  applyLevel(): void {
    for (const f of this.fish) if (!f.win.isDestroyed()) applyLevel(f.win, this.opts.bringWithMe())
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden
    for (const f of this.fish) if (!f.win.isDestroyed()) (hidden ? f.win.hide() : f.win.showInactive())
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const f of this.fish) if (!f.win.isDestroyed()) f.win.destroy()
    this.fish = []
  }
}
