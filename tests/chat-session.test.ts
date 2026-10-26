import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession, type Outcome, type SessionEvent } from '../src/services/ai/chat-session'
import { ProviderError, type ChatProvider } from '../src/services/ai/provider'
import type { ChatSnapshot } from '../src/shared/chat-types'

/** One provider call, driven by hand: push chunks, end or fail it. It deliberately ignores abort signals. */
class Channel {
  private queue: Array<{ chunk?: string; end?: true; err?: Error }> = []
  private wake: (() => void) | null = null
  signal: AbortSignal | undefined
  push(chunk: string): void { this.queue.push({ chunk }); this.wake?.() }
  end(): void { this.queue.push({ end: true }); this.wake?.() }
  fail(err: Error): void { this.queue.push({ err }); this.wake?.() }
  async *stream(): AsyncIterable<string> {
    // NOTE: does NOT stop on abort: a misbehaving provider must not be able to corrupt the session.
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>((r) => (this.wake = r))
      const item = this.queue.shift()!
      if (item.err) throw item.err
      if (item.end) return
      yield item.chunk!
    }
  }
}
/** Every sendMessage call gets its own Channel; the helpers on this class act on the most recent one. */
class Scripted implements ChatProvider {
  channels: Channel[] = []
  get current(): Channel { return this.channels.at(-1)! }
  get signal(): AbortSignal | undefined { return this.current.signal }
  push(c: string): void { this.current.push(c) }
  end(): void { this.current.end() }
  fail(e: Error): void { this.current.fail(e) }
  contexts: Array<{ history?: Array<{ role: string; text: string }> } | undefined> = []
  sendMessage(_m: string, context?: { history?: Array<{ role: string; text: string }> }, signal?: AbortSignal): AsyncIterable<string> {
    this.contexts.push(context)
    const ch = new Channel()
    ch.signal = signal
    this.channels.push(ch)
    return ch.stream()
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await tick() }

function setup(opts: { timeoutMs?: number; maxMessages?: number } = {}) {
  const provider = new Scripted()
  const events: SessionEvent[] = []
  let last: ChatSnapshot = { messages: [], status: 'idle' }
  const session = new ChatSession(provider, { onChange: (s) => (last = s), onEvent: (e) => events.push(e), ...opts })
  return { provider, events, session, snap: () => last }
}
const texts = (s: ChatSnapshot): string[] => s.messages.map((m) => `${m.role}:${m.text}`)

describe('ChatSession: assistant info', () => {
  it('is carried in every snapshot when given, and absent otherwise', () => {
    const provider = new Scripted()
    let last: ChatSnapshot | null = null
    const withInfo = new ChatSession(provider, { onChange: (s) => (last = s), onEvent: () => {}, assistant: { name: 'Claude (haiku)', offline: false } })
    expect(withInfo.snapshot().assistant).toEqual({ name: 'Claude (haiku)', offline: false })
    withInfo.send('hi')
    expect(last!.assistant).toEqual({ name: 'Claude (haiku)', offline: false })
    expect(setup().session.snapshot()).not.toHaveProperty('assistant')
  })
})

describe('ChatSession: conversation history for the assistant', () => {
  it('sends nothing before the first message, then each earlier exchange (not the new message)', async () => {
    const { provider, session } = setup()
    session.send('first')
    expect(provider.contexts[0]!.history).toEqual([])
    provider.push('one')
    provider.end()
    await flush()
    session.send('second')
    expect(provider.contexts[1]!.history).toEqual([{ role: 'user', text: 'first' }, { role: 'assistant', text: 'one' }])
  })
  it('leaves out notices and empty replies, keeps a cancelled partial reply', async () => {
    const { provider, session } = setup()
    session.send('a')
    session.cancel('Cancelled.') // notice, no reply
    session.send('b')
    provider.push('partial')
    await flush()
    session.cancel('Cancelled.')
    session.send('c')
    expect(provider.contexts[2]!.history).toEqual([
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' },
      { role: 'assistant', text: 'partial' }
    ])
  })
  it('is bounded by the transcript limit', async () => {
    const { provider, session } = setup({ maxMessages: 4 })
    for (let i = 0; i < 5; i++) {
      session.send(`m${i}`)
      provider.push(`r${i}`)
      provider.end()
      await flush()
    }
    session.send('last')
    expect(provider.contexts.at(-1)!.history!.length).toBeLessThanOrEqual(4)
  })
})

describe('ChatSession', () => {
  it('happy path: pending -> streaming -> idle, events in order', async () => {
    const { provider, session, events, snap } = setup()
    expect(session.send('hi')).toBe('ok')
    expect(snap().status).toBe('pending')
    provider.push('Hello ')
    await flush()
    expect(snap().status).toBe('streaming')
    provider.push('there')
    provider.end()
    await flush()
    expect(snap().status).toBe('idle')
    expect(texts(snap())).toEqual(['user:hi', 'assistant:Hello there'])
    expect(events).toEqual(['submitted', 'started', 'ended'])
    expect(session.busy).toBe(false)
  })

  it('refuses a second message while busy, without touching the transcript', async () => {
    const { session, snap } = setup()
    session.send('one')
    expect(session.send('two')).toBe('busy')
    expect(texts(snap())).toEqual(['user:one'])
  })

  it('cancel while pending: notice, idle, one "ended"; a late reply is ignored', async () => {
    const { provider, session, events, snap } = setup()
    session.send('hi')
    expect(session.cancel()).toBe(true)
    expect(provider.signal?.aborted).toBe(true)
    provider.push('too late')
    provider.end()
    await flush()
    expect(texts(snap())).toEqual(['user:hi', 'notice:Cancelled.'])
    expect(snap().status).toBe('idle')
    expect(events).toEqual(['submitted', 'ended'])
    expect(session.cancel()).toBe(false) // nothing left to cancel
  })

  it('cancel while streaming keeps the partial text and ignores the rest', async () => {
    const { provider, session, events, snap } = setup()
    session.send('hi')
    provider.push('Part one ')
    await flush()
    session.cancel()
    provider.push('part two')
    await flush()
    expect(texts(snap())).toEqual(['user:hi', 'assistant:Part one ', 'notice:Cancelled.'])
    expect(events).toEqual(['submitted', 'started', 'ended'])
  })

  it('a new request after a cancel is not polluted by the abandoned one', async () => {
    const { provider, session, snap, events } = setup()
    session.send('one')
    const stale = provider.current
    session.cancel()
    expect(session.send('two')).toBe('ok')
    stale.push('STALE TEXT') // the abandoned call keeps talking
    stale.fail(new ProviderError('STALE FAILURE'))
    await flush()
    expect(snap().messages.some((m) => m.text.includes('STALE'))).toBe(false)
    expect(session.busy).toBe(true) // request two is untouched
    provider.push('fresh')
    provider.end()
    await flush()
    expect(texts(snap())).toEqual(['user:one', 'notice:Cancelled.', 'user:two', 'assistant:fresh'])
    expect(events.filter((e) => e === 'ended')).toHaveLength(2) // one cancel + one completion
  })

  it('provider errors show their own message; unexpected errors do not leak details', async () => {
    const a = setup()
    a.session.send('x')
    a.provider.fail(new ProviderError('Rate limited, try later.'))
    await flush()
    expect(a.snap().messages.at(-1)).toMatchObject({ role: 'notice', text: 'Rate limited, try later.', error: true })
    expect(a.events).toEqual(['submitted', 'ended'])

    const b = setup()
    b.session.send('x')
    b.provider.fail(new Error('ECONNRESET at 10.0.0.1:443 secret-token-abc'))
    await flush()
    const msg = b.snap().messages.at(-1)!
    expect(msg.error).toBe(true)
    expect(msg.text).not.toContain('secret-token')
    expect(msg.text).not.toContain('ECONNRESET')
  })

  it('a failure after the user cancelled adds nothing', async () => {
    const { provider, session, snap, events } = setup()
    session.send('x')
    session.cancel()
    provider.fail(new ProviderError('late failure'))
    await flush()
    expect(texts(snap())).toEqual(['user:x', 'notice:Cancelled.'])
    expect(events.filter((e) => e === 'ended')).toHaveLength(1)
  })

  it('can send again after an error and after a completed reply', async () => {
    const { provider, session, snap } = setup()
    session.send('1')
    provider.fail(new ProviderError('boom'))
    await flush()
    expect(session.send('2')).toBe('ok')
    provider.push('ok')
    provider.end()
    await flush()
    expect(texts(snap()).at(-1)).toBe('assistant:ok')
    expect(session.send('3')).toBe('ok')
  })

  it('an empty reply is reported, not silently dropped', async () => {
    const { provider, session, snap, events } = setup()
    session.send('x')
    provider.end()
    await flush()
    expect(snap().messages.at(-1)).toMatchObject({ role: 'notice' })
    expect(events).toEqual(['submitted', 'ended'])
  })

  it('the transcript is bounded', async () => {
    const { provider, session, snap } = setup({ maxMessages: 4 })
    for (let i = 0; i < 6; i++) {
      session.send(`q${i}`)
      provider.push(`a${i}`)
      provider.end()
      await flush()
      expect(snap().messages.length).toBeLessThanOrEqual(4)
    }
    expect(texts(snap())).toEqual(['user:q4', 'assistant:a4', 'user:q5', 'assistant:a5'])
  })

  it('clear() cancels and empties', async () => {
    const { session, snap } = setup()
    session.send('x')
    session.clear()
    expect(snap().messages).toEqual([])
    expect(session.busy).toBe(false)
  })
})

describe('ChatSession timeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gives up after timeoutMs: error notice, provider aborted, one "ended", later reply ignored', async () => {
    const { provider, session, snap, events } = setup({ timeoutMs: 5000 })
    session.send('x')
    await vi.advanceTimersByTimeAsync(4999)
    expect(session.busy).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(session.busy).toBe(false)
    expect(provider.signal?.aborted).toBe(true)
    expect(snap().messages.at(-1)).toMatchObject({ role: 'notice', error: true })
    provider.push('way too late')
    await vi.advanceTimersByTimeAsync(10)
    expect(snap().messages.some((m) => m.role === 'assistant')).toBe(false)
    expect(events).toEqual(['submitted', 'ended'])
  })

