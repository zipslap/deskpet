import { EMPTY_SETUP_UI, type SetupProvider, type SetupRequest, type SetupUiState, type VoicePack } from '../shared/setup-types'
import { MAX_PET_IMAGES, PET_IMAGE_EDGE, EMPTY_PET_UI, type PetAction, type PetDesignRequest, type PetImage, type PetUiState } from '../shared/pet-types'
import { MAX_MESSAGE_CHARS } from '../shared/ipc'
import type { ChatSnapshot } from '../shared/chat-types'
import { IDLE_VOICE_STATE, type VoiceUiState } from '../shared/voice-types'
import { IDLE_SCREEN_STATE, type ScreenUiState } from '../shared/screen-types'
import { EMPTY_DATA, type DataSnapshot } from '../shared/data-types'
import { DEFAULT_THEME, THEME_LIMITS, type Theme } from '../shared/theme'
import { drawGrass } from './grass'
import { installPixelShapes, setIcon } from './pixel-ui'
import { renderMarkdown } from './markdown'
import { applyTheme, currentTheme, swatchColor } from './theme-apply'

interface ChatApi {
  onSnapshot(cb: (s: ChatSnapshot) => void): void
  onVoice(cb: (s: VoiceUiState) => void): void
  ready(): void
  send(text: string): void
  cancel(): void
  close(): void
  mic(): void
  mute(): void
  openSettings(): void
  onTheme(cb: (t: Theme) => void): void
  setTheme(t: Theme): void
  setModel(choice: { model?: string; effort?: string }): void
  newChat(): void
  onScreen(cb: (s: ScreenUiState) => void): void
  onRestore(cb: (text: string) => void): void
  armScreen(): void
  onLayout(cb: (collapsed: boolean) => void): void
  toggleCollapse(): void
  quit(): void
  resizeStart(): void
  resizeBy(dx: number, dy: number): void
  resizeEnd(): void
  onData(cb: (d: DataSnapshot) => void): void
  onPetState(cb: (s: PetUiState) => void): void
  onPetShow(cb: () => void): void
  onSetupState(cb: (s: SetupUiState) => void): void
  onSetupShow(cb: () => void): void
  openSetup(): void
  testSetup(req: SetupRequest): void
  saveSetup(req: SetupRequest): void
  installVoices(pack: VoicePack): void
  cancelVoices(): void
  openPet(): void
  designPet(req: PetDesignRequest): void
  petAction(a: PetAction): void
  onMemoryText(cb: (file: string, text: string) => void): void
  openData(): void
  viewMemory(file: string): void
  deleteMemory(file: string): void
  clearSummary(): void
  revealMemory(): void
  toggleWatch(): void
  nudgeLook(): void
  nudgeDismiss(): void
}
declare global {
  interface Window {
    chat: ChatApi
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const log = $<HTMLOListElement>('log')
const empty = $<HTMLDivElement>('empty')
const emptyMock = $<HTMLDivElement>('empty-mock')
const emptyAi = $<HTMLDivElement>('empty-ai')
const title = $<HTMLSpanElement>('title')
const status = $<HTMLSpanElement>('status')
const form = $<HTMLFormElement>('form')
const input = $<HTMLTextAreaElement>('input')
const action = $<HTMLButtonElement>('action')
const mic = $<HTMLButtonElement>('mic')
const mute = $<HTMLButtonElement>('mute')
const voicebar = $<HTMLDivElement>('voicebar')
const voicetext = $<HTMLSpanElement>('voicetext')
const meterfill = $<HTMLElement>('meterfill')
const settingsBtn = $<HTMLButtonElement>('settings')

// round pixel buttons with pixel icons (no emoji)
installPixelShapes()
for (const [id, icon] of [['setup-btn', 'plug'], ['pet-btn', 'paw'], ['data-btn', 'data'], ['theme-btn', 'palette'], ['watch-btn', 'eye'], ['mute', 'speaker'], ['quit', 'house'], ['collapse', 'minimise'], ['close', 'close'], ['cam', 'camera'], ['mic', 'mic']] as const) setIcon($(id), icon)
setIcon(action, 'send', true)

let busy = false
let chatStatus: ChatSnapshot['status'] = 'idle'
let voice: VoiceUiState = IDLE_VOICE_STATE
const rows = new Map<number, HTMLLIElement>()
const rendered = new Map<number, string>()

// ---------------------------------------------------------------- transcript
function render(s: ChatSnapshot): void {
  busy = s.status !== 'idle'
  chatStatus = s.status

  // keyed update: touch only what changed, so a streaming reply doesn't rebuild the whole list
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const live = new Set(s.messages.map((m) => m.id))
  for (const [id, el] of rows)
    if (!live.has(id)) {
      el.remove()
      rows.delete(id)
      rendered.delete(id)
    }
  for (const m of s.messages) {
    let el = rows.get(m.id)
    if (!el) {
      el = document.createElement('li')
      rows.set(m.id, el)
      log.appendChild(el)
    }
    el.className = m.role + (m.error ? ' error' : '') + (m.summarized ? ' summarized' : '')
    if (rendered.get(m.id) !== m.text) {
      rendered.set(m.id, m.text)
      // replies are drawn as safe markdown (DOM nodes via textContent); everything else is plain text. Never innerHTML.
      if (m.role === 'assistant') renderMarkdown(el, m.text)
      else {
        el.textContent = m.text
        if (m.image) {
          // a preview of the screenshot that was sent with this message (data: URL, validated in the preload bridge)
          const img = document.createElement('img')
          img.src = m.image
          img.alt = 'The screenshot shared with this message'
          img.className = 'shot'
          el.prepend(img)
        }
      }
    }
  }
  empty.classList.toggle('show', s.messages.length === 0)
  title.textContent = s.assistant ? `Chat · ${s.assistant.name}` : 'Chat'
  emptyMock.hidden = s.assistant !== undefined && !s.assistant.offline
  emptyAi.hidden = !(s.assistant !== undefined && !s.assistant.offline)
  if (nearBottom) log.scrollTop = log.scrollHeight
  syncModelBar(s)
  syncStatus()
  syncAction()
}

// ---------------------------------------------------------------- screen sharing
const cam = $<HTMLButtonElement>('cam')
const screenbar = $<HTMLDivElement>('screenbar')
const screentext = $<HTMLSpanElement>('screentext')
const screenSettings = $<HTMLButtonElement>('screen-settings')
let screen: ScreenUiState = IDLE_SCREEN_STATE
function renderScreen(s: ScreenUiState): void {
  screen = s
  cam.hidden = !s.enabled
  cam.classList.toggle('live', s.armed)
  setIcon(cam, 'camera', s.armed)
  cam.setAttribute('aria-pressed', String(s.armed))
  cam.disabled = s.busy
  cam.title = s.armed ? 'A screenshot will be sent with your next message. Click to cancel.' : 'Share a screenshot with your next message (or type /screen)'
  let text = ''
  let cls = ''
  if (s.busy) text = 'Looking at your screen…'
  else if (s.error) {
    text = s.error.message
    cls = 'error'
  } else if (s.armed) {
    text = '📷 Your next message will include a screenshot of your screen. Click 📷 again to cancel.'
    cls = 'live'
  }
  screentext.textContent = text
  screenbar.hidden = text === ''
  screenbar.className = `voicebar ${cls}`.trim()
  screenSettings.hidden = !(s.error && s.error.fix)

  // watching: a switch in the header, a status line while it is on (what it has done, in plain words), a nudge bar when a rule fired
  const w = s.watch
  watchBtn.hidden = !w.available
  watchBtn.setAttribute('aria-pressed', String(w.on))
  watchBtn.title = w.on ? 'Watching for your rules. Click to pause.' : 'Watch for my rules (starts off; nothing is sent without them)'
  watchbar.hidden = !w.on
  if (w.on) {
    const what = w.phase === 'paused-excluded' ? '⏸ Paused: an app on your exclusion list is on screen. Nothing is being looked at.' : w.phase === 'suspended' ? '⏸ Paused (screen locked, asleep or pet hidden).' : `👁 Watching${w.app ? ` · ${w.app} in front` : ''}`
    watchtext.textContent = `${what} ${w.checks} checks, ${w.samples} thumbnails compared on this computer (never sent), ${w.fired} rule${w.fired === 1 ? '' : 's'} fired, ${w.sent} screenshot${w.sent === 1 ? '' : 's'} sent to the assistant by rules.`
  }
  nudgebar.hidden = s.nudge === null
  if (s.nudge) nudgetext.textContent = `I noticed you opened ${s.nudge.app}. Want me to look at your screen? (${s.nudge.prompt})`
  syncAction()
}
const watchBtn = $<HTMLButtonElement>('watch-btn')
const watchbar = $<HTMLDivElement>('watchbar')
const watchtext = $<HTMLSpanElement>('watchtext')
const nudgebar = $<HTMLDivElement>('nudgebar')
const nudgetext = $<HTMLSpanElement>('nudgetext')
watchBtn.addEventListener('click', () => window.chat.toggleWatch())
$('watch-off').addEventListener('click', () => window.chat.toggleWatch())
$('nudge-look').addEventListener('click', () => window.chat.nudgeLook())
$('nudge-no').addEventListener('click', () => window.chat.nudgeDismiss())
cam.addEventListener('click', () => window.chat.armScreen())
screenSettings.addEventListener('click', () => window.chat.openSettings())
window.chat.onScreen(renderScreen)
window.chat.onRestore((text) => {
  input.value = text // a message that was not sent (screen refused): give it back instead of losing it
  autosize()
  input.focus()
})

// ---------------------------------------------------------------- data drawer: what the pet keeps, viewable and removable
const dataBtn = $<HTMLButtonElement>('data-btn')
const databar = $<HTMLElement>('databar')
const dataMemory = $<HTMLUListElement>('data-memory')
const dataMemoryView = $<HTMLPreElement>('data-memory-view')
const dataSummary = $<HTMLPreElement>('data-summary')
let data: DataSnapshot = EMPTY_DATA
let viewing = ''
function renderData(d: DataSnapshot): void {
  data = d
  $('data-memory-note').textContent = d.memoryRead || d.memoryWrite ? `(plain files you can read and edit${d.memoryWrite ? '' : '; read-only here'})` : '(off in settings)'
  dataMemory.replaceChildren(
    ...(d.memory.length === 0 && (d.memoryRead || d.memoryWrite)
      ? [Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Nothing saved yet. Say "remember that…" and it will appear here.' })]
      : d.memory.map((m) => {
          const li = document.createElement('li')
          const label = document.createElement('span')
          label.className = 'dl-label'
          label.textContent = `${m.name} · ${m.type}${m.description ? ` — ${m.description}` : ''}`
          const view = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: viewing === m.file ? 'Hide' : 'View' })
          view.addEventListener('click', () => {
            if (viewing === m.file) {
              viewing = ''
              dataMemoryView.hidden = true
              renderData(data)
            } else window.chat.viewMemory(m.file)
          })
          const del = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Delete' })
          del.title = 'Moves the file to the Trash and removes it from the memory index'
          del.addEventListener('click', () => window.chat.deleteMemory(m.file))
          li.append(label, view, del)
          return li
        }))
  )
  const folded = d.summarizedMessages
  $('data-convo').textContent =
    `${d.messages} message${d.messages === 1 ? '' : 's'} saved on this computer` +
    (folded ? `, ${folded} of them folded into a summary` : '') +
    (d.summarizeEnabled ? '. Very long conversations are summarised automatically.' : '. Automatic summaries are off.')
  dataSummary.hidden = d.summary === ''
  dataSummary.textContent = d.summary
  $('data-forget').hidden = d.summary === ''
}
window.chat.onData(renderData)
window.chat.onMemoryText((file, text) => {
  viewing = file
  dataMemoryView.textContent = text
  dataMemoryView.hidden = false
  renderData(data)
})
function toggleData(open: boolean): void {
  databar.hidden = !open
  dataBtn.setAttribute('aria-expanded', String(open))
  if (open) {
    viewing = ''
    dataMemoryView.hidden = true
    window.chat.openData()
  } else input.focus()
}
dataBtn.addEventListener('click', () => toggleData(databar.hidden))
$('data-done').addEventListener('click', () => toggleData(false))
$('data-forget').addEventListener('click', () => window.chat.clearSummary())
$('data-newchat').addEventListener('click', () => window.chat.newChat())
$('data-reveal').addEventListener('click', () => window.chat.revealMemory())

// ---------------------------------------------------------------- model / effort
const modelbar = $<HTMLDivElement>('modelbar')
const modelSel = $<HTMLSelectElement>('model')
const effortSel = $<HTMLSelectElement>('effort')
const effortLabel = $<HTMLLabelElement>('effort-label')
function fillSelect(sel: HTMLSelectElement, options: string[], value: string): void {
  const key = options.join('|')
  if (sel.dataset['key'] !== key) {
    sel.dataset['key'] = key
    sel.replaceChildren(...options.map((o) => Object.assign(document.createElement('option'), { value: o, textContent: o })))
  }
  sel.value = value
}
function syncModelBar(s: ChatSnapshot): void {
  const a = s.assistant
  const show = a !== undefined && !a.offline && a.models !== undefined && a.model !== undefined
  modelbar.hidden = !show
  if (!show || !a) return
  fillSelect(modelSel, a.models!, a.model!)
  effortLabel.hidden = a.efforts === undefined
  if (a.efforts) fillSelect(effortSel, a.efforts, a.effort ?? 'auto')
}
modelSel.addEventListener('change', () => window.chat.setModel({ model: modelSel.value }))
effortSel.addEventListener('change', () => window.chat.setModel({ effort: effortSel.value }))
$('newchat').addEventListener('click', () => window.chat.newChat())

// ---------------------------------------------------------------- voice
let dictBase = '' // what was already in the box when listening began (trimmed, for joining)
let typedBefore = '' // the same, exactly as typed, so a discarded dictation restores it unchanged
let lastVoiceText = ''
let lastPhase: VoiceUiState['phase'] = 'idle'
const join = (base: string, text: string): string => (base && text ? `${base} ${text}` : base || text)

function renderVoice(v: VoiceUiState): void {
  const prev = voice
  voice = v
  const listening = v.phase !== 'idle'

  // Dictation: show the live transcript in the box; when it ends, leave the final text there to review/edit.
  if (prev.phase === 'idle' && listening) {
    typedBefore = input.value
    dictBase = typedBefore.trim()
  }
  if (listening || (v.final && v.text)) {
    if (v.text !== lastVoiceText || lastPhase !== v.phase) {
      input.value = join(dictBase, v.text)
      autosize()
    }
  } else if (lastPhase !== 'idle' && !v.text) {
    input.value = typedBefore // cancelled: back to exactly what was typed before
    autosize()
  }
  if (lastPhase !== 'idle' && v.phase === 'idle' && v.final && v.text) input.focus()
  lastVoiceText = v.text
  lastPhase = v.phase

  input.readOnly = listening
  mic.classList.toggle('live', listening || v.live)
  mic.disabled = !v.canListen && !listening && !v.live
  const micLabel = v.live
    ? listening
      ? 'End the live conversation'
      : 'Interrupt him and talk'
    : listening
      ? 'Stop listening (Esc to discard)'
      : 'Talk to him (live: just speak, he answers when you pause)'
  mic.setAttribute('aria-label', micLabel)
  mic.title = !v.canListen && !listening && !v.live ? 'Voice input is not set up (the speech helper is not built)' : micLabel
  setIcon(mic, v.live ? (listening ? 'stop' : 'hand') : listening ? 'stop' : 'mic', listening || v.live)
  meterfill.style.width = `${Math.round(v.level * 100)}%`

  mute.setAttribute('aria-pressed', String(v.muted))
  setIcon(mute, v.muted ? 'muted' : 'speaker')
  mute.title = v.muted ? 'Spoken replies: off (click to turn on)' : 'Spoken replies: on (click to mute)'
  mute.setAttribute('aria-label', v.muted ? 'Unmute spoken replies' : 'Mute spoken replies')

  // the bar under the transcript: what is happening with the microphone, or what went wrong
  let text = ''
  let cls = ''
  if (v.error) {
    text = v.error.message
    cls = 'error'
  } else if (v.phase === 'starting') text = 'Starting the microphone… (your system may ask for permission)'
  else if (v.phase === 'listening') {
    text = v.live ? 'Listening… just talk. He answers when you pause. ⏹ ends the conversation.' : 'Listening… speak now. Click ⏹ to finish, Esc to discard.'
    cls = 'live'
  } else if (v.phase === 'stopping') text = 'Finishing…'
  else if (v.live) {
    text = "Live conversation: he'll listen again as soon as he's done. ✋ to interrupt."
    cls = 'live'
  }
  else if (v.notice) text = v.notice
  else if (!v.canListen) text = 'Voice input is not set up: open Set up (the plug button) and download the voices and speech recognition.'
  voicetext.textContent = text
  voicebar.hidden = text === ''
  voicebar.className = `voicebar ${cls}`.trim()
  settingsBtn.hidden = !(v.error && v.error.fix)

  syncStatus()
  syncAction()
}

function syncStatus(): void {
  if (voice.phase === 'listening') status.textContent = 'Listening…'
  else if (voice.phase === 'stopping') status.textContent = 'Finishing…'
  else if (chatStatus === 'pending') status.textContent = 'Thinking…'
  else if (chatStatus === 'streaming') status.textContent = 'Replying…'
  else if (voice.speaking) status.textContent = 'Speaking…'
  else status.textContent = ''
}

// ---------------------------------------------------------------- composer
function syncAction(): void {
  const listening = voice.phase !== 'idle'
  if (busy || voice.speaking) {
    setIcon(action, 'stop', true)
    action.setAttribute('aria-label', 'Stop')
    action.title = 'Stop'
    action.type = 'button'
    action.classList.add('stop')
    action.disabled = false
  } else {
    setIcon(action, 'send', true)
    action.setAttribute('aria-label', 'Send')
    action.title = 'Send (Enter)'
    action.type = 'submit'
    action.classList.remove('stop')
    action.disabled = listening || screen.busy || input.value.trim().length === 0
  }
}

function autosize(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 84)}px`
  input.style.overflowY = input.scrollHeight > 84 ? 'auto' : 'hidden' // no scrollbar until the box is full
  syncAction()
}

function submit(): void {
  const text = input.value.trim()
  if (busy || voice.phase !== 'idle' || text.length === 0 || text.length > MAX_MESSAGE_CHARS) return
  window.chat.send(text)
  input.value = ''
  dictBase = ''
  autosize()
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  submit()
})
action.addEventListener('click', () => {
  if (busy || voice.speaking) window.chat.cancel() // stops the request and/or the voice
})
mic.addEventListener('click', () => window.chat.mic())
mute.addEventListener('click', () => window.chat.mute())
settingsBtn.addEventListener('click', () => window.chat.openSettings())
input.addEventListener('input', autosize)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
})
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  e.preventDefault()
  if (!petbar.hidden) return togglePet(false)
  if (!databar.hidden) return toggleData(false) // Esc closes a drawer first
  if (!themebar.hidden) return toggleThemeBar(false)
  // Esc undoes the most active thing: discard the mic, stop the voice/request, and only then close the panel.
  if (voice.phase !== 'idle' || busy || voice.speaking) window.chat.cancel()
  else window.chat.close()
})
$('close').addEventListener('click', () => window.chat.close())

// ---------------------------------------------------------------- the look: grass patch + customise drawer
const PX = 4
const panel = document.querySelector<HTMLElement>('.panel')!
const paintGrass = (): void => drawGrass($('grass-base') as HTMLCanvasElement, Math.round(panel.clientWidth / PX), Math.round(panel.clientHeight / PX), PX)
paintGrass()
// the panel can be resized by hand: redraw the patch to the new size once the size settles
let regrow: ReturnType<typeof setTimeout> | undefined
new ResizeObserver(() => {
  clearTimeout(regrow)
  regrow = setTimeout(paintGrass, 80)
}).observe(panel)

// ---------------------------------------------------------------- move / resize / minimise by hand
const grip = $<HTMLDivElement>('grip')
let gripFrom: { x: number; y: number } | null = null
let gripQueued = false
let gripLast = { dx: 0, dy: 0 }
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  grip.setPointerCapture(e.pointerId)
  gripFrom = { x: e.screenX, y: e.screenY }
  window.chat.resizeStart()
})
grip.addEventListener('pointermove', (e) => {
  if (!gripFrom) return
  gripLast = { dx: e.screenX - gripFrom.x, dy: e.screenY - gripFrom.y }
  if (gripQueued) return
  gripQueued = true
  requestAnimationFrame(() => {
    gripQueued = false
    window.chat.resizeBy(gripLast.dx, gripLast.dy)
  })
})
const endGrip = (): void => {
  if (!gripFrom) return
  gripFrom = null
  window.chat.resizeBy(gripLast.dx, gripLast.dy)
  window.chat.resizeEnd()
}
grip.addEventListener('pointerup', endGrip)
grip.addEventListener('pointercancel', endGrip)
$('quit').addEventListener('click', () => window.chat.quit())
const collapseBtn = $<HTMLButtonElement>('collapse')
collapseBtn.addEventListener('click', () => window.chat.toggleCollapse())
window.chat.onLayout((collapsed) => {
  document.body.classList.toggle('collapsed', collapsed)
  setIcon(collapseBtn, collapsed ? 'restore' : 'minimise')
  collapseBtn.setAttribute('aria-pressed', String(collapsed))
  collapseBtn.setAttribute('aria-label', collapsed ? 'Restore the panel' : 'Minimise to the title bar')
  collapseBtn.title = collapsed ? 'Restore' : 'Minimise (click again to restore)'
})

const themeBtn = $<HTMLButtonElement>('theme-btn')
const themebar = $<HTMLElement>('themebar')
const sliders = {
  hue: $<HTMLInputElement>('t-hue'),
  saturation: $<HTMLInputElement>('t-sat'),
  brightness: $<HTMLInputElement>('t-bright'),
  opacity: $<HTMLInputElement>('t-opacity')
}
const outputs = { hue: $('o-hue'), saturation: $('o-sat'), brightness: $('o-bright'), opacity: $('o-opacity') }
const PRESETS: Array<{ name: string; theme: Theme }> = [
  { name: 'Grass', theme: DEFAULT_THEME },
  { name: 'Sand', theme: { ...DEFAULT_THEME, hue: -70 } },
  { name: 'Sunset', theme: { ...DEFAULT_THEME, hue: -95 } },
  { name: 'Ocean', theme: { ...DEFAULT_THEME, hue: 90 } },
  { name: 'Violet', theme: { ...DEFAULT_THEME, hue: 150 } },
  { name: 'Sakura', theme: { ...DEFAULT_THEME, hue: -155, brightness: 110 } },
  { name: 'Ghost', theme: { ...DEFAULT_THEME, saturation: 30, opacity: 0.55 } }
]
const presetBox = themebar.querySelector('.presets')!
const swatches = PRESETS.map((p) => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'swatch'
  b.title = p.name
  b.setAttribute('aria-label', `${p.name} look`)
  b.setAttribute('aria-pressed', 'false')
  b.style.background = swatchColor(p.theme.hue)
  b.style.opacity = String(Math.max(0.5, p.theme.opacity))
  b.addEventListener('click', () => setTheme(p.theme, true))
  presetBox.appendChild(b)
  return b
})

const fmt = (k: keyof Theme, v: number): string => (k === 'hue' ? `${v}°` : k === 'opacity' ? `${Math.round(v * 100)}%` : `${v}%`)
function syncThemeUi(t: Theme): void {
  for (const k of Object.keys(sliders) as Array<keyof Theme>) {
    sliders[k].value = String(k === 'opacity' ? Math.round(t[k] * 100) : t[k])
    outputs[k].textContent = fmt(k, t[k])
  }
  PRESETS.forEach((p, i) => swatches[i]!.setAttribute('aria-pressed', String(JSON.stringify(p.theme) === JSON.stringify(t))))
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
function setTheme(t: Theme, save: boolean): void {
  applyTheme(t)
  syncThemeUi(t)
  if (!save) return
  clearTimeout(saveTimer) // dragging a slider sends one save when it settles, not one per pixel
  saveTimer = setTimeout(() => window.chat.setTheme(t), 250)
}
for (const k of Object.keys(sliders) as Array<keyof Theme>) {
  sliders[k].addEventListener('input', () => {
    const raw = Number(sliders[k].value)
    const [lo, hi] = THEME_LIMITS[k]
    const v = Math.min(hi, Math.max(lo, k === 'opacity' ? raw / 100 : raw))
    setTheme({ ...currentTheme(), [k]: v }, true)
  })
}
function toggleThemeBar(open: boolean): void {
  themebar.hidden = !open
  themeBtn.setAttribute('aria-expanded', String(open))
  if (open) sliders.hue.focus()
  else input.focus()
}
themeBtn.addEventListener('click', () => toggleThemeBar(themebar.hidden))
$('t-done').addEventListener('click', () => toggleThemeBar(false))
$('t-reset').addEventListener('click', () => setTheme(DEFAULT_THEME, true))
window.chat.onTheme((t) => setTheme(t, false))
syncThemeUi(DEFAULT_THEME)


// ---------------------------------------------------------------- set up: connect an AI, get voices
const setupBtn = $<HTMLButtonElement>('setup-btn')
const setupbar = $<HTMLElement>('setupbar')
const setupProvider = $<HTMLSelectElement>('setup-provider')
const setupKey = $<HTMLInputElement>('setup-key')
const setupUrl = $<HTMLInputElement>('setup-url')
const setupCmd = $<HTMLInputElement>('setup-cmd')
const setupArgs = $<HTMLInputElement>('setup-args')
const setupModel = $<HTMLInputElement>('setup-model')
const setupMsg = $<HTMLParagraphElement>('setup-msg')
const setupTest = $<HTMLButtonElement>('setup-test')
const setupSave = $<HTMLButtonElement>('setup-save')
const setupVoiceLog = $<HTMLPreElement>('setup-voice-log')
let setupState: SetupUiState = EMPTY_SETUP_UI
let setupFilled = false

const chosenProvider = (): SetupProvider | undefined => setupState.providers.find((p) => p.id === setupProvider.value)
/** The form as a request. The key is sent only if one was typed; an empty key means "keep the stored one". */
const setupRequest = (): SetupRequest => ({ provider: setupProvider.value, model: setupModel.value.trim(), baseUrl: setupUrl.value.trim(), command: setupCmd.value.trim(), args: setupArgs.value.trim(), key: setupKey.value.trim() })

/** Fill the fields from what is saved when the chosen service is the saved one, else start them blank. */
function fillSetupFields(): void {
  const cur = setupState.current
  const same = setupProvider.value === cur.provider
  setupModel.value = same ? cur.model : ''
  setupUrl.value = same ? cur.baseUrl : ''
  setupCmd.value = same ? cur.command : ''
  setupArgs.value = same ? cur.args : ''
  setupKey.value = ''
}

function syncSetup(): void {
  const s = setupState
  const key = s.providers.map((p) => p.id).join(',')
  if (setupProvider.dataset['key'] !== key) {
    setupProvider.dataset['key'] = key
    setupProvider.replaceChildren(
      ...s.providers.map((p) => {
        const o = document.createElement('option')
        o.value = p.id
        o.textContent = p.label
        return o
      })
    )
    setupFilled = false
  }
  if (!setupFilled && s.providers.length > 0) {
    setupProvider.value = s.providers.some((p) => p.id === s.current.provider) ? s.current.provider : s.providers[0]!.id
    fillSetupFields()
    setupFilled = true
  }
  const p = chosenProvider()
  const kind = p?.kind ?? 'mock'
  const custom = p?.id === 'custom'
  $('setup-now').textContent = `(now: ${s.providers.find((x) => x.id === s.current.provider)?.label ?? 'offline demo'})`
  $('setup-hint').textContent = p?.hint ?? ''
  $('setup-key-row').hidden = !(p?.needsKey || custom)
  $('setup-url-row').hidden = !custom
  $('setup-cmd-row').hidden = kind !== 'command'
  $('setup-args-row').hidden = kind !== 'command'
  $('setup-model-row').hidden = kind === 'mock'
  setupModel.placeholder = p?.defaultModel ? `${p.defaultModel} (default)` : 'the default'
  $('setup-models').replaceChildren(
    ...(p?.models ?? []).map((m) => {
      const o = document.createElement('option')
      o.value = m
      return o
    })
  )
  setupKey.placeholder = p?.hasKey ? 'A key is stored. Paste a new one to replace it' : 'Paste your key'
  $('setup-key-note').textContent = !(p?.needsKey || custom)
    ? ''
    : !s.secureKeys
      ? 'This system has no secure storage for keys (on Linux, install gnome-keyring or KWallet), so a typed key cannot be saved. Set the key as an environment variable instead (see the README).'
      : 'The key is encrypted by your system and kept only on this computer. It is only ever sent to the service itself.'
  setupMsg.textContent = s.message
  setupMsg.classList.toggle('error', s.error)
  setupTest.disabled = s.busy || s.voice.busy
  setupSave.disabled = s.busy || s.voice.busy
  setupSave.textContent = kind === 'mock' ? 'Use the offline demo' : 'Save and restart'
  // voices
  const v = s.voice
  $('setup-voice-now').textContent = `(${v.voices} voice${v.voices === 1 ? '' : 's'}, ${v.speech} speech model${v.speech === 1 ? '' : 's'} installed)`
  $<HTMLButtonElement>('setup-voices-starter').disabled = v.busy || v.done || s.busy
  $<HTMLButtonElement>('setup-voices-big').disabled = v.busy || v.done || s.busy
  $('setup-voices-cancel').hidden = !v.busy
  setupVoiceLog.hidden = v.log.length === 0
  setupVoiceLog.textContent = v.log.join('\n')
  setupVoiceLog.classList.toggle('error', v.error)
  setupVoiceLog.scrollTop = setupVoiceLog.scrollHeight
}

function toggleSetup(open: boolean): void {
  if (open) for (const id of ['petbar', 'databar', 'themebar']) $(id).hidden = true
  setupbar.hidden = !open
  setupBtn.setAttribute('aria-expanded', String(open))
  if (open) {
    window.chat.openSetup()
    setupProvider.focus()
  } else {
    setupKey.value = '' // a pasted key never lingers in the page
    setupFilled = false
    input.focus()
  }
}
window.chat.onSetupState((s) => {
  setupState = s
  syncSetup()
})
window.chat.onSetupShow(() => toggleSetup(true))
setupBtn.addEventListener('click', () => toggleSetup(setupbar.hidden))
$('empty-setup').addEventListener('click', () => toggleSetup(true))
$('setup-done').addEventListener('click', () => toggleSetup(false))
setupProvider.addEventListener('change', () => {
  fillSetupFields()
  setupState = { ...setupState, message: '', error: false }
  syncSetup()
})
setupTest.addEventListener('click', () => window.chat.testSetup(setupRequest()))
setupSave.addEventListener('click', () => window.chat.saveSetup(setupRequest()))
$('setup-voices-starter').addEventListener('click', () => window.chat.installVoices('starter'))
$('setup-voices-big').addEventListener('click', () => window.chat.installVoices('recommended'))
$('setup-voices-cancel').addEventListener('click', () => window.chat.cancelVoices())
syncSetup()

// ---------------------------------------------------------------- change your pet
const petBtn = $<HTMLButtonElement>('pet-btn')
const petbar = $<HTMLElement>('petbar')
const petText = $<HTMLTextAreaElement>('pet-text')
const petThumbs = $<HTMLDivElement>('pet-thumbs')
const petFile = $<HTMLInputElement>('pet-file')
const petGo = $<HTMLButtonElement>('pet-go')
const petMsg = $<HTMLParagraphElement>('pet-msg')
const petUndo = $<HTMLButtonElement>('pet-undo')
let petState: PetUiState = EMPTY_PET_UI
let petImages: Array<PetImage & { url: string }> = []
let petClearOnDone = false

/** A picture file, scaled down to at most PET_IMAGE_EDGE px on its long side and re-encoded as JPEG (so nothing large is ever sent). */
async function loadPetImage(file: File): Promise<(PetImage & { url: string }) | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('not an image'))
    i.src = dataUrl
  }).catch(() => null)
  if (!img || !img.width || !img.height) return null
  const k = Math.min(1, PET_IMAGE_EDGE / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.width * k))
  c.height = Math.max(1, Math.round(img.height * k))
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff' // transparent pictures become white instead of black
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const url = c.toDataURL('image/jpeg', 0.85)
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url }
}
async function addPetFiles(files: Iterable<File>): Promise<void> {
  for (const f of files) {
    if (petImages.length >= MAX_PET_IMAGES) break
    const im = await loadPetImage(f)
    if (im) petImages.push(im)
  }
  renderPetThumbs()
}
function renderPetThumbs(): void {
  petThumbs.replaceChildren(
    ...petImages.map((im, i) => {
      const d = document.createElement('div')
      d.className = 'thumb'
      d.style.backgroundImage = `url(${im.url})`
      const x = document.createElement('button')
      x.type = 'button'
      x.textContent = '✕'
      x.setAttribute('aria-label', 'Remove this picture')
      x.addEventListener('click', () => {
        petImages.splice(i, 1)
        renderPetThumbs()
      })
      d.append(x)
      return d
    })
  )
  syncPet()
}
function syncPet(): void {
  const s = petState
  $('pet-name').textContent = `(now: ${s.name})`
  petMsg.textContent = s.busy ? (s.message || 'Working…') : s.message
  petMsg.classList.toggle('error', s.error)
  const canGo = s.supported && !s.busy && (petText.value.trim().length > 0 || petImages.length > 0)
  petGo.disabled = !canGo
  petGo.textContent = s.busy ? 'Working…' : 'Transform'
  petUndo.disabled = s.busy || !s.canUndo
  $<HTMLButtonElement>('pet-reset').disabled = s.busy || s.isDefault
  $<HTMLButtonElement>('pet-add').disabled = petImages.length >= MAX_PET_IMAGES || !s.canSeeImages
  $<HTMLButtonElement>('pet-add').title = s.canSeeImages ? 'Add up to 4 pictures for inspiration' : s.hasAi ? 'The connected AI cannot look at pictures' : 'Connect an AI that can see pictures (Set up, the plug button)'
  if (!s.supported) petMsg.textContent = 'Custom pets need the standing figure: set "cat.view": "figure" in settings.json.'
  const box = $('pet-presets')
  const key = s.presets.map((p) => p.id).join(',')
  if (box.dataset['key'] !== key) {
    box.dataset['key'] = key
    box.replaceChildren(
      ...s.presets.map((p) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'pixbtn'
        b.textContent = p.name
        b.addEventListener('click', () => window.chat.petAction({ kind: 'preset', id: p.id }))
        return b
      })
    )
  }
  box.querySelectorAll('button').forEach((b) => { b.disabled = s.busy || !s.supported })
}
function togglePet(open: boolean): void {
  petbar.hidden = !open
  petBtn.setAttribute('aria-expanded', String(open))
  if (open) {
    window.chat.openPet()
    petText.focus()
  } else input.focus()
}
window.chat.onPetState((s) => {
  const wasBusy = petState.busy
  petState = s
  if (petClearOnDone && wasBusy && !s.busy && !s.error) {
    petText.value = ''
    petImages = []
    renderPetThumbs()
    petClearOnDone = false
  }
  if (!s.busy && s.error) petClearOnDone = false
  syncPet()
})
window.chat.onPetShow(() => togglePet(true))
petBtn.addEventListener('click', () => togglePet(petbar.hidden))
$('pet-done').addEventListener('click', () => togglePet(false))
$('pet-add').addEventListener('click', () => petFile.click())
petFile.addEventListener('change', () => {
  void addPetFiles(Array.from(petFile.files ?? [])).then(() => (petFile.value = ''))
})
petText.addEventListener('input', syncPet)
petGo.addEventListener('click', () => {
  if (petGo.disabled) return
  petClearOnDone = true
  window.chat.designPet({ text: petText.value.trim(), images: petImages.map(({ mime, data }) => ({ mime, data })) })
})
petUndo.addEventListener('click', () => window.chat.petAction({ kind: 'undo' }))
$('pet-reset').addEventListener('click', () => window.chat.petAction({ kind: 'reset' }))
// pictures can also be dropped on the drawer or pasted into it
petbar.addEventListener('dragover', (e) => {
  e.preventDefault()
  petbar.classList.add('dropping')
})
petbar.addEventListener('dragleave', () => petbar.classList.remove('dropping'))
petbar.addEventListener('drop', (e) => {
  e.preventDefault()
  petbar.classList.remove('dropping')
  if (petState.canSeeImages) void addPetFiles(Array.from(e.dataTransfer?.files ?? []))
})
petbar.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (files.length > 0 && petState.canSeeImages) {
    e.preventDefault()
    void addPetFiles(files)
  }
})
syncPet()

window.chat.onSnapshot(render)
window.chat.onVoice(renderVoice)
window.chat.ready()
input.focus()
syncAction()
