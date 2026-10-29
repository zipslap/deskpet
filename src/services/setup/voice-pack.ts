import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { VoicePack } from '../../shared/setup-types'
import { stopProcess } from '../ai/launch'

/**
 * Downloads the offline voices and speech recognition from inside the app, by running the same installer scripts as
 * `npm run voices` / `npm run speech` (tools/voices.mjs, tools/speech.mjs). The app's own executable runs them as plain Node
 * (ELECTRON_RUN_AS_NODE), so a downloaded copy of the app needs neither npm nor a source checkout. Python 3.9+ is still needed
 * by the voices themselves; the installer says so when it is missing.
 */

/** A few voices and English speech recognition (~450 MB), or the whole recommended collection (~2.3 GB). */
export const STARTER_VOICES = ['kokoro-int8-en-v0_19', 'piper-en_US-lessac-medium', 'piper-en_GB-alba-medium']

/** The scripts to run, in order, with their arguments. */
export function packSteps(pack: VoicePack): string[][] {
  return [
    ['voices.mjs', 'setup'],
    ['voices.mjs', 'install', ...(pack === 'recommended' ? ['--recommended'] : STARTER_VOICES)],
    ['speech.mjs', 'install', 'stt-en']
  ]
}

const MARK = '.deskpet-model.json'
/** How many model folders under `dir` are fully installed (the installer writes the marker last). */
export function countInstalled(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => existsSync(join(dir, n, MARK))).length
  } catch {
    return 0
  }
}

export interface PackRun {
  /** Where tools/*.mjs are. */
  toolsDir: string
  /** The program that runs them as Node: the app's own executable. */
  execPath: string
  /** The app's data folder, handed on so the installer and the app agree where models live. */
  dataDir: string
  env?: NodeJS.ProcessEnv
  /** Called with the recent output lines whenever they change (at most a few times a second). */
  onLog: (lines: string[]) => void
  spawnFn?: typeof spawn
}

export interface PackResult {
  ok: boolean
  /** Why it stopped, in words for the person (the last thing the installer said). */
  reason: string
}

/** One download at a time; `cancel()` stops it and everything it started. */
export class VoicePackRunner {
  private child: ChildProcess | null = null
  private cancelled = false
  running = false

  async run(pack: VoicePack, o: PackRun): Promise<PackResult> {
    if (this.running) return { ok: false, reason: 'A download is already running.' }
    this.running = true
    this.cancelled = false
    const lines: string[] = []
    let timer: NodeJS.Timeout | null = null
    const flush = (): void => {
      timer = null
      o.onLog([...lines])
    }
    const push = (chunk: string): void => {
      // the installers redraw a percentage with \r, so every \r-separated piece is a line, and only the latest of a run is worth showing
      for (const piece of chunk.split(/\r\n|\n|\r/)) {
        const t = piece.trim()
        if (!t) continue
        if (/^\S.*: \d+%$/.test(t) && /^\S.*: \d+%$/.test(lines[lines.length - 1] ?? '')) lines.pop()
        lines.push(t.slice(0, 300))
        if (lines.length > 12) lines.shift()
      }
      timer ??= setTimeout(flush, 250)
    }
    try {
      for (const step of packSteps(pack)) {
        const [script, ...args] = step
        const code = await this.runStep(o, join(o.toolsDir, script!), args, push)
        if (this.cancelled) return { ok: false, reason: 'Cancelled.' }
        if (code !== 0) return { ok: false, reason: [...lines].reverse().find((l) => !/^\S.*: \d+%$/.test(l)) ?? `The installer stopped (exit code ${code}).` }
      }
      return { ok: true, reason: 'Done.' }
    } finally {
      this.running = false
      this.child = null
      if (timer) clearTimeout(timer)
      flush()
    }
  }

  private runStep(o: PackRun, script: string, args: string[], push: (s: string) => void): Promise<number> {
    return new Promise((resolve) => {
      const env = { ...(o.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', DESKPET_DATA_DIR: o.dataDir }
      let child: ChildProcess
      try {
        child = (o.spawnFn ?? spawn)(o.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (e) {
        push(`Could not start the installer: ${(e as Error).message}`)
        return resolve(1)
      }
      this.child = child
      child.stdout?.setEncoding('utf8').on('data', push)
      child.stderr?.setEncoding('utf8').on('data', push)
      child.once('error', (e) => {
        push(`Could not start the installer: ${e.message}`)
        resolve(1)
      })
      child.once('close', (code) => resolve(code ?? 1))
    })
  }

  cancel(): void {
    this.cancelled = true
    if (this.child) stopProcess(this.child)
  }
}
