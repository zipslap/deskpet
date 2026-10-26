import { isCoatName } from '../shared/cat3d/cat-model'
import { parsePetSpec, type PetSpec } from '../shared/cat3d/pet-spec'
import type { Heading, Mode } from '../shared/brain'
import type { PetBadge, PetStateMessage } from '../shared/ipc'
import { createCat3D, type Cat3D } from './cat3d'
import { createFigure3D } from './figure3d'
import type { PetView } from './pet-view'
import { createSpriteView } from './sprite-view'

interface PetApi {
  onState(cb: (msg: PetStateMessage) => void): void
  onBadge(cb: (b: PetBadge) => void): void
  onSpec(cb: (spec: PetSpec | null) => void): void
  onPointer(cb: (x: number, y: number) => void): void
  setHover(over: boolean): void
  dragStart(): void
  dragMove(): void
  dragEnd(): void
  click(): void
  showContextMenu(): void
  e2e(cmd: string, arg?: unknown): void
}
declare global {
  interface Window {
    pet: PetApi
    /** Only with ?debug=1 (set by the main process for PET_DEBUG / test runs). */
    __cat3d?: Cat3D['debug'] & { view(): string; hit(x: number, y: number): boolean; spec(json: string): string }
  }
}

const host = document.getElementById('pet') as HTMLDivElement
const params = new URLSearchParams(location.search)

// ---------- which cat to draw ----------
let state: { mode: Mode; dir: 1 | -1; dragging: boolean; heading: Heading } = { mode: 'idle', dir: 1, dragging: false, heading: 'side' }
let view: PetView
let spec: PetSpec | null = null // the custom look, kept so it survives a fall-back to another view

function showSprite(): PetView {
  host.dataset['view'] = 'sprite'
  return createSpriteView(host)
}

function show3d(): PetView | null {
  const canvas = document.createElement('canvas')
  canvas.id = 'cat3d'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Desktop pet cat')
  host.append(canvas)
  const coat = params.get('coat')
  const pixel = Number(params.get('pixel') ?? 2) || 2
  // "figure" = the cat standing on two legs (the default); "3d" = the four-legged voxel cat
  const cat = params.get('view') === '3d' ? createCat3D(canvas, { ...(isCoatName(coat) ? { coat } : {}), pixel }) : createFigure3D(canvas, { pixel })
  if (!cat) {
    canvas.remove()
    return null
  }
  host.dataset['view'] = '3d'
  cat.setSpec?.(spec)
  cat.onLost = () => {
    // The GPU went away: carry on with the 2D sprite rather than freezing.
    view.dispose()
    view = showSprite()
    view.setState(state.mode, state.dir, state.dragging, state.heading)
  }
  if (params.get('debug') === '1') window.__cat3d = { ...cat.debug, view: () => view.kind, hit: (x, y) => view.hit(x, y),
      spec: (json) => {
        const r = parsePetSpec(JSON.parse(json))
        if ('error' in r) return r.error
        spec = r.spec
        view.setSpec?.(spec)
        return 'ok'
      }
    }
  return {
    kind: '3d',
    setState: (mode, dir, dragging, heading) => cat.setState(mode, dir, dragging, heading),
    ...(cat.setSpec ? { setSpec: (sp: PetSpec | null) => cat.setSpec!(sp) } : {}),
    hit: (x, y) => cat.hit(x, y),
    dispose: () => {
      cat.dispose()
      canvas.remove()
    }
  }
}

view = (params.get('view') !== 'sprite' ? show3d() : null) ?? showSprite()

window.pet.onSpec((next) => {
  spec = next
  view.setSpec?.(next)
  host.dataset['skin'] = next ? next.name : ''
})

window.pet.onState(({ mode, dir, dragging, heading }) => {
  state = { mode, dir, dragging, heading }
  view.setState(mode, dir, dragging, heading)
  host.dataset['mode'] = mode // for tests and debugging
  host.classList.toggle('dragging', dragging)
})

// ---------- status badge: the cat shows when it is watching, paused, or has something to ask ----------
const badge = document.getElementById('badge') as HTMLDivElement
window.pet.onBadge(({ watching, paused, nudge }) => {
  // a waiting nudge wins; then "paused because an excluded app is up"; then plain watching
  const [icon, label] = nudge ? ['❓', 'I noticed something: click me'] : paused ? ['⏸', 'Watching paused: an excluded app is on screen'] : watching ? ['👁', 'Watching on request rules (nothing is sent without your rules)'] : ['', '']
  badge.hidden = icon === ''
  badge.textContent = icon
  badge.title = label
  badge.setAttribute('aria-label', label)
  badge.dataset['kind'] = nudge ? 'nudge' : paused ? 'paused' : watching ? 'watching' : ''
})

// ---------- click-through: only opaque pixels of the cat capture the mouse ----------
const overPet = (clientX: number, clientY: number): boolean => view.hit(clientX, clientY)

let hover = false
function setHover(over: boolean): void {
  if (over === hover) return
  hover = over
  window.pet.setHover(over)
}

// Mouse moves are forwarded to us while the window is click-through, and the main process also reports the cursor
// whenever it is inside the window (forwarding is not reliable on the desktop layer). Leaving the window is detected by the
// main process too: Chromium fires a spurious "mouseleave" the moment the window stops being click-through, and reacting
// to it made the window click-through again before the click arrived, so clicks and drags fell through the cat.
let pressed = false
window.addEventListener('mousemove', (e) => {
  if (!pressed) setHover(overPet(e.clientX, e.clientY))
})
window.pet.onPointer((x, y) => {
  if (!pressed) setHover(overPet(x, y))
})

// ---------- click vs drag ----------
// A press that moves less than DRAG_THRESHOLD px is a click (opens the chat); more than that drags the pet.
const DRAG_THRESHOLD = 4
let press: { x: number; y: number } | null = null
let dragging = false

host.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !overPet(e.clientX, e.clientY)) return
  pressed = true
  press = { x: e.screenX, y: e.screenY }
  host.setPointerCapture(e.pointerId)
})
host.addEventListener('pointermove', (e) => {
  if (!press) return
  if (!dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) >= DRAG_THRESHOLD) {
    dragging = true
    window.pet.dragStart()
  }
  if (dragging) window.pet.dragMove()
})
function release(isClick: boolean): void {
  if (!press) return
  const wasDragging = dragging
  press = null
  dragging = false
  pressed = false
  if (wasDragging) window.pet.dragEnd()
  else if (isClick) window.pet.click()
}
host.addEventListener('pointerup', () => release(true))
host.addEventListener('pointercancel', () => release(false))
host.addEventListener('lostpointercapture', () => release(false))
window.addEventListener('blur', () => release(false))

// ---------- context menu (same actions as the tray, for when the menu bar is crowded) ----------
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (overPet(e.clientX, e.clientY)) window.pet.showContextMenu()
})