  it('the timeout is for silence, not total time: a long steady stream is never cut off', async () => {
    const { provider, session, snap, events } = setup({ timeoutMs: 5000 })
    session.send('x')
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(4000) // 40 s in total, but never 5 s without a chunk
      provider.push(`c${i} `)
    }
    provider.end()
    await vi.advanceTimersByTimeAsync(10)
    expect(snap().messages.at(-1)?.text.startsWith('c0 c1')).toBe(true)
    expect(snap().messages.some((m) => m.error)).toBe(false)
    expect(events).toEqual(['submitted', 'started', 'ended'])
  })

  it('a stream that stalls midway times out and keeps the partial text', async () => {
    const { provider, session, snap, events } = setup({ timeoutMs: 5000 })
    session.send('x')
    provider.push('partial ')
    await vi.advanceTimersByTimeAsync(4000)
    provider.push('more ')
    await vi.advanceTimersByTimeAsync(5001) // silence
    expect(session.busy).toBe(false)
    expect(snap().messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:x', 'assistant:partial more ', 'notice:No reply in time. You can try again.'])
    expect(events).toEqual(['submitted', 'started', 'ended'])
  })

  it('a reply that finishes in time clears the timer (no spurious timeout later)', async () => {
    const { provider, session, snap, events } = setup({ timeoutMs: 5000 })
    session.send('x')
    provider.push('done')
    provider.end()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(texts(snap())).toEqual(['user:x', 'assistant:done'])
    expect(events).toEqual(['submitted', 'started', 'ended'])
  })
})

