import { execFile } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, screen as electronScreen, shell, systemPreferences, Tray, type IpcMainEvent } from 'electron'
import { ChatSession, type Attachment } from '../services/ai/chat-session'
import { createProvider, describeProvider, type ProviderInfo } from '../services/ai/create-provider'
import { MemoryProvider } from '../services/ai/memory-provider'
import { buildSystemPrompt } from '../services/ai/prompt'
import type { ChatProvider } from '../services/ai/provider'
import { isMemoryFileName, listMemoryFiles, readMemory, readMemoryFile, removeFromIndex } from '../services/memory/memory-store'
import { buildSummaryRequest, SUMMARY_SYSTEM } from '../services/memory/summary'
import { parseMemoryFile, type DataSnapshot } from '../shared/data-types'
import { loadConversation, loadPrefs, saveHistory, savePrefs, type Prefs } from '../services/memory/chat-store'
import { loadSettings, type Settings } from '../services/memory/settings'
import { loadPresets, PetStore, type PetPreset } from '../services/memory/pet-store'
import { designPet, designerSystemPrompt } from '../services/ai/pet-designer'
import { KeyStore, type Cipher } from '../services/ai/key-store'
import { quickRecolour, type PetSpec } from '../shared/cat3d/pet-spec'
import { EMPTY_PET_UI, parsePetAction, parsePetDesignRequest, type PetImage, type PetUiState } from '../shared/pet-types'
import { loadTheme, saveTheme } from '../services/memory/theme-store'
import { DEFAULT_THEME, parseTheme, type Theme } from '../shared/theme'
import { IDLE_SCREEN_STATE, IDLE_WATCH_STATE, type ScreenUiState } from '../shared/screen-types'
import { ScreenService, type ScreenResult } from '../services/screen/screen-service'
import { NoWindows, SwiftWindows } from '../services/screen/windows'
import { DesktopIcons } from '../services/screen/desktop-icons'
import { ElectronCapturer, ElectronSampler, FakeCapturer, FakeSampler } from './screen-capture'
import { ScreenObserver, type Trigger, type WatchState } from '../services/screen/observer'
import { LocalTts } from '../services/voice/local-tts'
import type { SpeechToText } from '../services/voice/types'
import { createSystemTts, SayTts } from '../services/voice/say-tts'
import { SwitchableTts } from '../services/voice/switchable-tts'
import { installedVoices, loadCatalog, type CatalogVoice } from '../services/voice/voice-catalog'
import { HelperStt } from '../services/voice/helper-stt'
import { VoiceController } from '../services/voice/voice-controller'
import { EFFORTS, parseModelChoice, type AssistantInfo } from '../shared/chat-types'
import { helpText, parseCommand, type ChatCommand } from '../shared/commands'
import { Channels, parseChatText, parseHover } from '../shared/ipc'
import { parseSetupRequest, parseVoicePack } from '../shared/setup-types'
import { SetupController } from './setup-controller'
import { ChatWindow } from './chat-window'
import { PetController, type RoamMode } from './controller'
import { buildMenu, type MenuActions, type VoiceChoice, type VoiceMenuInfo } from './menu'
import { applyLevel, createPetWindow } from './pet-window'
import { FishPond } from './fish'

const debug = process.env['PET_DEBUG'] === '1'
const e2e = process.env['PET_E2E'] === '1'

