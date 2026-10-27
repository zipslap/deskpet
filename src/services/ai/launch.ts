import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { extname, isAbsolute, join, win32 } from 'node:path'
import { homedir } from 'node:os'

/**
 * Finding and starting an external command the same way on every OS.
 *
 * Windows differs in three ways that matter here: there are no executable bits (a file runs because of its extension,
 * listed in PATHEXT), a bare `claude` is really `claude.exe` or npm's `claude.cmd`, and a `.cmd` file cannot be started
 * directly by Node (it must go through cmd.exe) and cmd.exe does not stop the programs it started when it is killed.
 */

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** Extensions Windows will run, lower case, `.exe` before `.cmd` so a real binary wins over a shim. */
function winExtensions(env: NodeJS.ProcessEnv): string[] {
  const exts = (env['PATHEXT'] ?? DEFAULT_PATHEXT).split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return [...exts].sort((a, b) => Number(b === '.exe') - Number(a === '.exe'))
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** True if `path` can be started: executable bit on macOS/Linux, a runnable extension on Windows. */
export function isExecutable(path: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return isFile(path) && winExtensions(env).includes(extname(path).toLowerCase())
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Where to look for a command: the given absolute path, else PATH plus the usual install folders (a GUI launch has a short PATH). */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === 'win32'
  // (on Windows `claude` may be written with or without its extension)
  const withExt = (p: string): string[] => (win && !winExtensions(env).includes(extname(p).toLowerCase()) ? winExtensions(env).map((e) => p + e) : [p])
  const first = (p: string): string | null => withExt(p).find((c) => isExecutable(c, env, platform)) ?? null
  if (isAbsolute(command) || (win && win32.isAbsolute(command))) return first(command)
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir()
  const extra = win
    ? [join(home, '.local', 'bin'), join(home, '.claude', 'local'), env['APPDATA'] ? join(env['APPDATA'], 'npm') : '']
    : [join(home, '.local/bin'), join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin']
  const dirs = [...(env['PATH'] ?? env['Path'] ?? '').split(win ? ';' : ':'), ...extra]
  for (const d of dirs) {
    const hit = d ? first(join(d, command)) : null
    if (hit) return hit
  }
  return null
}

export interface LaunchPlan {
  file: string
  args: string[]
  /** Windows only: the argument string is already quoted for cmd.exe. */
  verbatim: boolean
}

/** cmd.exe has no way to escape these inside quotes, so an argument holding one is refused instead of risking a command injection. */
const CMD_UNSAFE = /["%\r\n\0]/

/**
 * What to actually run for `bin` with `args`. Everything but a Windows `.cmd`/`.bat` is run as it is; those go through
 * `cmd.exe /d /s /c "<quoted>"`, and any argument that cannot be quoted safely makes this throw.
 */
export function launchPlan(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LaunchPlan {
  const ext = extname(bin).toLowerCase()
  if (platform !== 'win32' || (ext !== '.cmd' && ext !== '.bat')) return { file: bin, args, verbatim: false }
  const quote = (a: string): string => {
    if (CMD_UNSAFE.test(a)) throw new Error('This argument cannot be passed through a .cmd launcher safely.')
    return `"${a}"`
  }
  return { file: env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[bin, ...args].map(quote).join(' ')}"`], verbatim: true }
}

type SpawnOptions = Parameters<typeof spawn>[2]

/** Start a command (resolved by resolveCommand) the right way for this OS. */
export function launch(bin: string, args: string[], options: SpawnOptions & { env: NodeJS.ProcessEnv }): ChildProcess {
  const plan = launchPlan(bin, args, options.env)
  return spawn(plan.file, plan.args, { ...options, windowsHide: true, ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}) })
}

/** Stop a process: a signal on macOS/Linux; on Windows the whole tree (a .cmd shim leaves its child running otherwise). */
export function stopProcess(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => proc.kill())
      return
    } catch {
      // fall through to a plain kill
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // already gone
  }
}
