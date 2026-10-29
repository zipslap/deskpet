import { isModelName } from './chat-types'

/** Shapes and validators for the "Set up" drawer: choosing the AI (and its key), and downloading the offline voices. */

export interface SetupProvider {
  id: string
  label: string
  hint: string
  /** The kind of connection: decides which fields the drawer shows. */
  kind: 'mock' | 'claude-cli' | 'command' | 'openai-compatible' | 'anthropic'
  needsKey: boolean
  /** A key (or the named environment variable) is already available for this service. */
  hasKey: boolean
  defaultModel: string
  models: string[]
}

export interface SetupVoiceStatus {
  /** Offline voices and speech models already on this computer. */
  voices: number
  speech: number
  /** A download is running. */
  busy: boolean
  /** The last lines the installer printed (progress, or the reason it stopped). */
  log: string[]
  error: boolean
  /** The download finished and the app is about to restart to use it. */
  done: boolean
}

export interface SetupUiState {
  providers: SetupProvider[]
  /** What is saved now (the "ai" section of settings.json). */
  current: { provider: string; model: string; baseUrl: string; command: string; args: string }
  /** The OS can store a key safely. False on Linux without a keyring: a typed key would not be saved. */
  secureKeys: boolean
  /** Text for the status line under the form, and whether it is an error. */
  message: string
  error: boolean
  /** A connection test or a save is running. */
  busy: boolean
  voice: SetupVoiceStatus
}

export const EMPTY_SETUP_UI: SetupUiState = {
  providers: [],
  current: { provider: 'mock', model: '', baseUrl: '', command: '', args: '' },
  secureKeys: true,
  message: '',
  error: false,
  busy: false,
  voice: { voices: 0, speech: 0, busy: false, log: [], error: false, done: false }
}

/** What the drawer sends to test or save a choice. `key` is empty when the stored one should stay. */
export interface SetupRequest {
  provider: string
  model: string
  baseUrl: string
  command: string
  args: string
  key: string
}

export const MAX_KEY_CHARS = 600
const PROVIDER_ID = /^[a-z0-9-]{1,30}$/

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null)

export function parseSetupRequest(v: unknown): SetupRequest | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const provider = text(r['provider'], 30)
  const model = text(r['model'] ?? '', 80)
  const baseUrl = text(r['baseUrl'] ?? '', 300)
  const command = text(r['command'] ?? '', 300)
  const args = text(r['args'] ?? '', 500)
  // a pasted key may carry a trailing newline, which the key store trims; anything else odd is refused there
  const key = typeof r['key'] === 'string' && r['key'].length <= MAX_KEY_CHARS ? r['key'].trim() : r['key'] === undefined ? '' : null
  if (provider === null || !PROVIDER_ID.test(provider) || model === null || baseUrl === null || command === null || args === null || key === null) return null
  if (model !== '' && !isModelName(model)) return null
  return { provider, model, baseUrl, command, args, key }
}

/** Which offline voices to download: a small starter set, or the big recommended collection. */
export type VoicePack = 'starter' | 'recommended'
export const parseVoicePack = (v: unknown): VoicePack | null => (v === 'starter' || v === 'recommended' ? v : null)

export function parseSetupUiState(v: unknown): SetupUiState | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  const cur = s['current'] as Record<string, unknown> | null
  const vo = s['voice'] as Record<string, unknown> | null
  if (!Array.isArray(s['providers']) || typeof cur !== 'object' || cur === null || typeof vo !== 'object' || vo === null) return null
  const providers: SetupProvider[] = []
  for (const p of s['providers'].slice(0, 40)) {
    const o = p as Record<string, unknown>
    const kind = o['kind']
    if (typeof o['id'] !== 'string' || !PROVIDER_ID.test(o['id']) || typeof o['label'] !== 'string' || typeof o['hint'] !== 'string') return null
    if (kind !== 'mock' && kind !== 'claude-cli' && kind !== 'command' && kind !== 'openai-compatible' && kind !== 'anthropic') return null
    providers.push({
      id: o['id'],
      label: o['label'].slice(0, 120),
      hint: o['hint'].slice(0, 300),
      kind,
      needsKey: o['needsKey'] === true,
      hasKey: o['hasKey'] === true,
      defaultModel: typeof o['defaultModel'] === 'string' ? o['defaultModel'].slice(0, 80) : '',
      models: Array.isArray(o['models']) ? o['models'].filter(isModelName).slice(0, 40) : []
    })
  }
  const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
  const log = Array.isArray(vo['log']) ? vo['log'].filter((l): l is string => typeof l === 'string').slice(-12).map((l) => l.slice(0, 300)) : []
  return {
    providers,
    current: { provider: str(cur['provider'], 30), model: str(cur['model'], 80), baseUrl: str(cur['baseUrl'], 300), command: str(cur['command'], 300), args: str(cur['args'], 500) },
    secureKeys: s['secureKeys'] !== false,
    message: str(s['message'], 600),
    error: s['error'] === true,
    busy: s['busy'] === true,
    voice: {
      voices: Number.isFinite(Number(vo['voices'])) ? Math.max(0, Math.floor(Number(vo['voices']))) : 0,
      speech: Number.isFinite(Number(vo['speech'])) ? Math.max(0, Math.floor(Number(vo['speech']))) : 0,
      busy: vo['busy'] === true,
      log,
      error: vo['error'] === true,
      done: vo['done'] === true
    }
  }
}
