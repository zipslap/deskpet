import { contextBridge, ipcRenderer } from 'electron'
import { parsePetSpec, type PetSpec } from '../shared/cat3d/pet-spec'
import { Channels, parsePetBadge, parseStateMessage, type PetBadge, type PetStateMessage } from '../shared/ipc'

// The only surface the pet renderer gets: a handful of fixed, argument-light messages.
contextBridge.exposeInMainWorld('pet', {
  onState: (cb: (msg: PetStateMessage) => void): void => {
    ipcRenderer.on(Channels.state, (_e, payload: unknown) => {
      const msg = parseStateMessage(payload)
      if (msg) cb(msg)
    })
  },
  onSpec: (cb: (spec: PetSpec | null) => void): void => {
    ipcRenderer.on(Channels.petSpec, (_e, payload: unknown) => {
      if (payload === null) return cb(null)
      const r = parsePetSpec(payload)
      if ('spec' in r) cb(r.spec)
    })
  },
  onPointer: (cb: (x: number, y: number) => void): void => {
    ipcRenderer.on(Channels.pointer, (_e, payload: unknown) => {
      const p = payload as { x?: unknown; y?: unknown } | null
      if (typeof p?.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) cb(p.x, p.y)
    })
  },
  onBadge: (cb: (b: PetBadge) => void): void => {
    ipcRenderer.on(Channels.petBadge, (_e, payload: unknown) => {
      const b = parsePetBadge(payload)
      if (b) cb(b)
    })
  },
  e2e: (cmd: string, arg?: unknown): void => ipcRenderer.send(Channels.petE2E, { cmd: String(cmd), arg }),
  setHover: (over: boolean): void => ipcRenderer.send(Channels.hover, over === true),
  dragStart: (): void => ipcRenderer.send(Channels.dragStart),
  dragMove: (): void => ipcRenderer.send(Channels.dragMove),
  dragEnd: (): void => ipcRenderer.send(Channels.dragEnd),
  click: (): void => ipcRenderer.send(Channels.click),
  showContextMenu: (): void => ipcRenderer.send(Channels.contextMenu)
})
