/**
 * Cuts a streamed reply into speakable sentences as the text arrives, so speech can start before the reply is complete.
 * A sentence ends at . ! ? … (followed by whitespace) or a newline. Very long runs without punctuation are cut at a
 * space once they pass `maxChars` so the voice never waits forever.
 */
export class SentenceSplitter {
  private buf = ''
  constructor(private readonly maxChars = 220) {}

  /** Feed a chunk; returns the sentences that are now complete. */
  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    for (;;) {
      const m = /[.!?…]+["')\]]*(\s+)|\n+/.exec(this.buf)
      if (m) {
        const end = m.index + m[0].length
        const sentence = this.buf.slice(0, end).trim()
        this.buf = this.buf.slice(end)
        if (sentence) out.push(sentence)
        continue
      }
      if (this.buf.length > this.maxChars) {
        const cut = this.buf.lastIndexOf(' ', this.maxChars)
        const at = cut > 40 ? cut : this.maxChars
        const piece = this.buf.slice(0, at).trim()
        this.buf = this.buf.slice(at)
        if (piece) out.push(piece)
        continue
      }
      return out
    }
  }

  /** The reply is complete: whatever is left is the last sentence. */
  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ''
    return rest ? [rest] : []
  }

  reset(): void {
    this.buf = ''
  }
}