// Automated-test mode: isolated settings and a local-only DevTools port (never enabled otherwise).
if (e2e) {
  if (process.env['PET_USER_DATA']) app.setPath('userData', process.env['PET_USER_DATA'])
  app.commandLine.appendSwitch('remote-debugging-port', process.env['PET_E2E_PORT'] ?? '9339')
  // CI machines have no GPU: let Chromium draw WebGL in software so the 3D cat can be tested there too
  if (process.env['PET_E2E_SOFTWARE_GL'] === '1') { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader') }
}

// The app is called DeskPet. Settings, history, memory and voices live in ~/Library/Application Support/DeskPet
// (set DESKPET_DATA_DIR to keep them somewhere else).
app.setName('DeskPet')
if (!(e2e && process.env['PET_USER_DATA'])) app.setPath('userData', process.env['DESKPET_DATA_DIR'] || join(app.getPath('appData'), 'DeskPet'))

// `npm run setup` runs the app once, without windows, to put an API key in the secure store: `--deskpet-key store|has|delete <provider>`
// (the key itself comes in on stdin, never on the command line).
const keyToolAt = process.argv.indexOf('--deskpet-key')
const keyTool = keyToolAt >= 0 ? { action: process.argv[keyToolAt + 1] ?? '', account: process.argv[keyToolAt + 2] ?? '' } : null

// A second launch just exits; the first instance keeps running.
if (!keyTool && !app.requestSingleInstanceLock()) app.exit(0)

let win: BrowserWindow | null = null
let pet: PetController | null = null
let chat: ChatWindow | null = null
let session: ChatSession | null = null
let provider: (ChatProvider) | null = null
let assistantLabel = ''
let theme: Theme = { ...DEFAULT_THEME }
let themePath = ''
let voice: VoiceController | null = null
let tray: Tray | null = null
let screenSvc: ScreenService | null = null
let observer: ScreenObserver | null = null
let observeAllowed = false
let memoryDir = ''
let memoryReadOn = false
let memoryWriteOn = false
let summarizeOn = false
let proactiveReactions = false
let summaryDispose: (() => void) | null = null
let quitting = false
let proactiveSent = 0
let nudgeTimer: NodeJS.Timeout | null = null
let screenState: ScreenUiState = { ...IDLE_SCREEN_STATE }
let screenBusy = false
let usingAi = false
let providerInfo: ProviderInfo | null = null
let model = ''
let effort = 'auto'
let modelChoices: string[] = []
let prefsPath = ''
let prefsState: Prefs = {}
let bringWithMe = false
let restAtHome = true
let roam: RoamMode = 'edges'
let historyPath = ''
/** The message being sent came from a live voice conversation (the reply is shaped for listening). */
let spokenTurn = false
let tts: SwitchableTts | null = null
let petStore: PetStore | null = null
let keyStore: KeyStore | null = null
let petPresets: PetPreset[] = []
let petBusy = false
let petAbort: AbortController | null = null
let petMessage = { text: '', error: false }
let sayBinOverride: string | undefined
let voiceCatalog: CatalogVoice[] = []
let voiceChoice: VoiceChoice = { engine: 'say', sayVoice: '' }
let sayVoiceNames: string[] = []
let settingsRef: Settings | null = null
let setup: SetupController | null = null
/** The chat is being closed by clicking him: he goes to sleep once it has closed. */
let sleepAfterClose = false
let pond: FishPond | null = null

const log = (event: string, extra: Record<string, unknown> = {}): void => {
  if (debug) console.log(JSON.stringify({ t: Date.now(), event, ...extra }))
}

const actions: MenuActions = {
  togglePause: () => pet?.togglePause(),
  toggleHidden: () => {
    if (!pet) return
    if (!pet.isHidden) chat?.close() // a hidden pet has no chat panel hanging in mid-air
    pet.toggleHidden()
    pond?.setHidden(pet.isHidden)
    observer?.suspend(pet.isHidden) // a hidden pet watches nothing
  },
  toggleWatch: () => {
    if (!observer || !watchAvailable()) return
    if (observer.watching) {
      observer.stop()
      clearNudge()
    } else if (!observer.start()) session?.notice('Watching is switched off in settings.json (observe.enabled).', true)
    refreshWatchUi()
  },
  toggleChat: () => {
    if (pet && !pet.isHidden) chat?.toggle()
  },
  toggleListen: () => {
    if (!pet || pet.isHidden || !voice) return
    if (!chat?.isOpen) chat?.open() // the transcript needs somewhere to appear
    voice.toggleListen()
  },
  lookAtScreen: () => {
    if (!pet || pet.isHidden || !screenState.enabled) return
    if (!chat?.isOpen) chat?.open()
    setScreenState({ armed: true, error: null }) // the next message the user sends will carry a screenshot
  },
  toggleBringWithMe: () => {
    bringWithMe = !bringWithMe
    if (win) applyLevel(win, bringWithMe)
    chat?.applyLevel()
    pond?.applyLevel()
    savePrefsNow()
    log('bring-with-me', { on: bringWithMe })
  },
  toggleRest: () => {
    restAtHome = !restAtHome
    pet?.restChanged()
    savePrefsNow()
    log('rest-at-home', { on: restAtHome })
  },
  restNow: () => pet?.goHome(),
  toggleRoam: () => actions.setRoam(roam === 'dock' ? 'desktop' : 'dock'),
  setRoam: (mode) => {
    roam = mode
    pet?.roamChanged()
    savePrefsNow()
    log('roam', { mode: roam })
  },
  toggleMute: () => voice?.toggleMute(),
  testVoice: () => voice?.speakTest(),
  changePet: () => showPetDrawer(),
  resetPet: () => applyPet(null, 'Back to the default cat.'),
  setVoice: (choice) => applyVoice(choice),
  setup: () => showSetupDrawer(),
  moreVoices: () => showSetupDrawer(),
  quit: () => app.quit()
}

// ---------- voice ----------
// ---------- speech to text ----------
/** The installed offline speech model to use: speech.model, else the best installed one (accurate English first). */
function speechModelDir(st: Settings): string {
  const base = join(app.getPath('userData'), 'speech', 'models')
  const ok = (id: string): boolean => existsSync(join(base, id, 'tokens.txt'))
  if (st.speech.model) return ok(st.speech.model) ? join(base, st.speech.model) : ''
  try {
    const ids = readdirSync(base).filter(ok).sort((a, b) => (a === 'stt-en' ? -1 : b === 'stt-en' ? 1 : a.localeCompare(b)))
    return ids[0] ? join(base, ids[0]) : ''
  } catch {
    return ''
  }
}

/** macOS: Apple's on-device recogniser when its helper is built (unless speech.engine is "local"); everywhere else the offline models. */
function makeStt(appleHelper: string): SpeechToText {
  const st = settingsRef!
  if (e2e && process.env['PET_STT_HELPER']) return new HelperStt({ helperPath: appleHelper })
  const apple = process.platform === 'darwin' && st.speech.engine !== 'local' && existsSync(appleHelper)
  if (apple || (process.platform === 'darwin' && st.speech.engine === 'apple')) return new HelperStt({ helperPath: appleHelper })
  const python = st.voice.local.python || join(app.getPath('userData'), 'voices', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const model = speechModelDir(st)
  return new HelperStt({
    helperPath: python,
    helperArgs: [join(import.meta.dirname, '../../native/stt/stt_server.py'), '--model', model],
    ready: () => model !== '',
    notInstalledMessage: 'Offline speech recognition is not set up. Open Set up (the plug button in the chat header) and download the voices and speech recognition.'
  })
}


const modelsDirFor = (st: Settings | null): string => st?.voice.local.modelsDir || join(app.getPath('userData'), 'voices', 'models')

function initialVoiceChoice(st: Settings, prefs: Prefs, allowLocal: boolean): VoiceChoice {
  const pv = prefs.voice
  if (pv?.engine === 'say') return { engine: 'say', sayVoice: pv.sayVoice ?? st.voice.voice }
  if (pv?.engine === 'local' && pv.model && allowLocal) return { engine: 'local', model: pv.model, sid: pv.sid ?? 0 }
  if (st.voice.engine === 'say' || !allowLocal) return { engine: 'say', sayVoice: st.voice.voice }
  return { engine: 'local', model: st.voice.local.model, sid: st.voice.local.sid }
}

/** The engine for a voice choice. A local voice that is not installed (or no Python for it) falls back to the macOS voice. */
function makeTts(choice: VoiceChoice): SwitchableTts['current'] {
  const st = settingsRef!
  const say = (name: string): SayTts =>
    sayBinOverride
      ? new SayTts({ voice: name, rate: st.voice.rate, bin: sayBinOverride, onError: (message) => voice?.reportError(message) }) // tests: a silent fake
      : createSystemTts({ voice: name, rate: st.voice.rate, onError: (message) => voice?.reportError(message) })
  if (choice.engine === 'say') return say(choice.sayVoice)
  const entry = installedVoices(voiceCatalog, modelsDirFor(st)).find((v) => v.id === choice.model)
  const python = st.voice.local.python || join(app.getPath('userData'), 'voices', 'venv', 'bin', 'python')
  if (!entry || !existsSync(python)) {
    console.warn(`The local voice "${choice.model}" is not installed (open Set up to download voices, or run: npm run voices -- install ${choice.model}); using the macOS voice`)
    return say(st.voice.voice)
  }
  const l = st.voice.local
  return new LocalTts({
    python,
    script: join(import.meta.dirname, '../../native/tts/tts_server.py'),
    family: entry.family,
    modelDir: entry.dir,
    sid: choice.sid,
    pitch: l.pitch,
    speed: l.speed,
    onError: (message) => voice?.reportError(message)
  })
}

/** Switch the voice while the app runs, remember the choice, and let the new voice say hello. */
function applyVoice(choice: VoiceChoice): void {
  if (!tts || !settingsRef) return
  voiceChoice = choice
  tts.use(makeTts(choice))
  const cur = tts.current
  if (cur instanceof LocalTts) cur.warmUp()
  prefsState = {
    ...prefsState,
    voice: choice.engine === 'say' ? { engine: 'say', sayVoice: choice.sayVoice } : { engine: 'local', model: choice.model, sid: choice.sid }
  }
  savePrefsNow()
  log('voice', { ...choice })
  voice?.speakTest()
}

/** The system voices, for the menu: macOS `say -v ?`, or the installed Windows (SAPI) voices. Other systems: just the default. */
function refreshSayVoices(): void {
  const keep = (names: Array<string | undefined>): void => {
    sayVoiceNames = [...new Set(names.filter((n): n is string => Boolean(n) && /^[\p{L}\p{N} ().'_-]{1,60}$/u.test(n!)))].sort((a, b) => a.localeCompare(b))
  }
  if (process.platform === 'darwin') {
    execFile('/usr/bin/say', ['-v', '?'], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (!err) keep(String(stdout).split('\n').map((l) => /^(.+?)\s{2,}[a-z]{2,3}[_-][A-Za-z0-9]{2,4}\s+#/.exec(l)?.[1]?.trim()))
    })
  } else if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) keep(String(stdout).split(/\r?\n/).map((l) => l.trim()))
    })
  }
}

const assistantInfo = (): AssistantInfo =>
  usingAi && providerInfo
    ? { name: `${providerInfo.service} (${model})`, offline: false, model, models: modelChoices, ...(providerInfo.hasEffort ? { effort, efforts: [...EFFORTS] } : {}) }
    : { name: 'offline demo', offline: true }

const assistantText = (): string =>
  usingAi && providerInfo ? `Assistant: ${providerInfo.service} (${model}${providerInfo.hasEffort && effort !== 'auto' ? `, ${effort} effort` : ''})` : 'Assistant: offline demo (no AI, no network)'

// ---------- change your pet ----------

const petName = (): string => petStore?.current?.name ?? 'DeskPet cat'

function petUiState(): PetUiState {
  return {
    busy: petBusy,
    name: petName(),
    canUndo: petStore?.canUndo === true,
    isDefault: petStore?.current === null,
    hasAi: usingAi,
    canSeeImages: usingAi && providerInfo?.hasVision === true,
    supported: settingsRef?.cat.view === 'figure',
    presets: petPresets.map((p) => ({ id: p.id, name: p.spec.name })),
    message: petMessage.text,
    error: petMessage.error
  }
}
const pushPet = (): void => chat?.send(Channels.chatPetState, petUiState())

function setPetMessage(text: string, error = false): void {
  petMessage = { text, error }
  pushPet()
}

function showPetDrawer(): void {
  if (!pet || pet.isHidden) return
  if (!chat?.isOpen) chat?.open()
  // the panel may still be loading: it asks for the state itself when it is ready
  setTimeout(() => chat?.send(Channels.chatPetShow, null), 300)
  pushPet()
}

/** Open the chat with the "Set up" drawer (connect an AI, download voices). */
function showSetupDrawer(): void {
  if (!pet || pet.isHidden) return
  if (!chat?.isOpen) chat?.open()
  // the panel may still be loading: it asks for the state itself when it is ready
  setTimeout(() => chat?.send(Channels.chatSetupShow, null), 300)
  setup?.refresh()
}

/** Draw `spec` (null = the default cat) on the pet, remember it, and tell the drawer. */
function applyPet(spec: PetSpec | null, message: string): void {
  petStore?.set(spec)
  if (win && !win.isDestroyed()) win.webContents.send(Channels.petSpec, spec)
  pet?.alert(2500) // a little wiggle of surprise
  log('pet-look', { name: spec?.name ?? null })
  setPetMessage(message)
}

/**
 * Restyle the pet from a description and optional pictures. With an AI connected the AI writes the design (validated before it is
 * used); without one only a plain recolour ("make my cat green") works. `fromChat` also reports in the chat transcript.
 */
async function designPetLook(text: string, images: PetImage[], fromChat: boolean): Promise<void> {
  const say = (m: string, error = false): void => {
    setPetMessage(m, error)
    if (fromChat) session?.notice(m, error)
  }
  if (petBusy) return say('Still working on the last change. One moment.', true)
  if (settingsRef?.cat.view !== 'figure') return say('Custom pets need the standing figure view: set "cat.view": "figure" in settings.json.', true)
  if (!usingAi || !providerInfo) {
    const r = quickRecolour(text, petStore?.current ?? null)
    if (r) return applyPet(r, `Done: ${r.name}.`)
    return say('Without an AI I can only recolour ("make my cat green") or use a ready-made pet. Connect an AI (🔌 Set up in the chat header) to design anything, from a description or pictures.', true)
  }
  if (images.length > 0 && !providerInfo.hasVision) return say(`${providerInfo.service} cannot look at pictures. Describe the look in words instead, or switch to a provider that can see images.`, true)
  petBusy = true
  petAbort = new AbortController()
  const timer = setTimeout(() => petAbort?.abort(), 180_000)
  say(images.length ? `Designing from your ${images.length} picture${images.length === 1 ? '' : 's'}…` : 'Designing…')
  try {
    const designer = createProvider({
      ai: settingsRef.ai,
      env: process.env,
      keyStore: (a) => keyStore?.get(a) ?? null,
      workdir: join(app.getPath('userData'), 'ai-home', 'pet'),
      model: () => model,
      effort: () => undefined,
      systemPrompt: () => designerSystemPrompt(petStore?.current ?? null, petPresets)
    })
    const r = await designPet({ provider: designer, instructions: text, images, signal: petAbort.signal })
    designer.dispose?.()
    if ('error' in r) say(r.error, true)
    else {
      applyPet(r.spec, r.note ? `${r.spec.name}: ${r.note}` : `Done: ${r.spec.name}.`)
      if (fromChat) session?.notice(`Your pet is now "${r.spec.name}". ${r.note}`.trim())
    }
  } finally {
    clearTimeout(timer)
    petAbort = null
    petBusy = false
    pushPet()
  }
}

const menuInfo = (v: VoiceController): VoiceMenuInfo => ({
  listening: v.phase !== 'idle',
  muted: v.muted,
  assistant: assistantLabel,
  screenEnabled: screenSvc?.enabled === true,
  watchAvailable: watchAvailable(),
  watching: observer?.watching === true,
  bringWithMe,
  roam,
  restAtHome,
  resting: pet?.isResting === true,
  voices: {
    engine: voiceChoice.engine,
    model: voiceChoice.engine === 'local' ? voiceChoice.model : '',
    sid: voiceChoice.engine === 'local' ? voiceChoice.sid : 0,
    sayVoice: voiceChoice.engine === 'say' ? voiceChoice.sayVoice : '',
    installed: installedVoices(voiceCatalog, modelsDirFor(settingsRef)),
    sayVoices: sayVoiceNames
  }
})

const savePrefsNow = (): void => {
  prefsState = { ...prefsState, provider: settingsRef?.ai.provider ?? 'mock', model, ...(effort !== 'auto' ? { effort } : {}), bringWithMe, roam, rest: restAtHome }
  if (effort === 'auto') delete prefsState.effort
  try {
    savePrefs(prefsPath, prefsState)
  } catch (err) {
    console.warn(`could not save the model choice: ${(err as Error).message}`)
  }
}

function setModelChoice(choice: { model?: string; effort?: string }): void {
  if (!session) return
  if (!usingAi) return void session.notice('The offline demo has no models. Connect an AI first: open Set up (the plug button in the chat header).', true)
  if (choice.model !== undefined) {
    model = choice.model
    if (!modelChoices.includes(model)) modelChoices = [...modelChoices, model]
  }
  if (choice.effort !== undefined) {
    if (!providerInfo?.hasEffort) return void session.notice('Reasoning effort is only available with the Claude subscription (`claude` command) provider.', true)
    effort = choice.effort
  }
  savePrefsNow()
  session.setAssistant(assistantInfo())
  assistantLabel = assistantText()
  session.notice(`Now using ${model}${providerInfo?.hasEffort && effort !== 'auto' ? ` with ${effort} effort` : ''}. This applies from your next message.`)
  log('model', { model, effort })
}

/** Run a command the app handles itself (never sent to the assistant). */
function runCommand(cmd: ChatCommand): void {
  if (!session) return
  switch (cmd.kind) {
    case 'model':
      return setModelChoice({ model: cmd.model })
    case 'effort':
      return setModelChoice({ effort: cmd.effort })
    case 'new':
      voice?.stopSpeaking()
      session.clear()
      return session.notice('Started a fresh conversation. Your saved memory is still available.')
    case 'pet':
      if (!cmd.text) return showPetDrawer()
      return void designPetLook(cmd.text, [], true)
    case 'help':
      return session.notice(helpText(modelChoices, providerInfo?.hasEffort === true))
    case 'bad':
      return session.notice(cmd.message, true)
  }
}

const setScreenState = (patch: Partial<ScreenUiState>): void => {
  screenState = { ...screenState, ...patch }
  chat?.pushScreen(screenState)
}

const watchAvailable = (): boolean => observeAllowed && screenState.enabled

/** What the panel and the pet's badge show about watching. */
let lastWatchedApp: string | null = null
function refreshWatchUi(w: WatchState | null = observer?.state() ?? null): void {
  if (quitting) return // windows are going away: nothing left to tell
  // a small cosmetic reaction to the app you just switched to, only if you turned proactive behaviour on (nothing is sent)
  if (w && w.phase === 'watching' && w.app && w.app !== lastWatchedApp && lastWatchedApp !== null && proactiveReactions) pet?.alert(2500)
  lastWatchedApp = w?.phase === 'watching' ? w.app : null
  const watch = {
    ...IDLE_WATCH_STATE,
    available: watchAvailable(),
    on: observer?.watching === true,
    phase: w?.phase ?? 'off',
    app: w?.app ?? null,
    checks: w?.stats.windowChecks ?? 0,
    samples: w?.stats.pixelSamples ?? 0,
    fired: w?.stats.triggers ?? 0,
    sent: proactiveSent
  } as const
  setScreenState({ watch })
  if (win && !win.isDestroyed()) win.webContents.send(Channels.petBadge, { watching: watch.on && watch.phase !== 'paused-excluded', paused: watch.on && watch.phase === 'paused-excluded', nudge: screenState.nudge !== null })
  if (tray && !tray.isDestroyed()) tray.setToolTip(watch.on ? (watch.phase === 'paused-excluded' ? 'DeskPet (watching paused: excluded app on screen)' : 'DeskPet (watching)') : 'DeskPet')
}

function clearNudge(): void {
  if (nudgeTimer) clearTimeout(nudgeTimer)
  nudgeTimer = null
  if (screenState.nudge) setScreenState({ nudge: null })
  refreshWatchUi()
}

/** A rule fired. Nothing has been sent: a nudge waits for the user; an "ask" (only with proactive.enabled) goes ahead and says so. */
function onTrigger(t: Trigger): void {
  log('watch-trigger', { app: t.app, action: t.action, change: Number(t.change.toFixed(3)) })
  if (t.action === 'ask') {
    if (!session || session.busy || screenBusy) return
    if (pet && !pet.isHidden && !chat?.isOpen) chat?.open() // an automatic question is always visible
    session.notice(`Rule for ${t.app}: sending a screenshot to the assistant on its own (proactive.enabled is on). Say /new or switch watching off to stop this.`)
    void sendWithScreen(t.rule.prompt, t.rule.prompt, true).then((ok) => {
      if (ok) {
        proactiveSent++
        refreshWatchUi()
      }
    })
    return
  }
  pet?.alert(6000) // perks up (cosmetic; never during a conversation)
  setScreenState({ nudge: { app: t.app, prompt: t.rule.prompt } })
  if (nudgeTimer) clearTimeout(nudgeTimer)
  nudgeTimer = setTimeout(clearNudge, 3 * 60_000)
  nudgeTimer.unref()
  refreshWatchUi()
}

/** Everything the pet keeps about the user, for the data drawer. */
function buildData(): DataSnapshot {
  const msgs = session?.snapshot().messages ?? []
  const real = msgs.filter((m) => m.role === 'user' || m.role === 'assistant')
  return {
    memoryRead: memoryReadOn,
    memoryWrite: memoryWriteOn,
    memoryDir,
    memory: memoryReadOn || memoryWriteOn ? listMemoryFiles(memoryDir) : [],
    messages: real.length,
    summarizedMessages: real.filter((m) => m.summarized).length,
    summary: session?.summaryText ?? '',
    summarizeEnabled: summarizeOn
  }
}
const pushData = (): void => chat?.send(Channels.chatData, buildData())

/** Capture the screen (only ever called because the user asked) and send `text` with it; on failure, say why and give the text back. */
async function sendWithScreen(text: string, typed: string = text, automatic = false): Promise<boolean> {
  if (!session || !screenSvc || screenBusy || session.busy) return false
  screenBusy = true
  setScreenState({ armed: false, busy: true, error: null })
  let result: ScreenResult
  try {
    result = await screenSvc.captureForRequest()
  } catch (err) {
    result = { ok: false, message: `Couldn't capture the screen (${(err as Error).message.slice(0, 80)}).`, fix: null }
  }
  screenBusy = false
  if (!result.ok) {
    setScreenState({ busy: false, error: { message: result.message, fix: result.fix } })
    session.notice(result.message, true)
    if (!automatic) chat?.restoreText(typed) // exactly what the user typed, command word included
    log('screen-refused', { fix: result.fix, automatic })
    return false
  }
  const attachment: Attachment = { screenshotBase64: result.image.base64, screenshotMime: result.image.mime, thumbDataUrl: result.image.thumbDataUrl }
  log('screen-sent', { w: result.image.width, h: result.image.height, bytes: result.image.base64.length })
  session.send(text, attachment)
  session.notice(result.description)
  setScreenState({ busy: false })
  return true
  // `attachment` and `result` go out of scope here: the image is not kept anywhere.
}

/** Only accept IPC from the matching window's own renderer. */
const fromPet = (e: IpcMainEvent): boolean => win !== null && e.sender === win.webContents
const fromChat = (e: IpcMainEvent): boolean => chat?.webContents != null && e.sender === chat.webContents

function registerIpc(): void {
  ipcMain.on(Channels.hover, (e, payload: unknown) => {
    const over = parseHover(payload)
    if (fromPet(e) && over !== null) pet?.setHover(over)
  })
  if (e2e) {
    // test-only commands (never registered in a normal run)
    ipcMain.on(Channels.petE2E, (e, payload: unknown) => {
      const p = payload as { cmd?: unknown; arg?: unknown } | null
      if (!fromPet(e) || typeof p?.cmd !== 'string') return
      if (p.cmd === 'drop') {
        const a = p.arg as { x?: unknown; y?: unknown } | null
        if (typeof a?.x === 'number' && typeof a?.y === 'number') pet?.debugDrop(a.x, a.y)
      } else if (p.cmd === 'toggleBringWithMe') actions.toggleBringWithMe()
      else if (p.cmd === 'toggleRest') actions.toggleRest()
      else if (p.cmd === 'restNow') actions.restNow()
      else if (p.cmd === 'wake') pet?.debugWake()
      else if (p.cmd === 'toggleRoam') actions.toggleRoam()
    })
  }
  ipcMain.on(Channels.dragStart, (e) => fromPet(e) && pet?.beginDrag())
  ipcMain.on(Channels.dragMove, (e) => fromPet(e) && pet?.moveDrag())
  ipcMain.on(Channels.dragEnd, (e) => fromPet(e) && pet?.endDrag())
  ipcMain.on(Channels.click, (e) => {
    if (!fromPet(e) || !pet || pet.isHidden) return
    // a click wakes him and opens the chat; clicking him again closes it and he goes back to sleep
    if (chat?.isOpen) {
      sleepAfterClose = true
      chat.close()
    } else chat?.open()
  })
  ipcMain.on(Channels.contextMenu, (e) => {
    if (fromPet(e) && pet && win && voice) buildMenu(pet, actions, menuInfo(voice)).popup({ window: win })
  })

  ipcMain.on(Channels.chatReady, (e) => fromChat(e) && chat?.sendLatest())
  ipcMain.on(Channels.chatSend, (e, payload: unknown) => {
    const text = parseChatText(payload)
    if (!fromChat(e) || text === null) return
    if (voice && voice.phase !== 'idle') return // the box is read-only while listening; ignore a stray send
    const cmd = parseCommand(text, modelChoices)
    spokenTurn = false // typed, not said
    if (screenBusy) return void chat?.restoreText(text)
    if (cmd?.kind === 'look' || (screenState.armed && screenState.enabled)) {
      clearNudge()
      if (!usingAi) return void session?.notice('The offline demo cannot look at screenshots. Connect an AI first: open Set up (the plug button in the chat header).', true)
      if (providerInfo && !providerInfo.hasVision) return void session?.notice(`${providerInfo.service} cannot look at screenshots. Pick another provider to share your screen (see the README).`, true)
      return void sendWithScreen(cmd?.kind === 'look' ? cmd.question : text, text)
    }
    if (cmd && usingAi) return void runCommand(cmd) // the mock keeps its own /slow, /fail... commands
    if (cmd && (cmd.kind === 'new' || cmd.kind === 'help' || cmd.kind === 'bad' || cmd.kind === 'pet')) return void runCommand(cmd)
    log('chat-send', { result: session?.send(text) })
  })
  ipcMain.on(Channels.chatSetModel, (e, payload: unknown) => {
    const choice = parseModelChoice(payload)
    if (fromChat(e) && choice) setModelChoice(choice)
  })
  ipcMain.on(Channels.chatArmScreen, (e) => {
    if (!fromChat(e) || !screenState.enabled || screenBusy) return
    setScreenState({ armed: !screenState.armed, error: null })
  })
  ipcMain.on(Channels.chatDataOpen, (e) => fromChat(e) && pushData())
  ipcMain.on(Channels.chatPetOpen, (e) => fromChat(e) && pushPet())
  ipcMain.on(Channels.chatSetupOpen, (e) => fromChat(e) && setup?.refresh())
  ipcMain.on(Channels.chatSetupTest, (e, payload: unknown) => {
    const req = parseSetupRequest(payload)
    if (fromChat(e) && req) void setup?.test(req)
  })
  ipcMain.on(Channels.chatSetupSave, (e, payload: unknown) => {
    const req = parseSetupRequest(payload)
    if (fromChat(e) && req) setup?.save(req)
  })
  ipcMain.on(Channels.chatSetupVoices, (e, payload: unknown) => {
    const pack = parseVoicePack(payload)
    if (fromChat(e) && pack) void setup?.installVoices(pack)
  })
  ipcMain.on(Channels.chatSetupVoicesCancel, (e) => fromChat(e) && setup?.cancelVoices())
  ipcMain.on(Channels.chatPetDesign, (e, payload: unknown) => {
    const req = parsePetDesignRequest(payload)
    if (!fromChat(e) || !req) return
    log('pet-design', { chars: req.text.length, images: req.images.length })
    void designPetLook(req.text, req.images, false)
  })
  ipcMain.on(Channels.chatPetAction, (e, payload: unknown) => {
    const a = parsePetAction(payload)
    if (!fromChat(e) || !a || petBusy) return
    if (a.kind === 'undo') {
      if (!petStore?.undo()) return setPetMessage('Nothing to undo.', true)
      if (win && !win.isDestroyed()) win.webContents.send(Channels.petSpec, petStore.current)
      return setPetMessage(`Back to: ${petName()}.`)
    }
    if (a.kind === 'reset') return applyPet(null, 'Back to the default cat.')
    const preset = petPresets.find((p) => p.id === a.id)
    if (preset) applyPet(preset.spec, `Done: ${preset.spec.name}.`)
  })
  ipcMain.on(Channels.chatMemoryView, (e, payload: unknown) => {
    const file = parseMemoryFile(payload)
    if (!fromChat(e) || !file || !isMemoryFileName(file)) return
    const text = readMemoryFile(memoryDir, file)
    if (text !== null) chat?.send(Channels.chatMemoryText, { file, text })
  })
  ipcMain.on(Channels.chatMemoryDelete, (e, payload: unknown) => {
    const file = parseMemoryFile(payload)
    // only a file that really is in the memory folder's listing can be removed; it goes to the Trash, so it is recoverable
    if (!fromChat(e) || !file || !listMemoryFiles(memoryDir).some((m) => m.file === file)) return
    // (test runs delete directly instead, so they never put files in the real Trash)
    void (e2e && process.env['PET_NO_TRASH'] === '1' ? Promise.resolve(rmSync(join(memoryDir, file))) : shell.trashItem(join(memoryDir, file)))
      .then(() => {
        removeFromIndex(memoryDir, file)
        session?.notice(`Moved ${file} to the Trash and removed it from your memory index.`)
        log('memory-deleted', { file })
      })
      .catch((err: Error) => session?.notice(`Couldn't remove ${file} (${err.message.slice(0, 80)}).`, true))
      .finally(pushData)
  })
  ipcMain.on(Channels.chatSummaryClear, (e) => {
    if (!fromChat(e) || !session) return
    session.clearSummary()
    session.notice('Forgot the summary of the older part of this conversation.')
    pushData()
  })
  ipcMain.on(Channels.chatRevealMemory, (e) => {
    if (fromChat(e) && memoryDir) void shell.openPath(memoryDir)
  })
  ipcMain.on(Channels.chatQuit, (e) => fromChat(e) && app.quit()) // "put him away": fully off
  ipcMain.on(Channels.chatCollapse, (e) => fromChat(e) && chat?.toggleCollapsed())
  ipcMain.on(Channels.chatResizeStart, (e) => fromChat(e) && chat?.beginResize())
  ipcMain.on(Channels.chatResizeBy, (e, payload: unknown) => {
    const p = payload as { dx?: unknown; dy?: unknown } | null
    if (!fromChat(e) || typeof p?.dx !== 'number' || typeof p?.dy !== 'number') return
    if (Math.abs(p.dx) > 10_000 || Math.abs(p.dy) > 10_000) return
    chat?.resizeBy(p.dx, p.dy)
  })
  ipcMain.on(Channels.chatResizeEnd, (e) => fromChat(e) && chat?.endResize())
  ipcMain.on(Channels.chatToggleWatch, (e) => fromChat(e) && actions.toggleWatch())
  ipcMain.on(Channels.chatNudgeLook, (e) => {
    const n = screenState.nudge
    if (!fromChat(e) || !n || !usingAi) return
    clearNudge()
    void sendWithScreen(n.prompt)
  })
  ipcMain.on(Channels.chatNudgeDismiss, (e) => fromChat(e) && clearNudge())
  ipcMain.on(Channels.chatNew, (e) => fromChat(e) && runCommand({ kind: 'new' }))
  // Stop / Esc undoes the most active thing: the request, else the voice, else the microphone (discarding it).
  ipcMain.on(Channels.chatCancel, (e) => {
    if (!fromChat(e)) return
    if (session?.busy) session.cancel()
    else if (voice?.speaking) voice.stopSpeaking()
    else voice?.cancelListening()
  })
  ipcMain.on(Channels.chatMic, (e) => fromChat(e) && voice?.toggleListen())
  ipcMain.on(Channels.chatMute, (e) => fromChat(e) && voice?.toggleMute())
  ipcMain.on(Channels.chatOpenSettings, (e) => {
    if (!fromChat(e)) return
    // The URL is chosen here from the last error; the renderer cannot supply one.
    const fix = voice?.snapshot().error?.fix
    const pane = screenState.error?.fix === 'screen' ? 'Privacy_ScreenCapture' : fix === 'microphone' ? 'Privacy_Microphone' : fix === 'speech' ? 'Privacy_SpeechRecognition' : null
    if (pane && process.platform === 'darwin') void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    else if (pane && process.platform === 'win32') void shell.openExternal(pane === 'Privacy_Microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy')
  })
  // The chat panel's look: validated here, kept in memory and saved to its own small file (never settings.json).
  ipcMain.on(Channels.chatSetTheme, (e, payload: unknown) => {
    const t = parseTheme(payload)
    if (!fromChat(e) || t === null) return
    theme = t
    try {
      saveTheme(themePath, t)
    } catch (err) {
      console.warn(`could not save the chat look: ${(err as Error).message}`)
    }
    log('chat-theme', { ...t })
  })
  ipcMain.on(Channels.chatClose, (e) => fromChat(e) && chat?.close())
}

function createTray(): void {
  // macOS draws a black template image in the menu bar's colours; Windows and Linux trays need a coloured icon.
  let icon = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/tray/trayTemplate.png'))
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  else icon = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/icon/deskpet.png')).resize({ width: 24, height: 24 })
  tray = new Tray(icon)
  tray.setToolTip('DeskPet')
  // Rebuild the menu each time it opens so the labels reflect the current state.
  const open = (): void => tray?.popUpContextMenu(pet && voice ? buildMenu(pet, actions, menuInfo(voice)) : undefined)
  tray.on('click', open)
  tray.on('right-click', open)
}

function registerShortcut(accelerator: string, label: string, fn: () => void): void {
  try {
    if (!globalShortcut.register(accelerator, fn)) throw new Error('already in use by another app')
  } catch (e) {
    console.warn(`Could not register ${label} shortcut "${accelerator}": ${(e as Error).message}. Use the tray or right-click menu.`)
  }
}

/** The OS's secure storage, through Electron. Weak "basic text" fallbacks (Linux without a keyring) do not count. */
const osCipher: Cipher = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    } catch {
      return false
    }
  },
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b)
}

