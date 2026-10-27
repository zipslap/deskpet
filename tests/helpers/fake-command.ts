import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A command that starts one of the fake programs in tools/ (they are Node scripts).
 * macOS/Linux run the script directly through its shebang line. Windows cannot, so it gets a `.cmd` launcher beside it
 * in `dir`, which is also how an npm-installed `claude` looks there.
 */
export function fakeCommand(script: string, dir: string, name = 'fake-command'): string {
  if (process.platform !== 'win32') return script
  mkdirSync(dir, { recursive: true })
  const launcher = join(dir, `${name}.cmd`)
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  chmodSync(launcher, 0o755)
  return launcher
}
