import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SpeechToText, SttEndReason, SttError, SttErrorCode, SttHandlers, SttSession, SttStartOptions, SttStatus } from './types'

/** A line from the helper, validated. Anything else is dropped: the helper's output is treated as untrusted input. */
export type HelperMessage =
  | { type: 'state'; state: string }
  | { type: 'level'; level: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: SttErrorCode; message: string }
  | { type: 'ended'; reason: SttEndReason }
  | { type: 'status'; status: Omit<SttStatus, 'installed'> }

const MAX_TEXT = 4000
const CODES: readonly SttErrorCode[] = ['not-installed', 'mic-denied', 'speech-denied', 'unavailable', 'on-device-unavailable', 'no-input', 'failed']
const REASONS: readonly SttEndReason[] = ['stopped', 'silence', 'timeout', 'no-speech', 'cancelled', 'error']
const AUTH = ['authorized', 'denied', 'restricted', 'notDetermined']
const auth = (v: unknown): SttStatus['mic'] => (typeof v === 'string' && AUTH.includes(v) ? (v as SttStatus['mic']) : 'unknown')

export function parseHelperLine(line: string): HelperMessage | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  switch (o['type']) {
    case 'state':
      return typeof o['state'] === 'string' ? { type: 'state', state: o['state'].slice(0, 40) } : null
    case 'level':
      return typeof o['level'] === 'number' && Number.isFinite(o['level']) ? { type: 'level', level: Math.min(1, Math.max(0, o['level'])) } : null
    case 'partial':
    case 'final':
      return typeof o['text'] === 'string' ? { type: o['type'], text: o['text'].slice(0, MAX_TEXT) } : null
    case 'error': {
      const code = (CODES as readonly unknown[]).includes(o['code']) ? (o['code'] as SttErrorCode) : 'failed'
      const message = typeof o['message'] === 'string' ? o['message'].slice(0, 300) : 'Speech recognition failed.'
      return { type: 'error', code, message }
    }
    case 'ended':
      return (REASONS as readonly unknown[]).includes(o['reason']) ? { type: 'ended', reason: o['reason'] as SttEndReason } : { type: 'ended', reason: 'error' }
    case 'status':
      return {
        type: 'status',
        status: { mic: auth(o['mic']), speech: auth(o['speech']), onDevice: o['onDevice'] === true }
      }
    default:
      return null
  }
}

export interface HelperSttOptions {
  /** The helper program: the compiled macOS helper (native/speech-helper), or Python running native/stt/stt_server.py. */
  helperPath: string
  /** Extra leading argv, e.g. a script path when the "helper" is `node fake.mjs` in tests. */
  helperArgs?: string[]
  /** An extra check that the helper has what it needs (e.g. its speech model is installed). */
  ready?: () => boolean
  /** Shown when the helper is not available. */
  notInstalledMessage?: string
  /** How long to wait after asking the helper to stop before killing it. */
  killAfterMs?: number
}

/**
 * Speech-to-text through a helper program that owns the microphone: the Swift helper on macOS (Apple's on-device recogniser), or
 * the Python/sherpa-onnx one everywhere (offline models). Both speak the same JSON-lines protocol. The helper is a separate process:
 * when it exits, the microphone is closed, and it exits by itself if this process dies.
 */
export class HelperStt implements SpeechToText {
  constructor(private readonly opts: HelperSttOptions) {}

  private get installed(): boolean {
    return existsSync(this.opts.helperPath) && (this.opts.ready?.() ?? true)
  }

