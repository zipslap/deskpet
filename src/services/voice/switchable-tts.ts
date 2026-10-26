import type { TextToSpeech } from './types'

/** An engine that can also be shut down (the local voice runs a helper process). */
export type DisposableTts = TextToSpeech & { dispose?(): void }

/**
 * Lets the voice be changed while the app runs: everything the pet and the voice controller know is this one object,
 * and `use()` swaps the engine behind it. The old engine is silenced and shut down first, so two voices never overlap.
 */
export class SwitchableTts implements TextToSpeech {
  private listeners: Array<(s: boolean) => void> = []

  constructor(private inner: DisposableTts) {
    this.attach(inner)
  }

  get current(): DisposableTts {
    return this.inner
  }
  get speaking(): boolean {
    return this.inner.speaking
  }
  get busy(): boolean {
    return this.inner.busy ?? this.inner.speaking
  }
  speak(text: string): void {
    this.inner.speak(text)
  }
  stop(): void {
    this.inner.stop()
  }
  onSpeakingChange(cb: (speaking: boolean) => void): void {
    this.listeners.push(cb)
  }
  dispose(): void {
    this.inner.dispose?.()
  }

  use(next: DisposableTts): void {
    const old = this.inner
    const wasSpeaking = old.speaking
    old.stop()
    old.dispose?.()
    this.inner = next
    this.attach(next)
    if (wasSpeaking) for (const cb of this.listeners) cb(false)
  }

  private attach(engine: DisposableTts): void {
    engine.onSpeakingChange((s) => {
      if (engine === this.inner) for (const cb of this.listeners) cb(s)
    })
  }
}
