/** Shapes shared by the chat session (main), the chat window (renderer) and tests. */
export type ChatRole = 'user' | 'assistant' | 'notice'
export type ChatStatus = 'idle' | 'pending' | 'streaming'

export interface ChatMessage {
  id: number
  role: ChatRole
  text: string
  /** Shown as an error bubble ("notice" messages only). */
  error?: boolean
  /** The user shared a screenshot with this message (user messages only). Kept so later turns know what was shared. */
  screen?: boolean
  /** Folded into the conversation summary: still shown (dimmed), no longer sent to the assistant itself. */
  summarized?: boolean
  /** A small preview of what was shared, shown in the bubble. In memory only: never saved, gone after a restart. */
  image?: string
}

export const THUMB_PREFIX = 'data:image/jpeg;base64,'
export const MAX_THUMB_CHARS = 150_000

/** Who is answering, shown in the panel header so the offline mock is never mistaken for the real thing. */
export interface AssistantInfo {
  name: string
  /** True for the built-in mock: nothing leaves the computer. */
  offline: boolean
  /** The model now answering and the ones the panel offers. */
  model?: string
  models?: string[]
  /** Reasoning effort now in use ('auto' = the model's own default) and the choices. Only the `claude` command offers this. */
  effort?: string
  efforts?: string[]
}

export const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** Letters, digits and . _ - : / @ [ ] cover every service's model ids ("gpt-4o", "llama3.2:latest", "openai/gpt-4o", "gemini-2.5-flash"). */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-:/@[\]]{0,79}$/
export const isModelName = (v: unknown): v is string => typeof v === 'string' && MODEL_NAME.test(v)
export const isEffort = (v: unknown): v is (typeof EFFORTS)[number] => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** A request from the panel to change model and/or effort. */
export function parseModelChoice(v: unknown): { model?: string; effort?: string } | null {
  if (typeof v !== 'object' || v === null) return null
  const { model, effort } = v as Record<string, unknown>
  const out: { model?: string; effort?: string } = {}
  if (model !== undefined) {
    if (!isModelName(model)) return null
    out.model = model
  }
  if (effort !== undefined) {
    if (!isEffort(effort)) return null
    out.effort = effort
  }
  return out.model !== undefined || out.effort !== undefined ? out : null
}

export interface ChatSnapshot {
  messages: ChatMessage[]
  status: ChatStatus
  assistant?: AssistantInfo
}

/** Validates a snapshot received over IPC in the chat renderer. */
export function parseSnapshot(v: unknown): ChatSnapshot | null {
  if (typeof v !== 'object' || v === null) return null
  const { messages, status, assistant } = v as Record<string, unknown>
  if (!Array.isArray(messages) || (status !== 'idle' && status !== 'pending' && status !== 'streaming')) return null
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) return null
    const { id, role, text, error, screen, image, summarized } = m as Record<string, unknown>
    if (typeof id !== 'number' || typeof text !== 'string') return null
    if (role !== 'user' && role !== 'assistant' && role !== 'notice') return null
    const thumb = typeof image === 'string' && image.startsWith(THUMB_PREFIX) && image.length <= MAX_THUMB_CHARS && /^[A-Za-z0-9+/=]*$/.test(image.slice(THUMB_PREFIX.length)) ? image : undefined
    out.push({ id, role, text, ...(error === true ? { error: true } : {}), ...(screen === true ? { screen: true } : {}), ...(summarized === true ? { summarized: true } : {}), ...(thumb ? { image: thumb } : {}) })
  }
  let info: AssistantInfo | undefined
  if (typeof assistant === 'object' && assistant !== null) {
    const { name, offline, model, models, effort, efforts } = assistant as Record<string, unknown>
    if (typeof name === 'string' && typeof offline === 'boolean') {
      info = { name: name.slice(0, 60), offline }
      if (isModelName(model)) info.model = model
      if (Array.isArray(models)) info.models = models.filter(isModelName).slice(0, 80)
      if (isEffort(effort)) info.effort = effort
      if (Array.isArray(efforts)) info.efforts = efforts.filter(isEffort)
    }
  }
  return { messages: out, status, ...(info ? { assistant: info } : {}) }
}
