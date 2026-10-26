import { spawn, type ChildProcess } from 'node:child_process'
import { speakable } from './say-tts'
import type { TextToSpeech } from './types'

export interface LocalTtsOptions {
  /** Python with sherpa-onnx installed. */
  python: string
  /** native/tts/tts_server.py */
  script: string
  /** Which engine config the model folder needs. */
  family: 'kokoro' | 'vits'
  /** The installed voice model's folder. */
  modelDir: string
  /** Speaker id inside that model (0 for single-speaker voices). */
  sid: number
  /** Played-back speed-up that raises pitch and formants together (1 = the voice as recorded). */
  pitch: number
  /** Speaking speed (after the pitch change). */
  speed: number
  /** Called with a short message if the voice cannot start or fails. */
  onError?: (message: string) => void
}

/**
 * A local neural voice (Kokoro or Piper models, run by sherpa-onnx) behind a small Python server that synthesises the next sentence
 * while the current one plays. Nothing leaves the Mac. The server is started on first use and kept running; stop() silences it immediately.
 */
export class LocalTts implements TextToSpeech {
  private proc: ChildProcess | null = null
  private ready = false
  private pending: string[] = []
  private listeners: Array<(s: boolean) => void> = []
  private _speaking = false
  /** Id of the last sentence sent, and the newest one the server has reported fully done with (played, dropped or failed). */
  private sentId = 0
  private doneId = 0
  private failed = false

  constructor(private readonly opts: LocalTtsOptions) {}

  get speaking(): boolean {
    return this._speaking
  }
  /** Speaking, or about to: something sent has not finished playing yet. */
  get busy(): boolean {
    return this.sentId > this.doneId
  }
  onSpeakingChange(cb: (speaking: boolean) => void): void {
    this.listeners.push(cb)
  }

  /** Start the server ahead of time, so the first reply is not delayed by loading the model (~1 s). */
  warmUp(): void {
    this.ensure()
  }

  speak(text: string): void {
    const t = speakable(text)
    if (!t) return
    if (!this.ensure()) return
    if (this.ready) this.send({ cmd: 'speak', text: t, id: ++this.sentId })
    else this.pending.push(t)
  }

  stop(): void {
    this.pending = []
    this.doneId = this.sentId
    if (this.proc && this.ready) this.send({ cmd: 'stop' })
    this.setSpeaking(false)
  }

  dispose(): void {
    this.stop()
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null) {
      this.send({ cmd: 'quit' }, p)
      setTimeout(() => p.exitCode === null && p.kill('SIGTERM'), 500)
    }
  }

  private ensure(): boolean {
    if (this.proc) return true
    if (this.failed) return false
    const o = this.opts
    let p: ChildProcess
    try {
      p = spawn(o.python, [o.script, '--family', o.family, '--model', o.modelDir, '--sid', String(o.sid), '--pitch', String(o.pitch), '--speed', String(o.speed)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env, windowsHide: true
      })
    } catch (e) {
      this.fail(`Could not start the local voice: ${(e as Error).message}`)
      return false
    }
    this.proc = p
    this.ready = false
    let buf = ''
    let err = ''
    p.stdout?.setEncoding('utf8')
    p.stdout?.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        this.onEvent(line)
      }
    })
    p.stderr?.on('data', (d) => (err = (err + String(d)).slice(-2000)))
    p.stdin?.on('error', () => {})
    p.on('error', (e) => this.fail(`Could not start the local voice: ${e.message}`))
    p.on('exit', (code) => {
      if (this.proc !== p) return
      this.proc = null
      this.ready = false
      this.doneId = this.sentId
      this.setSpeaking(false)
      if (code !== 0 && code !== null) {
        const last = err.trim().split('\n').filter((l) => !/warn/i.test(l)).pop()
        this.fail(`The local voice stopped${last ? `: ${last.slice(0, 200)}` : '.'}`)
      }
    })
    return true
  }

  private onEvent(line: string): void {
    let ev: { event?: unknown; message?: unknown }
    try {
      ev = JSON.parse(line) as typeof ev
    } catch {
      return
    }
    if (ev.event === 'ready') {
      this.ready = true
      for (const t of this.pending.splice(0)) this.send({ cmd: 'speak', text: t, id: ++this.sentId })
    } else if (ev.event === 'start') {
      if (this.busy) this.setSpeaking(true)
    } else if (ev.event === 'idle') {
      const last = (ev as { last?: unknown }).last
      if (typeof last === 'number') this.doneId = Math.max(this.doneId, last)
      if (!this.busy) this.setSpeaking(false)
    } else if (ev.event === 'error' && typeof ev.message === 'string') {
      this.opts.onError?.(ev.message.slice(0, 300))
    }
  }

  private send(msg: object, p: ChildProcess | null = this.proc): void {
    if (p?.stdin?.writable) p.stdin.write(JSON.stringify(msg) + '\n')
  }

  private fail(message: string): void {
    this.failed = true
    this.pending = []
    this.doneId = this.sentId
    this.setSpeaking(false)
    this.opts.onError?.(message)
  }

  private setSpeaking(v: boolean): void {
    if (this._speaking === v) return
    this._speaking = v
    for (const cb of this.listeners) cb(v)
  }
}