/** The headless key tool behind `npm run setup`: prints one JSON line and exits. */
async function runKeyTool(t: { action: string; account: string }): Promise<void> {
  const out = (o: Record<string, unknown>): void => void process.stdout.write(JSON.stringify(o) + '\n')
  const store = new KeyStore(join(app.getPath('userData'), 'keys.json'), osCipher)
  try {
    if (t.action === 'has') out({ ok: true, has: store.has(t.account), secure: store.secure })
    else if (t.action === 'delete') (store.delete(t.account), out({ ok: true }))
    else if (t.action === 'store') {
      let key = ''
      process.stdin.setEncoding('utf8')
      for await (const c of process.stdin) key += c
      store.set(t.account, key)
      out({ ok: true })
    } else out({ ok: false, error: 'unknown action' })
  } catch (e) {
    out({ ok: false, error: (e as Error).message })
  }
  app.exit(0)
}

app.whenReady().then(() => {
  if (keyTool) return void runKeyTool(keyTool)
  keyStore = new KeyStore(join(app.getPath('userData'), 'keys.json'), osCipher)
  // A real app: a Dock icon (the cat house) with a running dot while he is on, Cmd+Q / Dock > Quit to turn him fully off.
  // The Edit menu is what makes copy/paste work in the chat box.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/icon/deskpet.png'))
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: 'Chat…', click: () => actions.toggleChat() },
        { label: 'Hide / show the cat', click: () => actions.toggleHidden() }
      ])
    )
  }

  const { settings, warnings } = loadSettings(join(app.getPath('userData'), 'settings.json'))
  settingsRef = settings
  if (e2e && process.env['PET_VOICE_LIVE']) settings.voice.live = process.env['PET_VOICE_LIVE'] === '1' // test-only: the push-to-talk checks predate live conversation
  petStore = new PetStore(join(app.getPath('userData'), 'pet.json'))
  petPresets = loadPresets(join(import.meta.dirname, '../../assets'))
  for (const w of warnings) console.warn(`settings: ${w}`)
  themePath = join(app.getPath('userData'), 'theme.json')
  const loaded = loadTheme(themePath)
  theme = loaded.theme
  if (loaded.warning) console.warn(`theme: ${loaded.warning}`)
  const sleepAfterMs = e2e && process.env['PET_SLEEP_AFTER_MS'] ? Number(process.env['PET_SLEEP_AFTER_MS']) : settings.sleepAfterMs

  const windowHelper = e2e && process.env['PET_WINDOW_HELPER'] ? process.env['PET_WINDOW_HELPER'] : join(import.meta.dirname, '../../native/window-helper')
  screenState = { ...IDLE_SCREEN_STATE, enabled: settings.screen.enabled }
  observeAllowed = settings.observe.enabled
  proactiveReactions = settings.proactive.enabled
  // Only macOS can list the other apps' windows (walking around their edges, the exclusion list, watching rules). Elsewhere those switch off.
  const windowSource = process.platform === 'darwin' || (e2e && process.env['PET_WINDOW_HELPER'])
    ? new SwiftWindows(windowHelper, e2e && process.env['PET_FAKE_WINDOWS_FILE'] ? { PET_FAKE_WINDOWS_FILE: process.env['PET_FAKE_WINDOWS_FILE'], PATH: process.env['PATH'] ?? '/usr/bin:/bin' } : {})
    : new NoWindows()
  screenSvc = new ScreenService({
    settings: () => settings.screen,
    windows: windowSource,
    windowCheckHelp: process.platform === 'darwin' ? undefined : "Not captured: on this system DeskPet cannot see which apps are on screen, so it cannot promise your exclusion list (password managers) is respected. Close those apps and set \"screen\": { \"allowUnchecked\": true } in settings.json to share your screen anyway.",
    capturer: e2e && process.env['PET_FAKE_CAPTURE'] === '1' ? new FakeCapturer() : new ElectronCapturer(),
    displayBounds: (which) => {
      const d = which === 'main' || !pet ? electronScreen.getPrimaryDisplay() : electronScreen.getDisplayMatching(pet.getBounds())
      return { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }
    },
    hideOwnWindows: async () => {
      const wins = [win, chat?.browserWindow].filter((w): w is BrowserWindow => w != null && !w.isDestroyed())
      for (const w of wins) w.setOpacity(0) // so neither the cat nor the chat panel is in the picture
      await new Promise((r) => setTimeout(r, 150))
      return () => {
        for (const w of wins) if (!w.isDestroyed()) w.setOpacity(1)
      }
    },
    permission: () => {
      if (e2e && process.env['PET_SCREEN_PERMISSION']) return process.env['PET_SCREEN_PERMISSION'] as 'granted'
      if (process.platform === 'linux') return 'granted' // no screen-recording permission to ask for
      try {
        return systemPreferences.getMediaAccessStatus('screen')
      } catch {
        return 'unknown'
      }
    }
  })

  const displayRect = (which: 'pet' | 'main'): { x: number; y: number; w: number; h: number } => {
    const d = which === 'main' || !pet ? electronScreen.getPrimaryDisplay() : electronScreen.getDisplayMatching(pet.getBounds())
    return { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }
  }
  const fakePixels = e2e ? process.env['PET_FAKE_PIXELS_FILE'] : undefined
  const intervalOverride = e2e && process.env['PET_OBSERVE_INTERVAL_MS'] ? Number(process.env['PET_OBSERVE_INTERVAL_MS']) : null
  observer = new ScreenObserver({
    settings: () => ({
      observe: intervalOverride !== null ? { ...settings.observe, intervalSeconds: intervalOverride / 1000 } : settings.observe,
      excludeApps: settings.screen.excludeApps,
      proactive: settings.proactive.enabled
    }),
    windows: windowSource,
    sampler: fakePixels ? new FakeSampler(fakePixels) : new ElectronSampler(),
    displayBounds: () => displayRect(settings.screen.display),
    onTrigger,
    onState: (w) => refreshWatchUi(w)
  })
  const sleepWatch = (): void => observer?.suspend(true)
  const wakeWatch = (): void => observer?.suspend(pet?.isHidden === true)
  powerMonitor.on('lock-screen', sleepWatch)
  powerMonitor.on('suspend', sleepWatch)
  powerMonitor.on('unlock-screen', wakeWatch)
  powerMonitor.on('resume', wakeWatch)
  refreshWatchUi(null)

  prefsPath = join(app.getPath('userData'), 'prefs.json')
  prefsState = loadPrefs(prefsPath)
  bringWithMe = prefsState.bringWithMe ?? settings.cat.bringWithMe
  roam = prefsState.roam ?? settings.cat.roam
  if (process.platform !== 'darwin' && roam === 'edges') roam = 'desktop' // walking around other windows needs the macOS window helper
  restAtHome = prefsState.rest ?? settings.cat.restAtHome
  if (e2e && process.env['PET_REST']) restAtHome = process.env['PET_REST'] === '1'
  if (e2e && process.env['PET_ROAM']) roam = process.env['PET_ROAM'] === 'dock' ? 'dock' : process.env['PET_ROAM'] === 'edges' ? 'edges' : 'desktop'
  if (e2e && process.env['PET_BRING'] === '1') bringWithMe = true

  win = createPetWindow({
    view: settings.cat.view,
    coat: settings.cat.coat,
    pixel: String(settings.cat.pixelSize),
    ...(debug || e2e ? { debug: '1' } : {}),
    ...(e2e && process.env['PET_VIEW'] === 'sprite' ? { view: 'sprite' } : {})
  })
  applyLevel(win, bringWithMe)
  const desktopIcons = new DesktopIcons({ onDenied: () => console.warn('Finder access refused: DeskPet cannot see the desktop icons, so the pet may walk over them') })
  pet = new PetController(win, {
    sleepAfterMs,
    onMoved: (b) => chat?.follow(b),
    roam: () => roam,
    windows: async () => (await windowSource.snapshot())?.windows.filter((w) => w.pid !== process.pid) ?? null,
    obstacles: e2e ? undefined : () => desktopIcons.boxes(),
    food: { list: () => pond?.list() ?? [], eaten: (id) => pond?.eaten(id) },
    rest: () => restAtHome,
    home: () => prefsState.home ?? null,
    onHomeChanged: (home) => {
      prefsState = { ...prefsState, home }
      savePrefsNow()
    }
  })

  // Voice (Phase 3): macOS `say` for output, a Swift helper (microphone + SFSpeechRecognizer) for input.
  // Test mode may substitute fake binaries; a normal run never reads these overrides.
  const helperPath = e2e && process.env['PET_STT_HELPER'] ? process.env['PET_STT_HELPER'] : join(import.meta.dirname, '../../native/speech-helper')
  const sayBin = e2e && process.env['PET_SAY_BIN'] ? process.env['PET_SAY_BIN'] : undefined
  sayBinOverride = sayBin
  // The voice: a local neural voice (installed with `npm run voices`) unless settings or the menu say "say", none is installed,
  // or this is a test run with a fake `say`. The menu can switch it while the app runs (applyVoice).
  voiceCatalog = loadCatalog(join(import.meta.dirname, '../../assets'))
  voiceChoice = initialVoiceChoice(settings, prefsState, !sayBin)
  tts = new SwitchableTts(makeTts(voiceChoice))
  if (!sayBin) refreshSayVoices()
  if (settings.voice.speakReplies && tts.current instanceof LocalTts) tts.current.warmUp() // load the model now, so the first reply is not delayed
  voice = new VoiceController({
    stt: makeStt(helperPath),
    tts,
    settings: settings.voice,
    onState: (state) => {
      chat?.pushVoice(state)
      log('voice-state', { phase: state.phase, text: state.text, final: state.final, error: state.error?.message ?? null, notice: state.notice, muted: state.muted, speaking: state.speaking })
    },
    onListeningChange: (on) => pet?.listening(on),
    onSpeakingChange: (on) => {
      log('speaking', { on })
      pet?.speaking(on)
    },
    beforeListen: () => {
      // The user is about to talk over the pet: stop the voice, then abandon any pending request.
      voice?.stopSpeaking()
      session?.cancel('Cancelled: you started talking.')
    },
    onAutoSend: (text) => {
      spokenTurn = voice?.live === true
      session?.send(text)
    }
  })

  // Who answers is an explicit choice in settings.json ("ai.provider", set in the Set up drawer or by `npm run setup`). The default is the offline
  // demo, so a fresh install makes no network request at all.
  providerInfo = describeProvider(settings.ai)
  const real = providerInfo.preset.kind !== 'mock'
  usingAi = real
  historyPath = join(app.getPath('userData'), 'history.json')
  // a model or effort picked in the panel belongs to the service it was picked for
  const prefsMatch = prefsState.provider === settings.ai.provider
  model = (prefsMatch ? prefsState.model : undefined) ?? (settings.ai.model || providerInfo.defaultModel)
  effort = providerInfo.hasEffort && prefsMatch ? (prefsState.effort ?? 'auto') : 'auto'
  modelChoices = [...new Set<string>([...providerInfo.models, model].filter(Boolean))]
  memoryDir = settings.memory.dir || join(app.getPath('userData'), 'memory')
  const memoryOn = real && settings.memory.enabled
  const memoryWrite = memoryOn && settings.memory.write
  memoryReadOn = memoryOn
  memoryWriteOn = memoryWrite
  summarizeOn = real && settings.memory.summarize
  const baseProvider = createProvider({
    ai: settings.ai,
    env: process.env,
    keyStore: (a) => keyStore?.get(a) ?? null,
    workdir: join(app.getPath('userData'), 'ai-home'),
    model: () => model,
    effort: () => (effort === 'auto' ? undefined : effort),
    // re-read on every message, so a memory saved here (or edited by hand) is seen straight away
    systemPrompt: (info) =>
      buildSystemPrompt({ memory: memoryOn ? readMemory(memoryDir) : '', memoryWrite: memoryWrite && !info.screen, screen: info.screen, persona: settings.ai.persona, spoken: spokenTurn })
  })
  // Folds the older part of a very long conversation into a short summary (a cheap, tool-less call to the same service).
  const summaryProvider = real && settings.memory.summarize
    ? createProvider({
        ai: settings.ai,
        env: process.env,
        keyStore: (a) => keyStore?.get(a) ?? null,
        workdir: join(app.getPath('userData'), 'ai-home', 'summary'),
        model: () => providerInfo?.preset.summaryModel ?? model,
        effort: () => undefined,
        systemPrompt: () => SUMMARY_SYSTEM
      })
    : null
  summaryDispose = () => summaryProvider?.dispose?.()
  const summarizer = summaryProvider
    ? async (previous: string, turns: Parameters<typeof buildSummaryRequest>[1]): Promise<string> => {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 120_000)
        try {
          let text = ''
          for await (const c of summaryProvider.sendMessage(buildSummaryRequest(previous, turns), { history: [] }, abort.signal)) text += c
          return text
        } finally {
          clearTimeout(timer)
        }
      }
    : undefined
  const conversation = real ? loadConversation(historyPath) : { messages: [], summary: '' }
  provider = real && memoryWrite
    ? new MemoryProvider(baseProvider, {
        dir: memoryDir,
        onSaved: (entry, file, why) => {
          log('memory-saved', { file, why: why ?? null })
          if (why === 'locked') session?.notice("Not saved to memory: a screenshot was attached, and text on a screen shouldn't be able to write to your memory.", true)
          else session?.notice(entry && file ? `Saved to memory: ${file}` : "Couldn't save that to memory.", entry === null)
        }
      })
    : baseProvider
  assistantLabel = assistantText()
  log('assistant', { provider: settings.ai.provider, model: real ? model : null, memory: memoryOn, memoryWrite })
  session = new ChatSession(provider, {
    assistant: assistantInfo(),
    ...(real ? { initialMessages: conversation.messages, initialSummary: conversation.summary, maxMessages: 600, ...(summarizer ? { summarizer } : {}), ...(e2e && process.env['PET_SUMMARY_TRIGGER'] ? { compaction: { trigger: Number(process.env['PET_SUMMARY_TRIGGER']), keep: Number(process.env['PET_SUMMARY_KEEP'] ?? 800) } } : {}) } : {}),
    onPersist: (messages, summary) => {
      if (!real) return // the offline demo's chat is never written to disk
      pushData()
      try {
        saveHistory(historyPath, messages, summary)
      } catch (err) {
        console.warn(`could not save the conversation: ${(err as Error).message}`)
      }
    },
    onChange: (snapshot) => chat?.push(snapshot),
    onChunk: (chunk) => voice?.replyChunk(chunk),
    onEvent: (event, outcome) => {
      log('chat-event', { kind: event, outcome })
      if (event === 'submitted') {
        voice?.replyBegin()
        pet?.chatSubmitted()
      } else if (event === 'started') pet?.chatStarted()
      else {
        voice?.replyEnd(outcome === 'completed')
        pet?.chatEnded()
      }
    },
    timeoutMs: e2e && process.env['PET_CHAT_TIMEOUT_MS'] ? Number(process.env['PET_CHAT_TIMEOUT_MS']) : real ? settings.ai.timeoutSeconds * 1000 : 30_000
  })

  // Services that can list their models top up the panel's list (names change often); failures are silent.
  if (real && baseProvider.listModels) {
    void baseProvider.listModels().then((names) => {
      if (names.length === 0) return
      modelChoices = [...new Set([...modelChoices, ...names])]
      session?.setAssistant(assistantInfo())
    })
  }

  chat = new ChatWindow(
    () => pet!.getBounds(),
    () => session!.snapshot(),
    () => voice!.snapshot(),
    () => theme,
    () => screenState,
    {
      bringWithMe: () => bringWithMe,
      size: () => prefsState.chatSize ?? { w: 460, h: 600 },
      onResized: (size) => {
        prefsState = { ...prefsState, chatSize: size }
        savePrefsNow()
      },
      onOpen: () => {
        log('chat-open')
        voice?.clearMessages()
        pet?.chatOpened()
      },
      onClose: () => {
        log('chat-close')
        setScreenState({ armed: false, busy: false, error: null }) // an armed camera never outlives the panel
        voice?.shutdown() // a closed panel never leaves the microphone open or the voice talking
        session?.cancel('Cancelled: the panel was closed.')
        pet?.chatClosed()
        if (restAtHome || sleepAfterClose) pet?.goHome() // closing him: back home to rest (or, without a home, to sleep where he is)
        sleepAfterClose = false
      }
    }
  )

  setup = new SetupController({
    dataDir: app.getPath('userData'),
    toolsDir: join(import.meta.dirname, '../../tools'),
    execPath: process.execPath,
    keys: () => keyStore,
    env: process.env,
    currentAi: () => ({ provider: settings.ai.provider, model: settings.ai.model, baseUrl: settings.ai.baseUrl, command: settings.ai.command, args: settings.ai.args }),
    push: (state) => chat?.send(Channels.chatSetupState, state),
    restart: () => {
      if (e2e) return void log('setup-restart') // a test run must not restart itself
      app.relaunch()
      app.exit(0)
    }
  })
  registerIpc()
  createTray()

  if (debug) {
    win.webContents.on('console-message', (e) => log('renderer-console', { level: e.level, message: e.message }))
    win.webContents.on('render-process-gone', (_e, d) => log('renderer-gone', { reason: d.reason }))
  }
  win.webContents.on('did-finish-load', () => {
    if (petStore?.current) win?.webContents.send(Channels.petSpec, petStore.current)
    pet?.resync()
    refreshWatchUi()
  })
  win.once('ready-to-show', () => pet?.start())
  // fish turn up on the desktop now and then and he goes to eat them (only when he wanders around the edges; never in tests)
  if (!e2e || process.env['PET_FISH'] === '1') {
    pond = new FishPond({ spot: () => pet?.fishSpot() ?? Promise.resolve(null), canForage: () => pet?.canForage === true, bringWithMe: () => bringWithMe })
    pond.start(e2e ? 1500 : 8000)
  }

  // Failsafes if the tray icon is hidden or crowded out of the menu bar.
  registerShortcut(settings.shortcuts.toggleHide, 'hide/show', actions.toggleHidden)
  registerShortcut(settings.shortcuts.toggleChat, 'chat', actions.toggleChat)
  registerShortcut(settings.shortcuts.toggleListen, 'listen', actions.toggleListen)
  if (settings.screen.enabled) registerShortcut(settings.shortcuts.lookAtScreen, 'look at screen', actions.lookAtScreen)
  if (settings.screen.enabled && settings.observe.enabled) registerShortcut(settings.shortcuts.toggleWatch, 'watch', actions.toggleWatch)
})

app.on('window-all-closed', () => app.quit())
/** Clicking the app again (its Dock icon, or opening it from Finder while he is on) opens the chat instead of starting a second copy. */
const showAgain = (): void => {
  if (!pet) return
  if (pet.isHidden) actions.toggleHidden()
  chat?.open()
}
app.on('activate', showAgain)
app.on('second-instance', showAgain)
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  quitting = true
  observer?.stop()
  voice?.shutdown()
  tts?.dispose()
  pond?.dispose()
  session?.cancel()
  provider?.dispose?.() // no assistant process or request outlives the app
  summaryDispose?.()
  setup?.dispose()
  pet?.dispose()
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit())

// Test hooks, only with PET_DEBUG=1: drive the same code paths as the tray menu from a shell.
//   kill -USR1 <pid>  -> pause/resume     kill -USR2 <pid>  -> hide/show
if (debug) {
  process.on('SIGUSR1', actions.togglePause)
  process.on('SIGUSR2', actions.toggleHidden)
}
