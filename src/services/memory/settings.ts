import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'
import { COAT_NAMES, isCoatName, type CoatName } from '../../shared/cat3d/cat-model'
import { PROVIDER_IDS, isSafeBaseUrl } from '../ai/presets'

export interface VoiceSettings {
  /** Read replies aloud (macOS `say`). The panel's speaker button toggles this at runtime. */
  speakReplies: boolean
  /** A `say` voice name, or "" for the system default. */
  voice: string
  /** Speech rate in words per minute. */
  rate: number
  /** Recognition language, e.g. "en-US". */
  locale: string
  /** Allow Apple's servers to do recognition when on-device recognition is unavailable. Off: audio never leaves the Mac. */
  allowServerRecognition: boolean
  /** Send a dictated message immediately instead of leaving it in the box for review. */
  autoSend: boolean
  /** A reply longer than this is read aloud only up to a sentence boundary near this length (the full text stays on screen). 0 = read everything. */
  maxSpokenChars: number
  /** Hard stop for a single listening session. */
  maxListenSeconds: number
  /** Stop listening after this much silence once something has been said. */
  silenceMs: number
  /** Live conversation: the mic reopens by itself after each reply and what you say is sent when you pause (no Send button). */
  live: boolean
  /** "local" = the offline voices installed with `npm run voices` (Kokoro, Piper); "say" = the macOS voices. "local" falls back to "say" if no local voice is installed. */
  engine: 'local' | 'say'
  local: LocalVoiceSettings
}

export interface LocalVoiceSettings {
  /** Python with sherpa-onnx, numpy and sounddevice ("" = the one `npm run voices -- setup` made, in the app's data folder). */
  python: string
  /** Folder holding the installed voice models ("" = <app data>/voices/models). */
  modelsDir: string
  /** Id of an installed voice model, e.g. "kokoro-multi-lang-v1_0" or "piper-en_US-amy-medium" (see `npm run voices -- list`). */
  model: string
  /** Which speaker inside the model (Kokoro has 53; most Piper voices have one). */
  sid: number
  /** Pitch change: 1 = as recorded, above 1 sounds younger/more cartoon-like, up to 1.4. */
  pitch: number
  /** Speaking speed, 1 = natural. */
  speed: number
}

export interface AiSettings {
  /**
   * Which service answers: "mock" (offline demo), "claude-cli" (your signed-in `claude` command), "command" (any command-line
   * assistant), or an API: "anthropic", "openai", "gemini", "openrouter", "groq", "mistral", "deepseek", "xai", "ollama",
   * "lmstudio", "custom". See the README.
   */
  provider: string
  /** Model name. "" = the service's default. Any name the service accepts works, also via `/model <name>` in the chat. */
  model: string
  /** Extra model names to offer in the panel's list. */
  models: string[]
  /** Override the service's address ("custom" needs this). https only, except for a server on this computer. */
  baseUrl: string
  /** Name of the environment variable holding the API key, if not the service's usual one. A key stored with `npm run setup` (macOS Keychain) wins. */
  apiKeyEnv: string
  /** claude-cli: the `claude` executable ("" = claude). command: the program to run. A bare name is looked up on PATH and common install folders. */
  command: string
  /** command: arguments for the program. `{model}` and `{prompt}` are replaced; without `{prompt}` the prompt is sent on stdin. */
  args: string[]
  /** Give up on a request that is completely silent for this long. */
  timeoutSeconds: number
  /** claude-cli only. Off: refuse to run unless the CLI is signed in with a Claude subscription (never a separately billed API key). */
  allowBilledApi: boolean
  /** "playful": a cheeky, upbeat personality on top of the same model; "plain": none. */
  persona: 'playful' | 'plain'
}

export interface SpeechSettings {
  /**
   * Who turns your voice into text. "auto": on a Mac, Apple's on-device recogniser (no download); everywhere else, or on a Mac when
   * it is not built, the offline models from `npm run speech`. "apple": macOS only. "local": always the offline models.
   */
  engine: 'auto' | 'apple' | 'local'
  /** An installed offline speech model id (`npm run speech -- list`); "" = the best installed one. */
  model: string
}

