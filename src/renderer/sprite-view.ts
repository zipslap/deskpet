import sheetUrl from '../../assets/sprites/cat.png?url'
import { buildRowMask, maskHit } from '../shared/hit-mask'
import type { Mode } from '../shared/brain'
import { ANIM_NAMES, animationFor, FRAME, ROWS, SCALE, SHEET_COLS, type AnimName } from '../shared/sprite'
import type { PetView } from './pet-view'

const BLEND_MS = 160
const MAX_LAYERS = 3

/** The original 2D sprite-sheet cat. Used when WebGL is unavailable (or chosen with `cat.view: "sprite"`). */
export function createSpriteView(host: HTMLElement): PetView {
  const root = document.documentElement.style
  root.setProperty('--frame', String(FRAME))
  root.setProperty('--scale', String(SCALE))
  root.setProperty('--cols', String(SHEET_COLS))
  root.setProperty('--rows', String(ANIM_NAMES.length))
  root.setProperty('--blend-ms', `${BLEND_MS}ms`)
  root.setProperty('--sheet-url', `url("${sheetUrl}")`)
  for (const name of ANIM_NAMES) {
    root.setProperty(`--${name}-row`, String(ROWS[name].row))
    root.setProperty(`--${name}-frames`, String(ROWS[name].frames))
    root.setProperty(`--${name}-ms`, String(ROWS[name].ms))
  }

  const sprite = document.createElement('div')
  sprite.id = 'sprite'
  sprite.className = 'sprite'
  sprite.setAttribute('role', 'img')
  sprite.setAttribute('aria-label', 'Desktop pet cat')
  const first = document.createElement('div')
  first.className = 'sheet anim-idle'
  sprite.append(first)
  host.append(sprite)

  let facing: 1 | -1 = 1
  let anim: AnimName = 'idle'

  /** Blend to a new animation: the new sheet slides underneath, the current one fades out above it and is then removed. */
  function switchAnimation(next: AnimName): void {
    const old = sprite.querySelector<HTMLElement>('.sheet:not(.fading)')
    const fresh = document.createElement('div')
    fresh.className = `sheet anim-${next}`
    sprite.prepend(fresh) // first child, so `#sprite .sheet` is always the current animation
    if (old) {
      old.classList.add('fading')
      setTimeout(() => old.remove(), BLEND_MS + 60)
    }
    // a burst of changes must not pile up layers: drop the oldest fading ones
    const layers = sprite.querySelectorAll('.sheet')
    for (let i = MAX_LAYERS; i < layers.length; i++) layers[i]!.remove()
  }

  // One mask per animation row = union of that row's frames, so hit-testing needs no knowledge of the current frame.
  const masks: Partial<Record<AnimName, Uint8Array>> = {}
  let disposed = false
  void (async () => {
    const img = new Image()
    img.src = sheetUrl
    await img.decode()
    if (disposed) return
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, img.width, img.height)
    for (const name of ANIM_NAMES) masks[name] = buildRowMask(data, img.width, ROWS[name].row, ROWS[name].frames, FRAME)
  })()

  return {
    kind: 'sprite',
    setState(mode: Mode, dir, dragging) {
      facing = dir
      const next = animationFor(mode)
      if (next !== anim) {
        switchAnimation(next)
        anim = next
      }
      sprite.dataset['mode'] = mode // for tests and debugging
      sprite.classList.toggle('dragging', dragging)
      sprite.classList.toggle('facing-left', dir === -1)
    },
    hit(x, y) {
      const m = masks[anim]
      return m ? maskHit(m, FRAME, SCALE, x, y, facing) : false
    },
    dispose() {
      disposed = true
      sprite.remove()
    }
  }
}
