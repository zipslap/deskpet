import type { Dir, Heading, Mode } from './brain'

/** Every IPC channel the app uses. Renderers can only reach these through their preload bridges. */
export const Channels = {
  // pet window
  state: 'pet:state', // main -> pet renderer
  hover: 'pet:hover', // pet renderer -> main (boolean: pointer is over a visible sprite pixel)
  pointer: 'pet:pointer', // main -> pet renderer: { x, y } the cursor, in window coordinates, while it is inside the pet window
  dragStart: 'pet:drag-start',
  dragMove: 'pet:drag-move',
  dragEnd: 'pet:drag-end',
  click: 'pet:click',
  contextMenu: 'pet:context-menu',
  // chat window
  chatSnapshot: 'chat:snapshot', // main -> chat renderer
  chatReady: 'chat:ready', // chat renderer -> main: "send me the current snapshot"
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatClose: 'chat:close',
  chatVoice: 'chat:voice', // main -> chat renderer: VoiceUiState
  chatMic: 'chat:mic', // toggle listening
  chatMute: 'chat:mute', // toggle spoken replies
  chatOpenSettings: 'chat:open-settings', // open the System Settings pane for the last permission error
  chatTheme: 'chat:theme', // main -> chat renderer: the saved Theme
  chatSetTheme: 'chat:set-theme', // chat renderer -> main: a new Theme to validate and save
  chatSetModel: 'chat:set-model', // chat renderer -> main: { model?, effort? }
  chatNew: 'chat:new', // chat renderer -> main: start a fresh conversation
  chatScreen: 'chat:screen', // main -> chat renderer: ScreenUiState
  chatArmScreen: 'chat:arm-screen', // chat renderer -> main: toggle "attach a screenshot to my next message"
  chatRestore: 'chat:restore', // main -> chat renderer: put this text back in the message box (a send that did not go through)
  chatToggleWatch: 'chat:toggle-watch', // chat renderer -> main: watching on/off
  chatNudgeLook: 'chat:nudge-look', // chat renderer -> main: "yes, look" on a pending nudge
  chatNudgeDismiss: 'chat:nudge-dismiss', // chat renderer -> main: dismiss a pending nudge
  chatData: 'chat:data', // main -> chat renderer: DataSnapshot (the data drawer)
  chatDataOpen: 'chat:data-open', // chat renderer -> main: send me the DataSnapshot
  chatMemoryView: 'chat:memory-view', // chat renderer -> main: a memory file name
  chatMemoryText: 'chat:memory-text', // main -> chat renderer: { file, text }
  chatMemoryDelete: 'chat:memory-delete', // chat renderer -> main: a memory file name (moved to the Trash)
  chatSummaryClear: 'chat:summary-clear', // chat renderer -> main: forget the conversation summary
  chatRevealMemory: 'chat:reveal-memory', // chat renderer -> main: show the memory folder in Finder
  chatLayout: 'chat:layout', // main -> chat renderer: { collapsed }
  chatQuit: 'chat:quit', // chat renderer -> main: quit the whole app ("put him away")
  chatCollapse: 'chat:collapse', // chat renderer -> main: minimise / restore the panel
  chatResizeStart: 'chat:resize-start', // chat renderer -> main: the corner grip was pressed
  chatResizeBy: 'chat:resize-by', // chat renderer -> main: { dx, dy } since the press
  chatResizeEnd: 'chat:resize-end',
  chatPetOpen: 'chat:pet-open', // chat renderer -> main: send me the PetUiState (the "change your pet" drawer)
  chatPetShow: 'chat:pet-show', // main -> chat renderer: open the "change your pet" drawer
  chatPetState: 'chat:pet-state', // main -> chat renderer: PetUiState
  chatPetDesign: 'chat:pet-design', // chat renderer -> main: PetDesignRequest (instructions + images)
  chatPetAction: 'chat:pet-action', // chat renderer -> main: PetAction (undo / reset / preset)
  petSpec: 'pet:spec', // main -> pet renderer: the pet spec to draw (or null for the default)
  petBadge: 'pet:badge', // main -> pet renderer: PetBadge
  petE2E: 'pet:e2e' // pet renderer -> main: test commands; the main process ignores it unless PET_E2E=1
} as const

export interface PetStateMessage {
  mode: Mode
  dir: Dir
  /** Walking up or down the screen (he faces you, or turns his back), or sideways. */
  heading: Heading
  dragging: boolean
}

export const MODES: readonly Mode[] = ['idle', 'walking', 'eating', 'curious', 'listening', 'thinking', 'speaking', 'sleeping', 'paused']
/** Longest message the chat panel will accept. */
export const MAX_MESSAGE_CHARS = 20_000

/** Validates untrusted data (used on the renderer side for messages from main, and in tests). */
export function parseStateMessage(v: unknown): PetStateMessage | null {
  if (typeof v !== 'object' || v === null) return null
  const { mode, dir, dragging, heading } = v as Record<string, unknown>
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return null
  if (dir !== 1 && dir !== -1) return null
  if (typeof dragging !== 'boolean') return null
  const h: Heading = heading === 'toward' || heading === 'away' ? heading : 'side'
  return { mode: mode as Mode, dir, heading: h, dragging }
}

/** The hover payload must be exactly a boolean. */
export const parseHover = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** A chat message from the renderer: a non-empty string of bounded length, trimmed. */
export function parseChatText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= MAX_MESSAGE_CHARS ? t : null
}

/** The small status marker on the pet: watching, paused because of an excluded app, or a nudge waiting. */
export interface PetBadge {
  watching: boolean
  paused: boolean
  nudge: boolean
}

export function parsePetBadge(v: unknown): PetBadge | null {
  if (typeof v !== 'object' || v === null) return null
  const { watching, paused, nudge } = v as Record<string, unknown>
  return typeof watching === 'boolean' && typeof paused === 'boolean' && typeof nudge === 'boolean' ? { watching, paused, nudge } : null
}