export interface MemorySettings {
  /** Give the assistant the contents of the memory folder as background about you. */
  enabled: boolean
  /** Let the assistant add or update memories there when you ask it to remember something. */
  write: boolean
  /** The memory folder (plain Markdown files you can read and edit); "" = <app data>/memory. */
  dir: string
  /** When a conversation gets very long, fold its older part into a short summary (kept on this Mac, shown and clearable in the panel) instead of dropping it. */
  summarize: boolean
}

export interface ScreenSettings {
  /** Master switch for everything that looks at the screen. Off: no capture, no screen button, no observation. */
  enabled: boolean
  /** Which display "look at my screen" captures: the one the pet is on, or the main one. */
  display: 'pet' | 'main'
  /** The longest side of the image sent to the assistant, in pixels (larger screens are scaled down). */
  maxEdge: number
  /**
   * Apps that are never captured. Matched case-insensitively against an app's name or bundle id. If a window of one of
   * them is visible on the display being captured, the capture is refused (and says which app), not cropped.
   */
  excludeApps: string[]
  /**
   * Where the app cannot list the windows on screen (anything but macOS), it cannot tell whether an excluded app (a password manager)
   * is visible, so screen sharing is refused. Set this to true to share your screen anyway, at your own risk.
   */
  allowUnchecked: boolean
}

export interface ObserveRule {
  /** App name or bundle id (case-insensitive, exact) that this rule watches for. */
  app: string
  /**
   * What happens when the rule fires. "nudge": the cat perks up and offers ("Want me to look at Mail?"); nothing is sent
   * until you click. "ask": the screenshot and the prompt go to the assistant by themselves (needs proactive.enabled).
   */
  action: 'nudge' | 'ask'
  /** 0 = fire when the app comes to the front. Above 0: also needs the screen to have changed by at least this fraction since the last look. */
  minChange: number
  /** Minimum time between two firings of this rule. */
  cooldownMinutes: number
  /** The question to ask the assistant (for "ask", and pre-filled in the box for "nudge"). */
  prompt: string
}

export interface ObserveSettings {
  /** Allows the "watch" switch to exist at all. Even then, watching starts OFF every time the pet starts and is turned on by you. */
  enabled: boolean
  /** Seconds between checks of which app is in front (no pixels are read for that). */
  intervalSeconds: number
  /** At most this many rule firings (nudges + asks) in any hour. */
  maxPerHour: number
  rules: ObserveRule[]
}

export interface ProactiveSettings {
  /** Master switch for the cat reacting on its own: "ask" rules sending screenshots by themselves, and reactions to what you are doing. */
  enabled: boolean
}

export interface CatSettings {
  /** "3d" draws the voxel cat with WebGL; "sprite" is the original 2D sprite (also the automatic fallback if WebGL is unavailable). */
  view: 'figure' | '3d' | 'sprite'
  coat: CoatName
  /** Screen pixels per rendered pixel: 1 = fine, 2 = chunky (default), 4 = very chunky. */
  pixelSize: 1 | 2 | 4
  /**
   * Off (default): the cat lives on the desktop like a window, behind the apps you are using and only on the Space it started on.
   * On: it comes with you: above other apps, on every Space and over full-screen apps. Also a menu toggle (the menu choice is remembered in prefs.json and wins).
   */
  bringWithMe: boolean
  /**
   * Off (default, since he is now a real app you open and quit): he stays where he is and dozes off in place. On: when he is not being used he rests at his home spot on the desktop (asleep, practically free to run). Click him to wake him and chat;
   * closing the chat, or a few minutes of no use, sends him back home to rest. Drag him while he rests to move his home. Off: he sleeps wherever he is.
   * Also a menu toggle (remembered in prefs.json).
   */
  restAtHome: boolean
  /** "desktop": wanders the whole screen, any direction, and stays where you drop it. "dock": walks only along the bottom edge and drops back to it. */
  roam: 'edges' | 'desktop' | 'dock'
}

export interface Settings {
  shortcuts: {
    /** Global shortcut that hides/shows the pet. */
    toggleHide: string
    /** Global shortcut that opens/closes the chat panel. */
    toggleChat: string
    /** Global shortcut that starts/stops listening (press to start, press again to stop). */
    toggleListen: string
    /** Global shortcut that opens the chat with the screenshot button armed (the next message carries a screenshot). */
    lookAtScreen: string
    /** Global shortcut that turns watching on/off (only does anything when observe.enabled is true). */
    toggleWatch: string
  }
  /** Inactivity before the pet falls asleep. */
  sleepAfterMs: number
  voice: VoiceSettings
  speech: SpeechSettings
  ai: AiSettings
  memory: MemorySettings
  screen: ScreenSettings
  observe: ObserveSettings
  proactive: ProactiveSettings
  cat: CatSettings
}

