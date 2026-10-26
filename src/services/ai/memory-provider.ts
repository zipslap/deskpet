import { RememberFilter, saveMemory, type MemoryEntry } from '../memory/memory-store'
import type { AssistantContext, ChatProvider } from './provider'

export interface MemoryProviderOptions {
  /** Where the memory files live. */
  dir: string
  /** Called after each memory block: the saved entry, or null if the block was malformed and ignored. */
  onSaved?: (entry: MemoryEntry | null, file: string | null, why?: 'locked' | 'invalid' | 'failed') => void
  /** For tests. */
  save?: (dir: string, entry: MemoryEntry) => string
}

/**
 * Wraps a provider so `<remember …>…</remember>` blocks in its reply are removed from the text (never shown or
 * spoken) and written to the memory folder. A reply that is cancelled or fails part-way saves nothing it had
 * not already completed: only whole, valid blocks are written.
 */
export class MemoryProvider implements ChatProvider {
  constructor(
    private readonly inner: ChatProvider & { dispose?(): void },
    private readonly opts: MemoryProviderOptions
  ) {}

  dispose(): void {
    this.inner.dispose?.()
  }

  async *sendMessage(message: string, context?: AssistantContext, signal?: AbortSignal): AsyncIterable<string> {
    const save = this.opts.save ?? saveMemory
    // A screenshot can contain text written to manipulate the model (a web page, an email): while one is attached the
    // reply is still cleaned of memory blocks, but nothing is written.
    const locked = Boolean(context?.screenshotBase64)
    const filter = new RememberFilter((entry) => {
      if (locked) return this.opts.onSaved?.(null, null, 'locked')
      if (!entry) return this.opts.onSaved?.(null, null, 'invalid')
      let file: string | null = null
      try {
        file = save(this.opts.dir, entry)
      } catch {
        file = null
      }
      this.opts.onSaved?.(file ? entry : null, file, file ? undefined : 'failed')
    })
    for await (const chunk of this.inner.sendMessage(message, context, signal)) {
      const safe = filter.push(chunk)
      if (safe) yield safe
    }
    const rest = filter.flush()
    if (rest) yield rest
  }
}
