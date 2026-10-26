import type { AssistantInfo, ChatMessage, ChatSnapshot, ChatStatus } from '../../shared/chat-types'
import { buildSummaryRequest, cleanSummary, planCompaction, summaryTurn } from '../memory/summary'
import { ProviderError, type ChatTurn, type ChatProvider } from './provider'

export type SessionEvent = 'submitted' | 'started' | 'ended'
/** How a request ended. Only 'completed' means the reply is whole. */
export type Outcome = 'completed' | 'cancelled' | 'failed'

export interface ChatSessionOptions {
  onChange: (snapshot: ChatSnapshot) => void
  /** Drives the pet's state machine. 'ended' fires exactly once per request (with its outcome): done, cancelled, failed or timed out. */
  onEvent: (event: SessionEvent, outcome?: Outcome) => void
  /** Every streamed text chunk of the current reply, in order. Never called for stale (cancelled) requests. */
  onChunk?: (chunk: string) => void
  /** Give up if nothing at all arrives for this long (first reply, or between chunks of a stream). */
  timeoutMs?: number
  /** Oldest messages are dropped beyond this many (conversation context is bounded). */
  maxMessages?: number
  /** Who is answering; included in every snapshot for display. */
  assistant?: AssistantInfo
  /** The conversation restored from disk (real turns only). */
  initialMessages?: ChatMessage[]
  /** The summary of the older part of the conversation, restored from disk. */
  initialSummary?: string
  /** Called with the transcript (and the summary) whenever a turn finishes (completed or not) or the conversation changes, so it can be saved. */
  onPersist?: (messages: ChatMessage[], summary: string) => void
  /**
   * Folds older turns into a summary when the conversation gets long: gets the previous summary and the turns to fold in,
   * returns the new summary. Optional; without it nothing is ever summarised.
   */
  summarizer?: (previous: string, turns: ChatTurn[]) => Promise<string>
  /** When to summarise (characters of unsummarised conversation) and how much recent conversation to keep as-is. Tests shrink these. */
  compaction?: { trigger: number; keep: number }
}

export type SendResult = 'ok' | 'busy'

/** Something the user explicitly shared with one message. */
export interface Attachment {
  screenshotBase64: string
  screenshotMime: 'image/jpeg' | 'image/png'
  /** Preview for the transcript. */
  thumbDataUrl: string
}

interface Active {
  id: number
  abort: AbortController
  timer: NodeJS.Timeout
  assistantId: number | null
}

/**
 * One conversation, one request at a time. Every request gets an id; anything that arrives for an id that is no
 * longer current (cancelled, timed out, superseded) is ignored, so a late reply can never corrupt the transcript
 * or the pet's state.
 */
export class ChatSession {
  private messages: ChatMessage[] = []
  private assistant: AssistantInfo | undefined
  private summary = ''
  private compacting = false
  private status: ChatStatus = 'idle'
  private active: Active | null = null
  private seq = 0
  private msgId = 0
  private readonly timeoutMs: number
  private readonly maxMessages: number

  constructor(
    private readonly provider: ChatProvider,
    private readonly opts: ChatSessionOptions
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.maxMessages = opts.maxMessages ?? 40
    this.assistant = opts.assistant
    this.summary = opts.initialSummary ?? ''
    if (opts.initialMessages) {
      this.messages = opts.initialMessages.map((m, i) => ({ ...m, id: i + 1 })).slice(-this.maxMessages)
      this.msgId = this.messages.length
    }
  }

  /** Change who is shown as answering (model switch). Does not touch a request in flight. */
  setAssistant(info: AssistantInfo): void {
    this.assistant = info
    this.emit()
  }

  get summaryText(): string {
    return this.summary
  }

  /** Forget the older part of the conversation: the summary is deleted (the dimmed messages stay on screen but are never sent again). */
  clearSummary(): void {
    this.summary = ''
    this.persist()
    this.emit()
  }

  private persist(): void {
    this.opts.onPersist?.(this.messages, this.summary)
  }

  /** Add a local note to the transcript (not sent to the assistant, not saved). */
  notice(text: string, error = false): void {
    this.push({ role: 'notice', text, ...(error ? { error: true } : {}) })
  }

  get busy(): boolean {
    return this.active !== null
  }

  snapshot(): ChatSnapshot {
    return { messages: this.messages.map((m) => ({ ...m })), status: this.status, ...(this.assistant ? { assistant: { ...this.assistant } } : {}) }
  }

  send(text: string, attachment?: Attachment): SendResult {
    if (this.active) return 'busy'
    const id = ++this.seq
    const abort = new AbortController()
    const history = this.history()
    this.active = { id, abort, timer: this.armTimer(id), assistantId: null }
    this.status = 'pending'
    this.push({ role: 'user', text, ...(attachment ? { screen: true, image: attachment.thumbDataUrl } : {}) })
    this.persist()
    this.opts.onEvent('submitted')
    void this.run(id, text, history, abort.signal, attachment)
    return 'ok'
  }