export const DEFAULT_SETTINGS: Settings = {
  shortcuts: {
    toggleHide: 'CommandOrControl+Alt+Shift+P',
    toggleChat: 'CommandOrControl+Alt+Shift+C',
    toggleListen: 'CommandOrControl+Alt+Shift+V',
    lookAtScreen: 'CommandOrControl+Alt+Shift+S',
    toggleWatch: 'CommandOrControl+Alt+Shift+W'
  },
  sleepAfterMs: 5 * 60 * 1000,
  voice: {
    speakReplies: true,
    voice: '',
    rate: 185,
    locale: 'en-US',
    allowServerRecognition: false,
    autoSend: false,
    maxSpokenChars: 600,
    maxListenSeconds: 30,
    silenceMs: 1200,
    live: true,
    engine: 'local',
    local: { python: '', modelsDir: '', model: 'kokoro-multi-lang-v1_0', sid: 3, pitch: 1, speed: 1 }
  },
  speech: { engine: 'auto', model: '' },
  ai: {
    provider: 'mock',
    model: '',
    models: [],
    baseUrl: '',
    apiKeyEnv: '',
    command: '',
    args: [],
    timeoutSeconds: 120,
    allowBilledApi: false,
    persona: 'playful'
  },
  memory: {
    enabled: true,
    write: true,
    dir: '',
    summarize: true
  },
  screen: {
    enabled: true,
    display: 'pet',
    maxEdge: 1568,
    excludeApps: ['1Password', 'Bitwarden', 'LastPass', 'Dashlane', 'Enpass', 'KeePassXC', 'Proton Pass', 'Keychain Access', 'Passwords'],
    allowUnchecked: false
  },
  observe: {
    enabled: false,
    intervalSeconds: 20,
    maxPerHour: 6,
    rules: []
  },
  proactive: {
    enabled: false
  },
  cat: {
    view: 'figure',
    coat: 'black',
    pixelSize: 2,
    bringWithMe: false,
    restAtHome: false,
    roam: 'edges'
  }
}

export const MIN_SLEEP_MS = 10_000
export const MAX_SLEEP_MS = 24 * 3600 * 1000

