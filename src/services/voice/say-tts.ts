import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { TextToSpeech } from './types'

export interface SayOptions {
  /** Voice name, or "" for the system default. Validated by settings; passed as a single argv element, never via a shell. */
  voice: string
  /** Words per minute. */
  rate: number
  /** The `say` executable (or the system speech program on another OS). Overridable for tests. */
  bin?: string
  /** Put before the arguments, to run a script through an interpreter (`bin` = node, `binArgs` = [script]). Tests only. */
  binArgs?: string[]
  /** Arguments for the program; the text always goes in on stdin. Default: the macOS `say` ones. */
  args?: string[]
  /** Called with a short message if `say` cannot be started. */
  onError?: (message: string) => void
}

/** Longest single utterance handed to `say`. */
export const MAX_UTTERANCE_CHARS = 1200

/** Make model/user text safe and pleasant to read aloud. Returns "" if nothing speakable remains. */
export function speakable(text: string): string {
  return (
    text
      .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters (also newlines): `say` treats some as markup
      .replace(/`{1,3}[^`]*`{1,3}/g, ' ') // inline/fenced code is not worth reading out
      .replace(/https?:\/\/\S+/g, ' link ')
      .replace(/[*_#>~|\\[\]{}<]/g, ' ') // markdown/markup characters
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_UTTERANCE_CHARS)
  )
}

/**
 * macOS text-to-speech through the `say` command. One `say` process at a time; the text goes in on stdin
 * (`say -f -`), so it can never be interpreted as an option or a shell command. stop() kills the process.
 */
export class SayTts implements TextToSpeech {
  private queue: string[] = []
  private proc: ChildProcess | null = null
  private listeners: Array<(s: boolean) => void> = []
  private _speaking = false
  private generation = 0
  private readonly bin: string

  constructor(private readonly opts: SayOptions) {
    this.bin = opts.bin ?? '/usr/bin/say'
  }

  get speaking(): boolean {
    return this._speaking
  }
  get busy(): boolean {
    return this._speaking || this.queue.length > 0
  }
  onSpeakingChange(cb: (speaking: boolean) => void): void {
    this.listeners.push(cb)
  }

  speak(text: string): void {
    const t = speakable(text)
    if (!t) return
    this.queue.push(t)
    if (!this.proc) this.next(this.generation)
  }

  stop(): void {
    this.generation++ // anything still in flight from the old generation is ignored
    this.queue = []
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null && !p.killed) p.kill('SIGTERM')
    this.setSpeaking(false)
  }

  private next(gen: number): void {
    const text = this.queue.shift()
    if (text === undefined) {
      this.proc = null
      this.setSpeaking(false)
      return
    }
    const args = this.opts.args ?? ['-r', String(Math.round(this.opts.rate)), ...(this.opts.voice ? ['-v', this.opts.voice] : []), '-f', '-']
    let p: ChildProcess
    try {
      p = spawn(this.bin, [...(this.opts.binArgs ?? []), ...args], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch (e) {
      this.fail(`Could not start speech: ${(e as Error).message}`)
      return
    }
    this.proc = p
    this.setSpeaking(true)
    let err = ''
    p.stderr?.on('data', (d) => (err += String(d).slice(0, 500)))
    p.stdin?.on('error', () => {}) // EPIPE if the process is killed while we write
    p.stdin?.end(text)
    p.on('error', (e) => {
      if (gen === this.generation) this.fail(`Could not start speech: ${e.message}`)
    })
    p.on('exit', (code, signal) => {
      if (gen !== this.generation || this.proc !== p) return // stopped, or superseded
      if (signal === null && code !== 0) {
        this.fail(err.trim() ? `Speech failed: ${err.trim().split('\n')[0]}` : 'Speech failed.')
        return
      }
      this.next(gen)
    })
  }

  private fail(message: string): void {
    this.opts.onError?.(message)
    this.queue = []
    this.proc = null
    this.setSpeaking(false)
  }

  private setSpeaking(v: boolean): void {
    if (this._speaking === v) return
    this._speaking = v
    for (const cb of this.listeners) cb(v)
  }
}

// ---------- the system's own voice on each OS ----------

const onPath = (name: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  for (const d of (env['PATH'] ?? '').split(delimiter)) {
    if (!d) continue
    try {
      accessSync(join(d, name), constants.X_OK)
      return join(d, name)
    } catch {
      /* next */
    }
  }
  return null
}

/** PowerShell's single-quoted string: the only thing to escape is the quote itself. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** SAPI rate is -10 (slow) .. 10 (fast); 180 words per minute is the middle. */
export const sapiRate = (wpm: number): number => Math.max(-10, Math.min(10, Math.round((wpm - 180) / 18)))

export type SystemTtsKind = 'say' | 'sapi' | 'espeak' | 'spd-say' | 'none'

/** Which system speech program this OS has, and the arguments to drive it (the text is always sent on stdin, never in an argument). */
export function systemTtsPlan(platform: NodeJS.Platform, o: { voice: string; rate: number }, env: NodeJS.ProcessEnv = process.env): { kind: SystemTtsKind; bin: string; args: string[] } {
  if (platform === 'darwin') return { kind: 'say', bin: '/usr/bin/say', args: ['-r', String(Math.round(o.rate)), ...(o.voice ? ['-v', o.voice] : []), '-f', '-'] }
  if (platform === 'win32') {
    const script =
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      `$s.Rate = ${sapiRate(o.rate)}; ` +
      (o.voice ? `try { $s.SelectVoice(${psQuote(o.voice)}) } catch {}; ` : '') +
      '$s.Speak([Console]::In.ReadToEnd())'
    return { kind: 'sapi', bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  for (const name of ['espeak-ng', 'espeak']) {
    const bin = onPath(name, env)
    if (bin) return { kind: 'espeak', bin, args: ['-s', String(Math.round(o.rate)), ...(o.voice ? ['-v', o.voice] : []), '--stdin'] }
  }
  const spd = onPath('spd-say', env)
  if (spd) return { kind: 'spd-say', bin: spd, args: ['-w', '-e', ...(o.voice ? ['-y', o.voice] : [])] }
  return { kind: 'none', bin: '', args: [] }
}

/** The OS's own voice as a TextToSpeech: macOS `say`, Windows SAPI, or espeak-ng / speech-dispatcher on Linux. */
export function createSystemTts(o: { voice: string; rate: number; onError?: (m: string) => void; platform?: NodeJS.Platform; bin?: string }): SayTts {
  const plan = systemTtsPlan(o.platform ?? process.platform, o)
  if (plan.kind === 'none' && !o.bin) {
    return new SayTts({ voice: o.voice, rate: o.rate, bin: '/nonexistent/speech', onError: () => o.onError?.('No system voice was found. Install espeak-ng (for example: sudo apt install espeak-ng), or use the offline voices: npm run voices -- install --recommended') })
  }
  return new SayTts({ voice: o.voice, rate: o.rate, bin: o.bin ?? plan.bin, args: plan.args, ...(o.onError ? { onError: o.onError } : {}) })
}