  /** Cancel the in-flight request, if any. Returns whether there was one. */
  cancel(reason = 'Cancelled.'): boolean {
    const a = this.active
    if (!a) return false
    this.finish(a)
    this.status = 'idle'
    this.push({ role: 'notice', text: reason })
    this.persist()
    this.opts.onEvent('ended', 'cancelled')
    return true
  }

  clear(): void {
    this.cancel()
    this.messages = []
    this.summary = ''
    this.emit()
    this.persist()
  }

  // ---------- internals ----------
  /** What the assistant is told about the conversation so far: real turns only (no notices, no empty replies). */
  private history(): ChatTurn[] {
    const turns: ChatTurn[] = this.summary ? [summaryTurn(this.summary)] : []
    for (const m of this.messages) {
      if (m.summarized) continue
      if ((m.role === 'user' || m.role === 'assistant') && m.text.trim()) turns.push({ role: m.role, text: m.screen ? `[Screenshot of my screen attached] ${m.text}` : m.text })
    }
    return turns
  }

  /** After a reply: if the unsummarised conversation has grown too long, fold its older part into the summary. Never blocks or fails a chat. */
  private async compact(): Promise<void> {
    const fold = this.opts.summarizer
    if (!fold || this.compacting) return
    const split = planCompaction(this.messages, this.opts.compaction?.trigger, this.opts.compaction?.keep)
    if (split === null) return
    this.compacting = true
    try {
      const upto = this.messages[split - 1]?.id
      const batch = this.messages.slice(0, split).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim() && !m.summarized)
      const turns: ChatTurn[] = batch.map((m) => ({ role: m.role as 'user' | 'assistant', text: m.screen ? `[Screenshot of my screen attached] ${m.text}` : m.text }))
      const next = cleanSummary(await fold(this.summary, turns))
      if (!next || upto === undefined) return
      this.summary = next
      for (const m of this.messages) if (m.id <= upto) m.summarized = true
      this.push({ role: 'notice', text: 'The older part of this conversation was summarised to keep it going. Open 🗂 to read or forget the summary.' })
      this.persist()
    } catch {
      /* try again after a later turn */
    } finally {
      this.compacting = false
    }
  }

  private async run(id: number, text: string, history: ChatTurn[], signal: AbortSignal, attachment?: Attachment): Promise<void> {
    try {
      let got = false
      const context = { history, ...(attachment ? { screenshotBase64: attachment.screenshotBase64, screenshotMime: attachment.screenshotMime } : {}) }
      for await (const chunk of this.provider.sendMessage(text, context, signal)) {
        if (this.active?.id !== id) return // stale: cancelled, timed out or superseded
        this.active.timer = this.armTimer(id, this.active.timer) // progress: a long reply is not a stalled one
        if (!got) {
          got = true
          this.active.assistantId = this.push({ role: 'assistant', text: '' })
          this.status = 'streaming'
          this.opts.onEvent('started')
        }
        this.append(this.active.assistantId!, chunk)
        this.opts.onChunk?.(chunk)
      }
      if (this.active?.id !== id) return
      if (!got) this.push({ role: 'notice', text: 'The assistant sent no reply.' })
      this.finish(this.active)
      this.status = 'idle'
      this.emit()
      this.persist()
      this.opts.onEvent('ended', 'completed')
      void this.compact()
    } catch (err) {
      if (this.active?.id !== id) return // an abort we caused, or a stale failure
      const msg = err instanceof ProviderError ? err.message : 'Something went wrong. You can try again.'
      this.fail(id, msg)
    }
  }

  /** (Re)start the inactivity timer for request `id`. */
  private armTimer(id: number, previous?: NodeJS.Timeout): NodeJS.Timeout {
    if (previous) clearTimeout(previous)
    return setTimeout(() => this.fail(id, 'No reply in time. You can try again.'), this.timeoutMs)
  }

  private fail(id: number, message: string): void {
    const a = this.active
    if (!a || a.id !== id) return
    this.finish(a)
    a.abort.abort()
    this.status = 'idle'
    this.push({ role: 'notice', text: message, error: true })
    this.persist()
    this.opts.onEvent('ended', 'failed')
  }

  /** Detach the request: stop its timer and abort the provider call. After this, its results are stale. */
  private finish(a: Active): void {
    clearTimeout(a.timer)
    if (!a.abort.signal.aborted) a.abort.abort()
    this.active = null
  }

  private push(m: Omit<ChatMessage, 'id'>): number {
    const id = ++this.msgId
    this.messages.push({ id, ...m })
    if (this.messages.length > this.maxMessages) this.messages.splice(0, this.messages.length - this.maxMessages)
    this.emit()
    return id
  }

  private append(id: number, chunk: string): void {
    const m = this.messages.find((x) => x.id === id)
    if (!m) return // trimmed away while streaming (only possible with a tiny maxMessages)
    m.text += chunk
    this.emit()
  }

  private emit(): void {
    this.opts.onChange(this.snapshot())
  }
}
