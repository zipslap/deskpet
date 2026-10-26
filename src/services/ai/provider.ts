/**
 * The boundary between the pet and whatever answers its messages. The UI and pet logic only know this interface,
 * so the offline mock can be replaced by any real service (a CLI, an HTTP API...) without touching them.
 */
export type AssistantContext = {
  activeApp?: string
  activeWindowTitle?: string
  /** A screenshot the user explicitly asked to share with this one message (base64, in memory only). */
  screenshotBase64?: string
  screenshotMime?: 'image/jpeg' | 'image/png'
  /** Other pictures the user chose to send with this one request (e.g. inspiration images for a pet design). In memory only. */
  images?: ContextImage[]
  /** The conversation so far, oldest first, not including the message being sent. Bounded by the caller. */
  history?: ChatTurn[]
}

export interface ContextImage {
  base64: string
  mime: 'image/jpeg' | 'image/png'
}

/** Every picture attached to a request: the shared screenshot first, then any others. */
export function imagesOf(c?: AssistantContext): ContextImage[] {
  return [...(c?.screenshotBase64 ? [{ base64: c.screenshotBase64, mime: c.screenshotMime ?? 'image/jpeg' } as ContextImage] : []), ...(c?.images ?? [])]
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatProvider {
  /** Streams the reply as text chunks. Must stop promptly and throw/return when `signal` aborts. */
  sendMessage(message: string, context?: AssistantContext, signal?: AbortSignal): AsyncIterable<string>
  /** Stop everything still running (app quit). */
  dispose?(): void
  /** The model names the service offers, when it can say. Never throws; empty when unknown. */
  listModels?(signal?: AbortSignal): Promise<string[]>
}

/** An expected, user-presentable failure (bad credentials, rate limit, network...). Its message is shown as-is. */
export class ProviderError extends Error {
  override name = 'ProviderError'
}
