import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { PetController, RoamMode } from './controller'
import { speakerLabel, type InstalledVoice } from '../services/voice/voice-catalog'

/** A voice picked from the menu. */
export type VoiceChoice = { engine: 'say'; sayVoice: string } | { engine: 'local'; model: string; sid: number }

export interface MenuActions {
  togglePause(): void
  toggleHidden(): void
  toggleChat(): void
  toggleListen(): void
  lookAtScreen(): void
  toggleWatch(): void
  toggleBringWithMe(): void
  toggleRoam(): void
  setRoam(mode: RoamMode): void
  toggleRest(): void
  restNow(): void
  toggleMute(): void
  testVoice(): void
  changePet(): void
  resetPet(): void
  setVoice(choice: VoiceChoice): void
  moreVoices(): void
  quit(): void
}

export interface VoiceChoices {
  engine: 'local' | 'say'
  /** Current local voice model id and speaker. */
  model: string
  sid: number
  /** Current macOS voice ("" = the system default). */
  sayVoice: string
  installed: InstalledVoice[]
  /** Names usable with `say -v`. */
  sayVoices: string[]
}

export interface VoiceMenuInfo {
  listening: boolean
  muted: boolean
  /** Shown (disabled) at the top: who answers. */
  assistant: string
  /** Screen access is switched on in settings (otherwise the menu item is hidden). */
  screenEnabled: boolean
  /** observe.enabled: the watch switch exists. */
  watchAvailable: boolean
  watching: boolean
  /** The cat is kept above other apps and on every Space. */
  bringWithMe: boolean
  /** Where he walks: around the window edges, anywhere on the desktop, or only along the bottom edge. */
  roam: RoamMode
  /** He rests at home when not in use. */
  restAtHome: boolean
  /** He is asleep right now. */
  resting: boolean
  voices: VoiceChoices
}

function voiceMenu(v: VoiceChoices, actions: MenuActions): MenuItemConstructorOptions {
  const sayItems: MenuItemConstructorOptions[] = [
    { label: 'System default', type: 'radio', checked: v.engine === 'say' && v.sayVoice === '', click: () => actions.setVoice({ engine: 'say', sayVoice: '' }) },
    ...v.sayVoices.map((name): MenuItemConstructorOptions => ({ label: name, type: 'radio', checked: v.engine === 'say' && v.sayVoice === name, click: () => actions.setVoice({ engine: 'say', sayVoice: name }) }))
  ]
  // local voices grouped by language, Kokoro (multilingual) first
  const groups = new Map<string, InstalledVoice[]>()
  for (const iv of v.installed) groups.set(iv.langName, [...(groups.get(iv.langName) ?? []), iv])
  const localItems: MenuItemConstructorOptions[] = [...groups.entries()]
    .sort(([a], [b]) => (a === 'Multilingual' ? -1 : b === 'Multilingual' ? 1 : a.localeCompare(b)))
    .map(([lang, list]): MenuItemConstructorOptions => ({
      label: lang,
      submenu: list.map((iv): MenuItemConstructorOptions => {
        const current = v.engine === 'local' && v.model === iv.id
        if (iv.speakers && iv.speakers.length > 1) {
          return {
            label: iv.label,
            type: 'checkbox',
            checked: current,
            submenu: iv.speakers.map((name, sid): MenuItemConstructorOptions => ({ label: speakerLabel(name), type: 'radio', checked: current && v.sid === sid, click: () => actions.setVoice({ engine: 'local', model: iv.id, sid }) }))
          }
        }
        return { label: iv.label, type: 'radio', checked: current, click: () => actions.setVoice({ engine: 'local', model: iv.id, sid: 0 }) }
      })
    }))
  return {
    label: 'Voice',
    submenu: [
      { label: `Local voices (${v.installed.length} installed)`, enabled: false },
      ...(localItems.length ? localItems : [{ label: 'None installed yet', enabled: false } as MenuItemConstructorOptions]),
      { label: 'Get more voices…', click: actions.moreVoices },
      { type: 'separator' },
      { label: process.platform === 'darwin' ? 'macOS voices' : 'System voices', submenu: sayItems }
    ]
  }
}

export function buildMenu(pet: PetController, actions: MenuActions, voice: VoiceMenuInfo): Menu {
  return Menu.buildFromTemplate([
    { label: voice.assistant, enabled: false },
    { type: 'separator' },
    { label: pet.isChatOpen ? 'Close chat' : 'Chat…', click: actions.toggleChat, enabled: !pet.isHidden },
    { label: voice.listening ? 'Stop listening' : 'Listen (push to talk)', click: actions.toggleListen, enabled: !pet.isHidden },
    ...(voice.screenEnabled ? [{ label: 'Look at my screen…', click: actions.lookAtScreen, enabled: !pet.isHidden }] : []),
    ...(voice.screenEnabled && voice.watchAvailable ? [{ label: voice.watching ? '👁 Stop watching (pause)' : 'Watch for my rules', click: actions.toggleWatch }] : []),
    { type: 'separator' },
    { label: voice.muted ? 'Unmute voice' : 'Mute voice', click: actions.toggleMute },
    { label: 'Change your pet…', click: actions.changePet, enabled: !pet.isHidden },
    { label: 'Reset pet to the default cat', click: actions.resetPet },
    { type: 'separator' },
    voiceMenu(voice.voices, actions),
    { label: 'Test voice', click: actions.testVoice },
    { type: 'separator' },
    // macOS only: elsewhere the pet is always above other windows
    ...(process.platform === 'darwin' ? [{ label: 'Bring the cat with me (over other apps)', type: 'checkbox' as const, checked: voice.bringWithMe, click: actions.toggleBringWithMe }] : []),
    { label: 'Rest at home when not in use', type: 'checkbox', checked: voice.restAtHome, click: actions.toggleRest },
    { label: 'Go home and rest now', click: actions.restNow, enabled: !pet.isHidden && !voice.resting && !pet.isChatOpen },
    {
      label: 'Where he walks',
      submenu: [
        ...(process.platform === 'darwin' ? [{ label: 'Around the edges of my windows', type: 'radio' as const, checked: voice.roam === 'edges', click: () => actions.setRoam('edges') }] : []),
        { label: 'Anywhere on the desktop', type: 'radio', checked: voice.roam === 'desktop', click: () => actions.setRoam('desktop') },
        { label: 'Only along the bottom', type: 'radio', checked: voice.roam === 'dock', click: () => actions.setRoam('dock') }
      ]
    },
    { label: pet.isPaused ? 'Resume walking' : 'Pause walking', click: actions.togglePause, enabled: !pet.isHidden },
    { label: pet.isHidden ? 'Show pet' : 'Hide pet', click: actions.toggleHidden },
    { type: 'separator' },
    { label: 'Quit', click: actions.quit }
  ])
}
