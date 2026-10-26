import { execFile } from 'node:child_process'
import { parseWindowSnapshot, type WindowSnapshot } from './rules'

/** Where the "what is on screen" data comes from. The real one runs a small Swift helper; tests pass a fake. */
export interface WindowSource {
  /** Frontmost app and visible windows, or null if it could not be read. Needs no permission. */
  snapshot(): Promise<WindowSnapshot | null>
  /** Is Screen Recording already granted? null = unknown. Never prompts. */
  screenCaptureGranted(): Promise<boolean | null>
}

const MAX_OUTPUT = 512 * 1024

function runHelper(path: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...extraEnv } }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(stdout.trim().split('\n')[0] ?? ''))
      } catch {
        resolve(null)
      }
    })
  })
}

export class SwiftWindows implements WindowSource {
  /** `env`: extra variables for the helper (tests only); it otherwise gets nothing but a bare PATH. */
  constructor(private readonly helperPath: string, private readonly env: Record<string, string> = {}) {}

  async snapshot(): Promise<WindowSnapshot | null> {
    return parseWindowSnapshot(await runHelper(this.helperPath, ['windows'], 4000, this.env))
  }

  async screenCaptureGranted(): Promise<boolean | null> {
    const r = (await runHelper(this.helperPath, ['preflight'], 4000, this.env)) as { screenCapture?: unknown } | null
    return typeof r?.screenCapture === 'boolean' ? r.screenCapture : null
  }
}

/** Where the app cannot list other apps' windows (anything but macOS): no snapshot, so window-aware features switch themselves off. */
export class NoWindows implements WindowSource {
  async snapshot(): Promise<WindowSnapshot | null> {
    return null
  }
  async screenCaptureGranted(): Promise<boolean | null> {
    return null
  }
}
