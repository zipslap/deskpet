/** What the chat panel shows about screen access. Built in main, validated again by the preload bridge. */
export interface ScreenUiState {
  /** screen.enabled in settings. False hides the camera button entirely. */
  enabled: boolean
  /** The next message will carry a screenshot (the user pressed the camera button). */
  armed: boolean
  /** A capture is in progress right now. */
  busy: boolean
  /** Something the user can act on, with the Settings pane that fixes it. */
  error: { message: string; fix: 'screen' | null } | null
  /** Watching (Phase 6): whether the switch exists, whether it is on, and a plain-language account of what it has done. */
  watch: WatchUiState
  /** A rule fired and is waiting for the user: nothing has been sent. */
  nudge: { app: string; prompt: string } | null
}

export interface WatchUiState {
  /** observe.enabled in settings: the switch exists. */
  available: boolean
  on: boolean
  phase: 'off' | 'watching' | 'paused-excluded' | 'suspended'
  app: string | null
  /** Checks of which app is in front (no pixels). */
  checks: number
  /** Tiny local thumbnails compared on this Mac (never sent). */
  samples: number
  /** Times a rule fired. */
  fired: number
  /** Screenshots sent to the assistant by rules on their own (only with proactive.enabled). */
  sent: number
}

export const IDLE_WATCH_STATE: WatchUiState = { available: false, on: false, phase: 'off', app: null, checks: 0, samples: 0, fired: 0, sent: 0 }
export const IDLE_SCREEN_STATE: ScreenUiState = { enabled: false, armed: false, busy: false, error: null, watch: IDLE_WATCH_STATE, nudge: null }

const PHASES: readonly string[] = ['off', 'watching', 'paused-excluded', 'suspended']
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null)

function parseWatch(v: unknown): WatchUiState | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o['available'] !== 'boolean' || typeof o['on'] !== 'boolean' || typeof o['phase'] !== 'string' || !PHASES.includes(o['phase'])) return null
  if (o['app'] !== null && typeof o['app'] !== 'string') return null
  const [checks, samples, fired, sent] = [count(o['checks']), count(o['samples']), count(o['fired']), count(o['sent'])]
  if (checks === null || samples === null || fired === null || sent === null) return null
  return { available: o['available'], on: o['on'], phase: o['phase'] as WatchUiState['phase'], app: o['app'] === null ? null : o['app'].slice(0, 80), checks, samples, fired, sent }
}

export function parseScreenState(v: unknown): ScreenUiState | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  for (const k of ['enabled', 'armed', 'busy'] as const) if (typeof o[k] !== 'boolean') return null
  let error: ScreenUiState['error'] = null
  if (o['error'] !== null && o['error'] !== undefined) {
    const e = o['error']
    if (typeof e !== 'object' || e === null) return null
    const { message, fix } = e as Record<string, unknown>
    if (typeof message !== 'string' || (fix !== null && fix !== 'screen')) return null
    error = { message: message.slice(0, 400), fix }
  }
  const watch = parseWatch(o['watch'])
  if (!watch) return null
  let nudge: ScreenUiState['nudge'] = null
  if (o['nudge'] !== null && o['nudge'] !== undefined) {
    const n = o['nudge']
    if (typeof n !== 'object' || n === null) return null
    const { app, prompt } = n as Record<string, unknown>
    if (typeof app !== 'string' || typeof prompt !== 'string') return null
    nudge = { app: app.slice(0, 80), prompt: prompt.slice(0, 500) }
  }
  return { enabled: o['enabled'] as boolean, armed: o['armed'] as boolean, busy: o['busy'] as boolean, error, watch, nudge }
}
