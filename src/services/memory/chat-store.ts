import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatMessage } from '../../shared/chat-types'
import { isEffort, isModelName } from '../../shared/chat-types'

// ---------------------------------------------------------------- conversation history (kept across restarts)

const MAX_STORED = 600

export interface Conversation {
  messages: ChatMessage[]
  /** Summary of the older part of the conversation ('' = none). */
  summary: string
}

/** Real turns only (notices are not worth keeping). A missing or damaged file just means an empty conversation. */
export function loadHistory(path: string): ChatMessage[] {
  return loadConversation(path).messages
}

export function loadConversation(path: string): Conversation {
  const empty: Conversation = { messages: [], summary: '' }
  if (!existsSync(path)) return empty
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const list = (raw as { messages?: unknown })?.messages
    const sum = (raw as { summary?: unknown })?.summary
    const summary = typeof sum === 'string' ? sum.slice(0, 4000) : ''
    if (!Array.isArray(list)) return { ...empty, summary }
    const out: ChatMessage[] = []
    for (const m of list) {
      if (typeof m !== 'object' || m === null) continue
      const { role, text, screen, summarized } = m as Record<string, unknown>
      if ((role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim()) {
        out.push({ id: out.length + 1, role, text, ...(role === 'user' && screen === true ? { screen: true } : {}), ...(summarized === true ? { summarized: true } : {}) })
      }
    }
    return { messages: out.slice(-MAX_STORED).map((m, i) => ({ ...m, id: i + 1 })), summary }
  } catch {
    return empty
  }
}

/** Atomic and private (0600): the file holds the whole conversation. */
export function saveHistory(path: string, messages: ChatMessage[], summary = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  const keep = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-MAX_STORED)
    .map((m) => ({ role: m.role, text: m.text, ...(m.screen ? { screen: true } : {}), ...(m.summarized ? { summarized: true } : {}) })) // the image itself is never saved
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ messages: keep, ...(summary ? { summary } : {}) }) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- model / effort choice

export interface VoicePref {
  engine: 'local' | 'say'
  /** local: the installed voice model id; say: unused. */
  model?: string
  sid?: number
  /** say: the macOS voice name ("" = system default). */
  sayVoice?: string
}

export interface Prefs {
  /** The service the model/effort below were chosen for; they are ignored if settings.json now names another service. */
  provider?: string
  model?: string
  effort?: string
  /** The voice picked from the menu (wins over settings.json until changed again). */
  voice?: VoicePref
  /** Keep the cat above other apps and on every Space ("bring the cat with me"). Off: it lives on the desktop, behind your apps. */
  bringWithMe?: boolean
  /** Where the cat wanders: the whole desktop surface (default) or only along the bottom edge. */
  roam?: 'edges' | 'desktop' | 'dock'
  /** Rest at home when not in use (see cat.restAtHome). */
  rest?: boolean
  /** Where he rests: the window's top-left corner, as last set by dragging him while he rested. */
  home?: { x: number; y: number }
  /** The chat panel's size, as last set by the user. */
  chatSize?: { w: number; h: number }
}

export const CHAT_MIN = { w: 340, h: 280 }
export const CHAT_MAX = { w: 1200, h: 1400 }

export function loadPrefs(path: string): Prefs {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const cs = raw['chatSize'] as { w?: unknown; h?: unknown } | undefined
    const size = cs && typeof cs.w === 'number' && typeof cs.h === 'number' && Number.isFinite(cs.w) && Number.isFinite(cs.h) ? { w: clampN(cs.w, CHAT_MIN.w, CHAT_MAX.w), h: clampN(cs.h, CHAT_MIN.h, CHAT_MAX.h) } : undefined
    const v = raw['voice'] as Record<string, unknown> | undefined
    const voice: VoicePref | undefined =
      v && (v['engine'] === 'local' || v['engine'] === 'say')
        ? {
            engine: v['engine'],
            ...(typeof v['model'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v['model']) ? { model: v['model'] } : {}),
            ...(typeof v['sid'] === 'number' && Number.isInteger(v['sid']) && v['sid'] >= 0 && v['sid'] <= 2000 ? { sid: v['sid'] } : {}),
            ...(typeof v['sayVoice'] === 'string' && /^[\p{L}\p{N} ().'_-]{0,60}$/u.test(v['sayVoice']) ? { sayVoice: v['sayVoice'] } : {})
          }
        : undefined
    return {
      ...(typeof raw['provider'] === 'string' && /^[a-z0-9-]{1,30}$/.test(raw['provider']) ? { provider: raw['provider'] } : {}),
      ...(voice ? { voice } : {}),
      ...(isModelName(raw['model']) ? { model: raw['model'] } : {}),
      ...(isEffort(raw['effort']) ? { effort: raw['effort'] } : {}),
      ...(typeof raw['bringWithMe'] === 'boolean' ? { bringWithMe: raw['bringWithMe'] } : {}),
      ...(typeof raw['rest'] === 'boolean' ? { rest: raw['rest'] } : {}),
      ...(isPoint(raw['home']) ? { home: { x: Math.round(raw['home'].x), y: Math.round(raw['home'].y) } } : {}),
      ...(raw['roam'] === 'edges' || raw['roam'] === 'desktop' || raw['roam'] === 'dock' ? { roam: raw['roam'] } : {}),
      ...(size ? { chatSize: size } : {})
    }
  } catch {
    return {}
  }
}

const isPoint = (v: unknown): v is { x: number; y: number } => typeof v === 'object' && v !== null && Number.isFinite((v as { x?: unknown }).x) && Number.isFinite((v as { y?: unknown }).y) && Math.abs((v as { x: number }).x) < 1e6 && Math.abs((v as { y: number }).y) < 1e6
const clampN = (v: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, v)))

export function savePrefs(path: string, prefs: Prefs): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n')
  renameSync(tmp, path)
}
