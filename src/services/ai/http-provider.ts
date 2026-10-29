import { StringDecoder } from 'node:string_decoder'
import { imagesOf, ProviderError, type AssistantContext, type ChatProvider, type ChatTurn } from './provider'
import { isSafeBaseUrl } from './presets'

/**
 * Talks to a hosted (or local) model over HTTPS with an API key: the OpenAI chat-completions protocol, which a long list of
 * services speak (OpenAI, Gemini, OpenRouter, Groq, Mistral, Ollama, LM Studio...), or Anthropic's messages API.
 * The key is fetched through `getKey` for every request and goes only into the request headers.
 */

export interface HttpProviderOptions {
  kind: 'openai-compatible' | 'anthropic'
  /** Shown in error messages, e.g. "OpenAI". */
  service: string
  baseUrl: string
  /** Null when the service needs no key (a local server). */
  getKey: () => Promise<string | null>
  /** True when a missing key is an error. */
  needsKey: boolean
  /** Asked on every message, so the model can be switched while the app runs. */
  model: () => string
  systemPrompt: (info: { screen: boolean }) => string
  /** Anthropic requires a limit; ignored by the other protocol. */
  maxTokens?: number
  /** Conversation text sent along is trimmed (oldest first) to this many characters. */
  maxPromptChars?: number
  /** A reply longer than this is cut off with an error. */
  maxReplyChars?: number
  /** For tests. */
  fetch?: typeof fetch
}

const oneLine = (s: string, max = 160): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' })

/** Roles must alternate and start with the user for some services: merge neighbours, drop a leading assistant turn, trim to a size. */
export function normaliseTurns(history: ChatTurn[], maxChars = 200_000): ChatTurn[] {
  const merged: ChatTurn[] = []
  for (const t of history) {
    const text = t.text.trim()
    if (!text) continue
    const last = merged[merged.length - 1]
    if (last && last.role === t.role) last.text += `\n\n${text}`
    else merged.push({ role: t.role, text })
  }
  let used = 0
  const kept: ChatTurn[] = []
  for (let i = merged.length - 1; i >= 0; i--) {
    used += merged[i]!.text.length
    if (used > maxChars && kept.length > 0) break
    kept.unshift(merged[i]!)
  }
  while (kept[0]?.role === 'assistant') kept.shift()
  return kept
}

export type ChatMessageBody = { role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }

/** Request body for the OpenAI chat-completions protocol. */
type Img = { base64: string; mime: string }
const asList = (i?: Img | Img[]): Img[] => (Array.isArray(i) ? i : i ? [i] : [])

export function buildOpenAiBody(model: string, system: string, history: ChatTurn[], message: string, image?: Img | Img[]): Record<string, unknown> {
  const imgs = asList(image)
  const user: ChatMessageBody['content'] = imgs.length
    ? [{ type: 'text', text: message }, ...imgs.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } }))]
    : message
  const messages: ChatMessageBody[] = [{ role: 'system', content: system }, ...history.map((t) => ({ role: t.role, content: t.text })), { role: 'user', content: user }]
  return { model, stream: true, messages }
}

/** Request body for Anthropic's messages API. */
export function buildAnthropicBody(model: string, system: string, history: ChatTurn[], message: string, maxTokens: number, image?: Img | Img[]): Record<string, unknown> {
  const imgs = asList(image)
  const user: ChatMessageBody['content'] = imgs.length
    ? [...imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } })), { type: 'text', text: message }]
    : message
  return { model, max_tokens: maxTokens, stream: true, system, messages: [...history.map((t) => ({ role: t.role, content: t.text })), { role: 'user', content: user }] }
}

export type SseEvent = { event: string; data: string }

/** Incremental server-sent-events parser: feed text, get whole events back. */
export class SseParser {
  private buf = ''
  private event = ''
  private data: string[] = []