describe('ChatSession outcomes and chunk hook (used by the voice output)', () => {
  function withHooks() {
    const provider = new Scripted()
    const outcomes: Array<Outcome | undefined> = []
    const chunks: string[] = []
    const session = new ChatSession(provider, {
      onChange: () => {},
      onEvent: (e, o) => e === 'ended' && outcomes.push(o),
      onChunk: (c) => chunks.push(c)
    })
    return { provider, session, outcomes, chunks }
  }

  it('reports completed / cancelled / failed, and every streamed chunk in order', async () => {
    const a = withHooks()
    a.session.send('x')
    a.provider.push('one ')
    a.provider.push('two')
    a.provider.end()
    await flush()
    expect(a.chunks).toEqual(['one ', 'two'])
    expect(a.outcomes).toEqual(['completed'])

    a.session.send('y')
    a.provider.push('three')
    await flush()
    a.session.cancel()
    expect(a.outcomes).toEqual(['completed', 'cancelled'])

    a.session.send('z')
    a.provider.fail(new ProviderError('nope'))
    await flush()
    expect(a.outcomes).toEqual(['completed', 'cancelled', 'failed'])
  })

  it('never delivers chunks from a cancelled request (so nothing stale is spoken)', async () => {
    const a = withHooks()
    a.session.send('x')
    const stale = a.provider.current
    a.session.cancel()
    stale.push('STALE')
    await flush()
    expect(a.chunks).toEqual([])
  })

  it('a timeout is reported as failed', async () => {
    vi.useFakeTimers()
    try {
      const provider = new Scripted()
      const outcomes: Array<Outcome | undefined> = []
      const session = new ChatSession(provider, { onChange: () => {}, onEvent: (e, o) => e === 'ended' && outcomes.push(o), timeoutMs: 1000 })
      session.send('x')
      await vi.advanceTimersByTimeAsync(1100)
      expect(outcomes).toEqual(['failed'])
    } finally {
      vi.useRealTimers()
    }
  })
})
