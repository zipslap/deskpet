/** What the chat panel is shown about voice. Built in main, validated again in the renderer's preload. */
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'stopping'
export type FixHint = 'microphone' | 'speech' | null

export interface VoiceUiState {
  phase: VoicePhase
  /** Microphone level 0..1 while listening. */
  level: number
  /** Live transcript while listening, final transcript afterwards (until the next listen starts). */
  text: string
  final: boolean
  /** A problem the user can act on, with a hint about which System Settings pane fixes it. */
  error: { message: string; fix: FixHint } | null
  /** A gentle, non-error message ("I didn't catch that"). */
  notice: string | null
  muted: boolean
  /** The reply is being read aloud. */
  speaking: boolean
  /** Voice input can be attempted at all (the helper is installed). */
  canListen: boolean
  /** A live conversation is on: the mic reopens by itself after each reply, and what you say is sent when you pause. */
  live: boolean
}

export const IDLE_VOICE_STATE: VoiceUiState = {
  phase: 'idle',
  level: 0,
  text: '',
  final: false,
  error: null,
  notice: null,
  muted: false,
  speaking: false,
  canListen: false,
  live: false
}

const PHASES: readonly string[] = ['idle', 'starting', 'listening', 'stopping']

export function parseVoiceState(v: unknown): VoiceUiState | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o['phase'] !== 'string' || !PHASES.includes(o['phase'])) return null
  if (typeof o['level'] !== 'number' || !Number.isFinite(o['level'])) return null
  if (typeof o['text'] !== 'string' || typeof o['final'] !== 'boolean') return null
  for (const k of ['muted', 'speaking', 'canListen', 'live'] as const) if (typeof o[k] !== 'boolean') return null
  if (o['notice'] !== null && typeof o['notice'] !== 'string') return null
  let error: VoiceUiState['error'] = null
  if (o['error'] !== null) {
    const e = o['error']
    if (typeof e !== 'object' || e === null) return null
    const { message, fix } = e as Record<string, unknown>
    if (typeof message !== 'string' || (fix !== null && fix !== 'microphone' && fix !== 'speech')) return null
    error = { message, fix }
  }
  return {
    phase: o['phase'] as VoicePhase,
    level: Math.min(1, Math.max(0, o['level'])),
    text: o['text'],
    final: o['final'],
    error,
    notice: o['notice'] as string | null,
    muted: o['muted'] as boolean,
    speaking: o['speaking'] as boolean,
    canListen: o['canListen'] as boolean,
    live: o['live'] as boolean
  }
}