// Electron accelerators: modifier/key names joined with "+", e.g. CommandOrControl+Alt+Shift+P.
const ACCELERATOR = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/
/** A voice model id from the catalog, e.g. piper-en_US-amy-medium. */
const VOICE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** `say` voice names look like "Eddy (English (US))"; allow letters, digits, spaces and a few punctuation marks only. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-:/@[\]]{0,79}$/
/** A bare command name, or an absolute path without `..` segments. No shell is ever involved; this is only a sanity check. */
const COMMAND = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,39}|(?:\/|[A-Za-z]:[\\/])[A-Za-z0-9._@+=:,/\\ ()-]{1,300})$/
/** An absolute path on any OS (Windows paths are accepted on every platform, so a settings file can be shared), with no `..` segment. */
const isAbsPath = (p: string): boolean => p.length <= 400 && !p.includes('\0') && (posix.isAbsolute(p) || win32.isAbsolute(p)) && !p.split(/[\\/]/).includes('..')
const VOICE_NAME = /^[\p{L}\p{N} ().'_-]{1,60}$/u

const clone = (): Settings => ({
  shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
  sleepAfterMs: DEFAULT_SETTINGS.sleepAfterMs,
  voice: { ...DEFAULT_SETTINGS.voice, local: { ...DEFAULT_SETTINGS.voice.local } },
  speech: { ...DEFAULT_SETTINGS.speech },
  ai: { ...DEFAULT_SETTINGS.ai, models: [], args: [] },
  memory: { ...DEFAULT_SETTINGS.memory },
  screen: { ...DEFAULT_SETTINGS.screen, excludeApps: [...DEFAULT_SETTINGS.screen.excludeApps] },
  observe: { ...DEFAULT_SETTINGS.observe, rules: [] },
  proactive: { ...DEFAULT_SETTINGS.proactive },
  cat: { ...DEFAULT_SETTINGS.cat }
})
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Merge untrusted JSON with the defaults. Invalid fields fall back individually and are reported in `warnings`. */
export function parseSettings(raw: unknown): { settings: Settings; warnings: string[] } {
  const warnings: string[] = []
  const settings = clone()
  if (!isObj(raw)) {
    if (raw !== undefined) warnings.push('settings file is not a JSON object; using defaults')
    return { settings, warnings }
  }

  const sc = raw['shortcuts']
  if (sc !== undefined) {
    if (!isObj(sc)) warnings.push('"shortcuts" must be an object')
    else
      for (const key of ['toggleHide', 'toggleChat', 'toggleListen', 'lookAtScreen', 'toggleWatch'] as const) {
        const v = sc[key]
        if (v === undefined) continue
        if (typeof v === 'string' && v.length <= 60 && ACCELERATOR.test(v)) settings.shortcuts[key] = v
        else warnings.push(`shortcuts.${key} is not a valid accelerator; using ${settings.shortcuts[key]}`)
      }
    const values = Object.values(settings.shortcuts)
    if (new Set(values).size !== values.length) {
      warnings.push('two shortcuts are identical; using the defaults for all of them')
      settings.shortcuts = { ...DEFAULT_SETTINGS.shortcuts }
    }
  }

  const sleep = raw['sleepAfterMs']
  if (sleep !== undefined) {
    if (typeof sleep === 'number' && Number.isFinite(sleep) && sleep >= MIN_SLEEP_MS && sleep <= MAX_SLEEP_MS) settings.sleepAfterMs = Math.round(sleep)
    else warnings.push(`sleepAfterMs must be a number between ${MIN_SLEEP_MS} and ${MAX_SLEEP_MS}; using the default`)
  }

  const v = raw['voice']
  if (v !== undefined) {
    if (!isObj(v)) warnings.push('"voice" must be an object')
    else {
      const bool = (key: 'speakReplies' | 'allowServerRecognition' | 'autoSend'): void => {
        if (v[key] === undefined) return
        if (typeof v[key] === 'boolean') settings.voice[key] = v[key]
        else warnings.push(`voice.${key} must be true or false; using ${settings.voice[key]}`)
      }
      const num = (key: 'rate' | 'maxListenSeconds' | 'silenceMs' | 'maxSpokenChars', lo: number, hi: number): void => {
        if (v[key] === undefined) return
        const n = v[key]
        if (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi) settings.voice[key] = Math.round(n)
        else warnings.push(`voice.${key} must be a number between ${lo} and ${hi}; using ${settings.voice[key]}`)
      }
      bool('speakReplies')
      bool('allowServerRecognition')
      bool('autoSend')
      if (v['live'] !== undefined) {
        if (typeof v['live'] === 'boolean') settings.voice.live = v['live']
        else warnings.push(`voice.live must be true or false; using ${settings.voice.live}`)
      }
      if (v['engine'] !== undefined) {
        if (v['engine'] === 'local' || v['engine'] === 'say') settings.voice.engine = v['engine']
        else warnings.push('voice.engine must be "local" or "say"; using "local"')
      }
      const k = v['local']
      if (k !== undefined) {
        if (!isObj(k)) warnings.push('voice.local must be an object')
        else {
          for (const key of ['python', 'modelsDir'] as const) {
            if (k[key] === undefined) continue
            if (typeof k[key] === 'string' && (k[key] === '' || isAbsPath(k[key]))) settings.voice.local[key] = k[key]
            else warnings.push(`voice.local.${key} must be an absolute path; using the default`)
          }
          if (k['model'] !== undefined) {
            if (typeof k['model'] === 'string' && VOICE_MODEL_ID.test(k['model'])) settings.voice.local.model = k['model']
            else warnings.push(`voice.local.model must be a voice id such as "kokoro-multi-lang-v1_0"; using ${settings.voice.local.model}`)
          }
          const knum = (key: 'sid' | 'pitch' | 'speed', lo: number, hi: number, int: boolean): void => {
            if (k[key] === undefined) return
            const n = k[key]
            if (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi && (!int || Number.isInteger(n))) settings.voice.local[key] = n
            else warnings.push(`voice.local.${key} must be a number between ${lo} and ${hi}; using ${settings.voice.local[key]}`)
          }
          knum('sid', 0, 2000, true)
          knum('pitch', 0.8, 1.4, false)
          knum('speed', 0.6, 1.6, false)
        }
      }
      num('rate', 90, 360)
      num('maxSpokenChars', 0, 20_000)
      num('maxListenSeconds', 5, 120)
      num('silenceMs', 800, 10_000)
      if (v['voice'] !== undefined) {
        if (typeof v['voice'] === 'string' && (v['voice'] === '' || VOICE_NAME.test(v['voice']))) settings.voice.voice = v['voice']
        else warnings.push('voice.voice is not a valid voice name; using the system default')
      }
      if (v['locale'] !== undefined) {
        if (typeof v['locale'] === 'string' && LOCALE.test(v['locale'])) settings.voice.locale = v['locale']
        else warnings.push(`voice.locale must look like "en-US"; using ${settings.voice.locale}`)
      }
    }
  }

  const sp = raw['speech']
  if (sp !== undefined) {
    if (!isObj(sp)) warnings.push('"speech" must be an object')
    else {
      if (sp['engine'] !== undefined) {
        if (sp['engine'] === 'auto' || sp['engine'] === 'apple' || sp['engine'] === 'local') settings.speech.engine = sp['engine']
        else warnings.push('speech.engine must be "auto", "apple" or "local"; using "auto"')
      }
      if (sp['model'] !== undefined) {
        if (typeof sp['model'] === 'string' && (sp['model'] === '' || VOICE_MODEL_ID.test(sp['model']))) settings.speech.model = sp['model']
        else warnings.push('speech.model must be an installed speech model id such as "stt-en"; using the best installed one')
      }
    }
  }

  const c = raw['ai']
  if (c !== undefined) {
    if (!isObj(c)) warnings.push('"ai" must be an object')
    else {
      if (c['provider'] !== undefined) {
        if (typeof c['provider'] === 'string' && PROVIDER_IDS.includes(c['provider'])) settings.ai.provider = c['provider']
        else warnings.push(`ai.provider must be one of ${PROVIDER_IDS.join(', ')}; using "mock"`)
      }
      if (c['persona'] !== undefined) {
        if (c['persona'] === 'playful' || c['persona'] === 'plain') settings.ai.persona = c['persona']
        else warnings.push('ai.persona must be "playful" or "plain"; using "playful"')
      }
      if (c['model'] !== undefined) {
        if (typeof c['model'] === 'string' && (c['model'] === '' || MODEL_NAME.test(c['model']))) settings.ai.model = c['model']
        else warnings.push('ai.model is not a valid model name; using the service default')
      }
      if (c['models'] !== undefined) {
        const list = c['models']
        if (Array.isArray(list) && list.length <= 50 && list.every((x) => typeof x === 'string' && MODEL_NAME.test(x))) settings.ai.models = [...list] as string[]
        else warnings.push('ai.models must be a list of up to 50 model names; ignored')
      }
      if (c['baseUrl'] !== undefined) {
        if (typeof c['baseUrl'] === 'string' && (c['baseUrl'] === '' || (c['baseUrl'].length <= 300 && isSafeBaseUrl(c['baseUrl'])))) settings.ai.baseUrl = c['baseUrl']
        else warnings.push('ai.baseUrl must be an https:// address (http:// only for localhost); ignored')
      }
      if (c['apiKeyEnv'] !== undefined) {
        if (typeof c['apiKeyEnv'] === 'string' && (c['apiKeyEnv'] === '' || ENV_NAME.test(c['apiKeyEnv']))) settings.ai.apiKeyEnv = c['apiKeyEnv']
        else warnings.push('ai.apiKeyEnv must be the NAME of an environment variable (not the key itself); ignored')
      }
      if (c['command'] !== undefined) {
        if (typeof c['command'] === 'string' && (c['command'] === '' || (COMMAND.test(c['command']) && !c['command'].split(/[\\/]/).includes('..')))) settings.ai.command = c['command']
        else warnings.push('ai.command must be a command name or an absolute path; ignored')
      }
      if (c['args'] !== undefined) {
        const list = c['args']
        if (Array.isArray(list) && list.length <= 40 && list.every((x) => typeof x === 'string' && x.length <= 2000 && !x.includes('\0'))) settings.ai.args = [...list] as string[]
        else warnings.push('ai.args must be a list of up to 40 strings; ignored')
      }
      if (c['timeoutSeconds'] !== undefined) {
        const n = c['timeoutSeconds']
        if (typeof n === 'number' && Number.isFinite(n) && n >= 10 && n <= 600) settings.ai.timeoutSeconds = Math.round(n)
        else warnings.push(`ai.timeoutSeconds must be a number between 10 and 600; using ${settings.ai.timeoutSeconds}`)
      }
      if (c['allowBilledApi'] !== undefined) {
        if (typeof c['allowBilledApi'] === 'boolean') settings.ai.allowBilledApi = c['allowBilledApi']
        else warnings.push('ai.allowBilledApi must be true or false; using false')
      }
    }
  }

  const mem = raw['memory']
  if (mem !== undefined) {
    if (!isObj(mem)) warnings.push('"memory" must be an object')
    else {
      for (const key of ['enabled', 'write', 'summarize'] as const) {
        if (mem[key] === undefined) continue
        if (typeof mem[key] === 'boolean') settings.memory[key] = mem[key]
        else warnings.push(`memory.${key} must be true or false; using ${settings.memory[key]}`)
      }
      if (mem['dir'] !== undefined) {
        const d = mem['dir']
        if (typeof d === 'string' && (d === '' || isAbsPath(d))) settings.memory.dir = d
        else warnings.push('memory.dir must be "" or an absolute path; using the default folder')
      }
    }
  }

  const scr = raw['screen']
  if (scr !== undefined) {
    if (!isObj(scr)) warnings.push('"screen" must be an object')
    else {
      if (scr['enabled'] !== undefined) {
        if (typeof scr['enabled'] === 'boolean') settings.screen.enabled = scr['enabled']
        else warnings.push(`screen.enabled must be true or false; using ${settings.screen.enabled}`)
      }
      if (scr['display'] !== undefined) {
        if (scr['display'] === 'pet' || scr['display'] === 'main') settings.screen.display = scr['display']
        else warnings.push('screen.display must be "pet" or "main"; using "pet"')
      }
      if (scr['allowUnchecked'] !== undefined) {
        if (typeof scr['allowUnchecked'] === 'boolean') settings.screen.allowUnchecked = scr['allowUnchecked']
        else warnings.push('screen.allowUnchecked must be true or false; using false')
      }
      if (scr['maxEdge'] !== undefined) {
        const n = scr['maxEdge']
        if (typeof n === 'number' && Number.isFinite(n) && n >= 512 && n <= 4096) settings.screen.maxEdge = Math.round(n)
        else warnings.push(`screen.maxEdge must be a number between 512 and 4096; using ${settings.screen.maxEdge}`)
      }
      if (scr['excludeApps'] !== undefined) {
        const list = scr['excludeApps']
        if (Array.isArray(list) && list.length <= 100 && list.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 100)) {
          settings.screen.excludeApps = list.map((x) => (x as string).trim())
        } else warnings.push('screen.excludeApps must be a list of up to 100 app names or bundle ids; using the default list')
      }
    }
  }

  const obs = raw['observe']
  if (obs !== undefined) {
    if (!isObj(obs)) warnings.push('"observe" must be an object')
    else {
      if (obs['enabled'] !== undefined) {
        if (typeof obs['enabled'] === 'boolean') settings.observe.enabled = obs['enabled']
        else warnings.push('observe.enabled must be true or false; using false')
      }
      const bounded = (key: 'intervalSeconds' | 'maxPerHour', lo: number, hi: number): void => {
        if (obs[key] === undefined) return
        const n = obs[key]
        if (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi) settings.observe[key] = Math.round(n)
        else warnings.push(`observe.${key} must be a number between ${lo} and ${hi}; using ${settings.observe[key]}`)
      }
      bounded('intervalSeconds', 5, 600)
      bounded('maxPerHour', 1, 60)
      if (obs['rules'] !== undefined) {
        if (!Array.isArray(obs['rules']) || obs['rules'].length > 30) warnings.push('observe.rules must be a list of up to 30 rules; using none')
        else {
          const rules: ObserveRule[] = []
          obs['rules'].forEach((r, i) => {
            if (!isObj(r) || typeof r['app'] !== 'string' || r['app'].trim() === '' || r['app'].length > 100) return void warnings.push(`observe.rules[${i}] needs an "app" name; ignored`)
            const action = r['action'] === undefined ? 'nudge' : r['action']
            if (action !== 'nudge' && action !== 'ask') return void warnings.push(`observe.rules[${i}].action must be "nudge" or "ask"; rule ignored`)
            const minChange = r['minChange'] === undefined ? 0 : r['minChange']
            if (typeof minChange !== 'number' || !(minChange >= 0 && minChange <= 1)) return void warnings.push(`observe.rules[${i}].minChange must be between 0 and 1; rule ignored`)
            const cooldown = r['cooldownMinutes'] === undefined ? 10 : r['cooldownMinutes']
            if (typeof cooldown !== 'number' || !(cooldown >= 1 && cooldown <= 1440)) return void warnings.push(`observe.rules[${i}].cooldownMinutes must be between 1 and 1440; rule ignored`)
            const prompt = r['prompt'] === undefined ? 'What am I looking at here? Keep it brief.' : r['prompt']
            if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > 500) return void warnings.push(`observe.rules[${i}].prompt must be 1-500 characters; rule ignored`)
            rules.push({ app: r['app'].trim(), action, minChange, cooldownMinutes: Math.round(cooldown), prompt: prompt.trim() })
          })
          settings.observe.rules = rules
        }
      }
    }
  }

  const pro = raw['proactive']
  if (pro !== undefined) {
    if (!isObj(pro)) warnings.push('"proactive" must be an object')
    else if (pro['enabled'] !== undefined) {
      if (typeof pro['enabled'] === 'boolean') settings.proactive.enabled = pro['enabled']
      else warnings.push('proactive.enabled must be true or false; using false')
    }
  }

  const cat = raw['cat']
  if (cat !== undefined) {
    if (!isObj(cat)) warnings.push('"cat" must be an object')
    else {
      if (cat['view'] !== undefined) {
        if (cat['view'] === 'figure' || cat['view'] === '3d' || cat['view'] === 'sprite') settings.cat.view = cat['view']
        else warnings.push('cat.view must be "figure", "3d" or "sprite"; using "figure"')
      }
      if (cat['coat'] !== undefined) {
        if (isCoatName(cat['coat'])) settings.cat.coat = cat['coat']
        else warnings.push(`cat.coat must be one of ${COAT_NAMES.join(', ')}; using ${settings.cat.coat}`)
      }
      if (cat['bringWithMe'] !== undefined) {
        if (typeof cat['bringWithMe'] === 'boolean') settings.cat.bringWithMe = cat['bringWithMe']
        else warnings.push('cat.bringWithMe must be true or false; using false')
      }
      if (cat['restAtHome'] !== undefined) {
        if (typeof cat['restAtHome'] === 'boolean') settings.cat.restAtHome = cat['restAtHome']
        else warnings.push('cat.restAtHome must be true or false; using false')
      }
      if (cat['roam'] !== undefined) {
        if (cat['roam'] === 'edges' || cat['roam'] === 'desktop' || cat['roam'] === 'dock') settings.cat.roam = cat['roam']
        else warnings.push('cat.roam must be "edges", "desktop" or "dock"; using "edges"')
      }
      if (cat['pixelSize'] !== undefined) {
        const n = cat['pixelSize']
        if (n === 1 || n === 2 || n === 4) settings.cat.pixelSize = n
        else warnings.push(`cat.pixelSize must be 1, 2 or 4; using ${settings.cat.pixelSize}`)
      }
    }
  }
  return { settings, warnings }
}

/**
 * Loads settings.json, creating it with the defaults on first run so it can be edited by hand.
 * A file that exists but cannot be parsed is left untouched (never overwritten) and defaults are used.
 */
export function loadSettings(path: string): { settings: Settings; warnings: string[] } {
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n')
      renameSync(tmp, path)
    } catch (e) {
      return { settings: clone(), warnings: [`could not create ${path}: ${(e as Error).message}`] }
    }
    return { settings: clone(), warnings: [] }
  }
  try {
    return parseSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch (e) {
    return { settings: clone(), warnings: [`could not read ${path}: ${(e as Error).message}; using defaults`] }
  }
}
