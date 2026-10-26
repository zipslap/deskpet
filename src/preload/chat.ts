import { contextBridge, ipcRenderer } from 'electron'
import { parseSnapshot, type ChatSnapshot } from '../shared/chat-types'
import { Channels } from '../shared/ipc'
import { parsePetUiState, type PetAction, type PetDesignRequest, type PetUiState } from '../shared/pet-types'
import { parseDataSnapshot, parseMemoryFile, type DataSnapshot } from '../shared/data-types'
import { parseScreenState, type ScreenUiState } from '../shared/screen-types'
import { parseTheme, type Theme } from '../shared/theme'
import { parseVoiceState, type VoiceUiState } from '../shared/voice-types'

// The chat panel can only: receive transcript/voice state and its saved look, send text, cancel, close itself,
// toggle the mic or mute, and propose a new look (validated and saved by the main process).
contextBridge.exposeInMainWorld('chat', {
  onSnapshot: (cb: (s: ChatSnapshot) => void): void => {
    ipcRenderer.on(Channels.chatSnapshot, (_e, payload: unknown) => {
      const s = parseSnapshot(payload)
      if (s) cb(s)
    })
  },
  onVoice: (cb: (s: VoiceUiState) => void): void => {
    ipcRenderer.on(Channels.chatVoice, (_e, payload: unknown) => {
      const s = parseVoiceState(payload)
      if (s) cb(s)
    })
  },
  onTheme: (cb: (t: Theme) => void): void => {
    ipcRenderer.on(Channels.chatTheme, (_e, payload: unknown) => {
      const t = parseTheme(payload)
      if (t) cb(t)
    })
  },
  onScreen: (cb: (s: ScreenUiState) => void): void => {
    ipcRenderer.on(Channels.chatScreen, (_e, payload: unknown) => {
      const s = parseScreenState(payload)
      if (s) cb(s)
    })
  },
  onRestore: (cb: (text: string) => void): void => {
    ipcRenderer.on(Channels.chatRestore, (_e, payload: unknown) => {
      if (typeof payload === 'string' && payload.length <= 20_000) cb(payload)
    })
  },
  onData: (cb: (d: DataSnapshot) => void): void => {
    ipcRenderer.on(Channels.chatData, (_e, payload: unknown) => {
      const d = parseDataSnapshot(payload)
      if (d) cb(d)
    })
  },
  onMemoryText: (cb: (file: string, text: string) => void): void => {
    ipcRenderer.on(Channels.chatMemoryText, (_e, payload: unknown) => {
      const p = payload as { file?: unknown; text?: unknown } | null
      const file = parseMemoryFile(p?.file)
      if (file && typeof p?.text === 'string') cb(file, p.text.slice(0, 8000))
    })
  },
  onPetState: (cb: (s: PetUiState) => void): void => {
    ipcRenderer.on(Channels.chatPetState, (_e, payload: unknown) => {
      const s = parsePetUiState(payload)
      if (s) cb(s)
    })
  },
  onPetShow: (cb: () => void): void => {
    ipcRenderer.on(Channels.chatPetShow, () => cb())
  },
  openPet: (): void => ipcRenderer.send(Channels.chatPetOpen),
  designPet: (req: PetDesignRequest): void => ipcRenderer.send(Channels.chatPetDesign, req),
  petAction: (a: PetAction): void => ipcRenderer.send(Channels.chatPetAction, a),
  openData: (): void => ipcRenderer.send(Channels.chatDataOpen),
  viewMemory: (file: string): void => ipcRenderer.send(Channels.chatMemoryView, file),
  deleteMemory: (file: string): void => ipcRenderer.send(Channels.chatMemoryDelete, file),
  clearSummary: (): void => ipcRenderer.send(Channels.chatSummaryClear),
  revealMemory: (): void => ipcRenderer.send(Channels.chatRevealMemory),
  onLayout: (cb: (collapsed: boolean) => void): void => {
    ipcRenderer.on(Channels.chatLayout, (_e, payload: unknown) => {
      const c = (payload as { collapsed?: unknown } | null)?.collapsed
      if (typeof c === 'boolean') cb(c)
    })
  },
  quit: (): void => ipcRenderer.send(Channels.chatQuit),
  toggleCollapse: (): void => ipcRenderer.send(Channels.chatCollapse),
  resizeStart: (): void => ipcRenderer.send(Channels.chatResizeStart),
  resizeBy: (dx: number, dy: number): void => ipcRenderer.send(Channels.chatResizeBy, { dx: Number(dx) || 0, dy: Number(dy) || 0 }),
  resizeEnd: (): void => ipcRenderer.send(Channels.chatResizeEnd),
  armScreen: (): void => ipcRenderer.send(Channels.chatArmScreen),
  toggleWatch: (): void => ipcRenderer.send(Channels.chatToggleWatch),
  nudgeLook: (): void => ipcRenderer.send(Channels.chatNudgeLook),
  nudgeDismiss: (): void => ipcRenderer.send(Channels.chatNudgeDismiss),
  setTheme: (t: Theme): void => ipcRenderer.send(Channels.chatSetTheme, t),
  setModel: (choice: { model?: string; effort?: string }): void => ipcRenderer.send(Channels.chatSetModel, choice),
  newChat: (): void => ipcRenderer.send(Channels.chatNew),
  ready: (): void => ipcRenderer.send(Channels.chatReady),
  mic: (): void => ipcRenderer.send(Channels.chatMic),
  mute: (): void => ipcRenderer.send(Channels.chatMute),
  openSettings: (): void => ipcRenderer.send(Channels.chatOpenSettings),
  send: (text: string): void => ipcRenderer.send(Channels.chatSend, String(text)),
  cancel: (): void => ipcRenderer.send(Channels.chatCancel),
  close: (): void => ipcRenderer.send(Channels.chatClose)
})