  status(locale: string): Promise<SttStatus> {
    if (!this.installed) {
      return Promise.resolve({ installed: false, mic: 'unknown', speech: 'unknown', onDevice: false, detail: this.opts.notInstalledMessage ?? 'speech helper not built' })
    }
    return new Promise((resolve) => {
      const unknown: SttStatus = { installed: true, mic: 'unknown', speech: 'unknown', onDevice: false }
      let out = ''
      let settled = false
      const done = (s: SttStatus): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(s)
      }
      const p = spawn(this.opts.helperPath, [...(this.opts.helperArgs ?? []), 'status', '--locale', locale], { stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        p.kill('SIGKILL')
        done({ ...unknown, detail: 'status check timed out' })
      }, 4000)
      p.stdout.on('data', (d) => (out += d))
      p.on('error', (e) => done({ ...unknown, installed: false, detail: e.message }))
      p.on('exit', () => {
        for (const line of out.split('\n')) {
          const m = parseHelperLine(line)
          if (m?.type === 'status') return done({ installed: true, ...m.status })
        }
        done({ ...unknown, detail: 'no status from helper' })
      })
    })
  }

  start(o: SttStartOptions, h: SttHandlers): SttSession {
    let ended = false
    let cancelled = false
    let sawEnded = false
    let finalText = ''
    let sawError = false
    let proc: ChildProcess | null = null
    let killTimer: NodeJS.Timeout | null = null

    /** Exactly one onEnded, ever, whatever the helper does. */
    const finish = (reason: SttEndReason): void => {
      if (ended) return
      ended = true
      if (killTimer) clearTimeout(killTimer)
      h.onEnded(cancelled ? 'cancelled' : reason)
    }
    const fail = (error: SttError): void => {
      if (ended || cancelled) return
      sawError = true
      h.onError(error)
    }

    if (!this.installed) {
      queueMicrotask(() => {
        fail({ code: 'not-installed', message: this.opts.notInstalledMessage ?? 'The speech helper is not built. Run `npm run helper` (needs the Xcode command-line tools).' })
        finish('error')
      })
      return { stop: () => {}, cancel: () => {} }
    }

    const args = [
      ...(this.opts.helperArgs ?? []),
      'listen',
      '--locale', o.locale,
      '--max-seconds', String(o.maxSeconds),
      '--silence-ms', String(o.silenceMs),
      ...(o.allowServerRecognition ? ['--allow-server'] : [])
    ]
    try {
      proc = spawn(this.opts.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      queueMicrotask(() => {
        fail({ code: 'failed', message: `Could not start the speech helper: ${(e as Error).message}` })
        finish('error')
      })
      return { stop: () => {}, cancel: () => {} }
    }
    const p = proc
    p.stdin?.on('error', () => {}) // the helper may already be gone
    let buf = ''
    let stderr = ''
    p.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-400)))
    p.stdout?.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        const m = parseHelperLine(line)
        if (!m || ended || cancelled) continue
        switch (m.type) {
          case 'state':
            if (m.state === 'listening') h.onListening()
            break
          case 'level':
            h.onLevel(m.level)
            break
          case 'partial':
            h.onPartial(m.text)
            break
          case 'final':
            finalText = m.text
            h.onFinal(m.text)
            break
          case 'error':
            fail({ code: m.code, message: m.message })
            break
          case 'ended':
            sawEnded = true
            finish(m.reason)
            break
          default:
            break
        }
      }
    })
    p.on('error', (e) => {
      fail({ code: 'failed', message: `Could not start the speech helper: ${e.message}` })
      finish('error')
    })
    p.on('exit', (code, signal) => {
      if (!sawEnded && !ended) {
        // The helper vanished without saying goodbye: crash, kill, or a bad build. Report it, never hang.
        if (!cancelled && !sawError) {
          const hint = stderr.trim().split('\n').pop() ?? ''
          fail({ code: 'failed', message: `The speech helper stopped unexpectedly (${signal ?? `exit ${code}`}).${hint ? ' ' + hint : ''}` })
        }
        finish(finalText ? 'stopped' : 'error')
      }
    })

    const send = (cmd: 'stop' | 'cancel'): void => {
      if (ended || !p.stdin?.writable) return
      p.stdin.write(cmd + '\n')
      // Belt and braces: a helper that ignores us is killed, which closes the microphone.
      killTimer ??= setTimeout(() => p.kill('SIGKILL'), this.opts.killAfterMs ?? 5000)
    }
    return {
      stop: () => send('stop'),
      cancel: () => {
        cancelled = true
        send('cancel')
        setTimeout(() => !ended && p.kill('SIGTERM'), 800)
      }
    }
  }
}