  push(text: string): SseEvent[] {
    this.buf += text
    const out: SseEvent[] = []
    let nl: number
    while ((nl = this.buf.search(/\r\n|\n|\r/)) >= 0) {
      const sep = this.buf.startsWith('\r\n', nl) ? 2 : 1
      const line = this.buf.slice(0, nl)
      // a lone "\r" at the very end may be the first half of "\r\n": wait for more
      if (this.buf[nl] === '\r' && nl + 1 === this.buf.length) break
      this.buf = this.buf.slice(nl + sep)
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') })
        this.event = ''
        this.data = []
      } else if (line.startsWith(':')) {
        // comment / keep-alive
      } else {
        const c = line.indexOf(':')
        const field = c < 0 ? line : line.slice(0, c)
        let value = c < 0 ? '' : line.slice(c + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') this.event = value
        else if (field === 'data') this.data.push(value)
      }
    }
    return out
  }
}

/** One decoded stream event, reduced to what the chat needs. */
export type Delta = { text: string } | { error: string } | { done: true } | null

export function parseOpenAiEvent(e: SseEvent): Delta {
  if (e.data.trim() === '[DONE]') return { done: true }
  let j: unknown
  try {
    j = JSON.parse(e.data)
  } catch {
    return null
  }
  if (!isObj(j)) return null
  if (j['error'] !== undefined) return { error: errorText(j['error']) }
  const choices = j['choices']
  const c = Array.isArray(choices) ? choices[0] : undefined
  const delta = isObj(c) ? c['delta'] : undefined
  const text = isObj(delta) ? delta['content'] : undefined
  return typeof text === 'string' && text !== '' ? { text } : null
}

export function parseAnthropicEvent(e: SseEvent): Delta {
  let j: unknown
  try {
    j = JSON.parse(e.data)
  } catch {
    return null
  }
  if (!isObj(j)) return null
  const type = j['type'] ?? e.event
  if (type === 'error') return { error: errorText(j['error']) }
  if (type === 'message_stop') return { done: true }
  if (type === 'content_block_delta') {
    const d = j['delta']
    if (isObj(d) && d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text'] !== '') return { text: d['text'] }
  }
  return null
}

function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (isObj(e)) {
    if (typeof e['message'] === 'string') return e['message']
    if (isObj(e['error']) && typeof e['error']['message'] === 'string') return e['error']['message']
  }
  return ''
}

/** A user-presentable message for an HTTP failure. */
export function classifyHttpError(service: string, status: number, body: string): string {
  let detail = ''
  try {
    detail = errorText(JSON.parse(body))
  } catch {
    detail = body
  }
  detail = oneLine(detail, 140)
  const tail = detail ? ` (${service} says: ${detail})` : ''
  if (status === 401 || status === 403) return `${service} rejected the API key (HTTP ${status}). Check it, or store a new one in Set up (the plug button in the chat header; or run: npm run setup)${tail}`
  if (status === 404) return `${service} doesn't know that model or address (HTTP 404). Try /model <name> with a model your account offers.${tail}`
  if (status === 408 || status === 504) return `${service} took too long to answer. Try again.${tail}`
  if (status === 429) return `${service}'s rate limit or quota was hit. Try again later, or check your plan.${tail}`
  if (status >= 500) return `${service} is busy or having problems (HTTP ${status}). Try again in a moment.${tail}`
  if (status === 400 || status === 413 || status === 422) return `${service} refused the request (HTTP ${status}).${tail}`
  return `${service} returned HTTP ${status}.${tail}`
}

export function classifyNetworkError(service: string, err: unknown): string {
  const cause = isObj(err) && isObj(err['cause']) ? String(err['cause']['code'] ?? '') : ''
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR/.test(cause) || (err instanceof TypeError && /fetch failed/i.test(err.message))) {
    return `Couldn't reach ${service}. Check your internet connection (or that the local server is running) and try again.`
  }
  return `Couldn't talk to ${service}${err instanceof Error ? ` (${oneLine(err.message, 100)})` : ''}.`
}

