import { ProviderError, type AssistantContext, type ChatProvider } from './provider'

export interface MockOptions {
  /** Delay before the first word (the "thinking" phase). */
  thinkMs?: number
  /** Delay between streamed words. */
  wordMs?: number
}

const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' })

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Canned replies for developing the interaction shell without any network. Special messages exercise the
 * awkward paths:  /slow (10 s before the first word)  /hang (never answers)  /fail (provider error)
 * /long (a long streamed reply)  /midfail (starts, then fails)
 */
export class MockProvider implements ChatProvider {
  constructor(private readonly opts: MockOptions = {}) {}

  async *sendMessage(message: string, _context?: AssistantContext, signal?: AbortSignal): AsyncIterable<string> {
    const thinkMs = this.opts.thinkMs ?? 900
    const wordMs = this.opts.wordMs ?? 70
    const cmd = message.trim().toLowerCase()

    if (cmd === '/hang') {
      await sleep(24 * 3600 * 1000, signal)
      return
    }
    await sleep(cmd === '/slow' ? 10_000 : thinkMs, signal)
    if (cmd === '/fail') throw new ProviderError('Mock provider failure (you asked for /fail).')

    const text =
      cmd === '/long'
        ? Array.from({ length: 120 }, (_, i) => `word${i + 1}`).join(' ')
        : cmd === '/midfail'
          ? 'Here is the start of an answer that will'
          : `Mock reply: you said "${message.trim().slice(0, 200)}". Open Set up (the plug button in the chat header) to connect a real AI.`

    for (const word of text.split(' ')) {
      yield word + ' '
      await sleep(wordMs, signal)
    }
    if (cmd === '/midfail') throw new ProviderError('Mock provider failed mid-reply (you asked for /midfail).')
  }
}