const join = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`

export class HttpProvider implements ChatProvider {
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly opts: HttpProviderOptions) {}

  dispose(): void {
    for (const c of this.controllers) c.abort()
    this.controllers.clear()
  }

  /** The model ids the service offers, for the panel's list. Empty on any failure. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const o = this.opts
    if (!isSafeBaseUrl(o.baseUrl)) return []
    try {
      const key = await o.getKey()
      if (o.needsKey && !key) return []
      const res = await (o.fetch ?? fetch)(join(o.baseUrl, o.kind === 'anthropic' ? '/v1/models?limit=100' : '/models'), { headers: this.headers(key), signal: signal ?? AbortSignal.timeout(8000) })
      if (!res.ok) return []
      const j: unknown = await res.json()
      const rows = isObj(j) && Array.isArray(j['data']) ? j['data'] : isObj(j) && Array.isArray(j['models']) ? j['models'] : []
      const ids = rows.map((r) => (isObj(r) ? r['id'] ?? r['name'] : undefined)).filter((x): x is string => typeof x === 'string')
      return [...new Set(ids.map((id) => id.replace(/^models\//, '')))].filter((id) => /^[A-Za-z0-9][A-Za-z0-9._\-:/@[\]]{0,79}$/.test(id)).sort().slice(0, 60)
    } catch {
      return []
    }
  }

  private headers(key: string | null): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.opts.kind === 'anthropic') {
      h['anthropic-version'] = '2023-06-01'
      if (key) h['x-api-key'] = key
    } else if (key) h['authorization'] = `Bearer ${key}`
    return h
  }

  async *sendMessage(message: string, context?: AssistantContext, signal?: AbortSignal): AsyncIterable<string> {
    const o = this.opts
    if (signal?.aborted) throw abortError()
    if (!isSafeBaseUrl(o.baseUrl)) throw new ProviderError(`${o.service}: the address ${oneLine(o.baseUrl, 60)} must start with https:// (http:// is only allowed for a server on this computer).`)
    const model = o.model().trim()
    if (!model) throw new ProviderError(`No model is set for ${o.service}. Say /model <name>, or set "ai.model" in settings.json.`)
    const key = await o.getKey()
    if (o.needsKey && !key) throw new ProviderError(`No API key found for ${o.service}. Add one in Set up (the plug button in the chat header; or run: npm run setup)`)
    if (signal?.aborted) throw abortError()

    const image = imagesOf(context)
    const system = o.systemPrompt({ screen: Boolean(context?.screenshotBase64) })
    const history = normaliseTurns(context?.history ?? [], o.maxPromptChars)
    const body =
      o.kind === 'anthropic'
        ? buildAnthropicBody(model, system, history, message, o.maxTokens ?? 8192, image)
        : buildOpenAiBody(model, system, history, message, image)

    const ctl = new AbortController()
    this.controllers.add(ctl)
    const onAbort = (): void => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let res: Response
      try {
        res = await (o.fetch ?? fetch)(join(o.baseUrl, o.kind === 'anthropic' ? '/v1/messages' : '/chat/completions'), {
          method: 'POST',
          headers: this.headers(key),
          body: JSON.stringify(body),
          signal: ctl.signal
        })
      } catch (e) {
        if (signal?.aborted) throw abortError()
        throw new ProviderError(classifyNetworkError(o.service, e))
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new ProviderError(classifyHttpError(o.service, res.status, text.slice(0, 4000)))
      }
      if (!res.body) throw new ProviderError(`${o.service} sent an empty response.`)

      const parse = o.kind === 'anthropic' ? parseAnthropicEvent : parseOpenAiEvent
      const sse = new SseParser()
      const decoder = new StringDecoder('utf8')
      const maxReply = o.maxReplyChars ?? 100_000
      let streamed = 0
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          for (const ev of sse.push(decoder.write(Buffer.from(chunk)))) {
            const d = parse(ev)
            if (!d) continue
            if ('text' in d) {
              streamed += d.text.length
              if (streamed > maxReply) throw new ProviderError('The reply was too long and was cut off.')
              yield d.text
            } else if ('error' in d) {
              throw new ProviderError(`${o.service} reported an error${d.error ? `: ${oneLine(d.error, 140)}` : '.'}`)
            }
          }
        }
      } catch (e) {
        if (signal?.aborted) throw abortError()
        if (e instanceof ProviderError) throw e
        throw new ProviderError(classifyNetworkError(o.service, e))
      }
      if (signal?.aborted) throw abortError()
      if (streamed === 0) throw new ProviderError(`${o.service} ended without replying.`)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      ctl.abort()
      this.controllers.delete(ctl)
    }
  }
}
