import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launchPlan, resolveCommand } from '../src/services/ai/launch'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'pet-launch-test-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('launchPlan', () => {
  it('runs everything but a Windows .cmd/.bat as it is', () => {
    expect(launchPlan('/usr/bin/claude', ['-p'], {}, 'darwin')).toEqual({ file: '/usr/bin/claude', args: ['-p'], verbatim: false })
    expect(launchPlan('C:\\bin\\claude.exe', ['-p'], {}, 'win32')).toEqual({ file: 'C:\\bin\\claude.exe', args: ['-p'], verbatim: false })
    expect(launchPlan('/tmp/x.cmd', ['-p'], {}, 'linux').verbatim).toBe(false)
  })
  it('sends a Windows .cmd through cmd.exe, every part quoted', () => {
    const p = launchPlan('C:\\Users\\A B\\claude.cmd', ['-p', '--model', 'haiku', '--tools', ''], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32')
    expect(p.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(p.args).toEqual(['/d', '/s', '/c', '""C:\\Users\\A B\\claude.cmd" "-p" "--model" "haiku" "--tools" """'])
    expect(p.verbatim).toBe(true)
    expect(launchPlan('C:\\x\\a.BAT', [], {}, 'win32').file).toBe('cmd.exe')
  })
  it('refuses an argument cmd.exe cannot carry safely', () => {
    for (const bad of ['a"b', '%PATH%', 'a\nb', '{"mcpServers":{}}']) expect(() => launchPlan('C:\\x\\a.cmd', [bad], {}, 'win32')).toThrow(/safely/)
    expect(() => launchPlan('C:\\x\\a.cmd', ['a & b', 'x|y', '^z', '!w!'], {}, 'win32')).not.toThrow() // (literal inside quotes)
  })
})

describe('resolveCommand on Windows rules', () => {
  const touch = (name: string): string => {
    const f = join(dir, name)
    writeFileSync(f, 'x')
    chmodSync(f, 0o644) // (no executable bit: only the extension counts)
    return f
  }
  it('finds claude.cmd for a bare "claude" and prefers a real .exe over a shim', () => {
    const cmd = touch('claude.cmd')
    expect(resolveCommand('claude', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(cmd)
    const exe = touch('claude.exe')
    expect(resolveCommand('claude', { PATH: dir, PATHEXT: '.CMD;.EXE' }, 'win32')).toBe(exe)
  })
  it('ignores files without a runnable extension, and finds the npm folder', () => {
    touch('claude.txt')
    touch('claude')
    expect(resolveCommand('claude', { PATH: dir }, 'win32')).toBeNull()
    mkdirSync(join(dir, 'npm'))
    writeFileSync(join(dir, 'npm', 'claude.cmd'), 'x')
    expect(resolveCommand('claude', { PATH: '', APPDATA: dir }, 'win32')).toBe(join(dir, 'npm', 'claude.cmd'))
  })
  it('accepts an absolute path with or without its extension', () => {
    const cmd = touch('tool.cmd')
    expect(resolveCommand(join(dir, 'tool'), {}, 'win32')).toBe(cmd)
    expect(resolveCommand(cmd, {}, 'win32')).toBe(cmd)
  })
})

// Windows only: a .cmd shim starts the real program as a child of cmd.exe, and stopping cmd.exe alone would leave that program running.
describe.runIf(process.platform === 'win32')('a .cmd launcher on Windows', () => {
  it('runs through cmd.exe and stopProcess ends the whole tree', async () => {
    const { launch, stopProcess } = await import('../src/services/ai/launch')
    const pidFile = join(dir, 'child.pid')
    const script = join(dir, 'sleeper.mjs')
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const cmd = join(dir, 'sleeper.cmd')
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    const proc = launch(cmd, ['--model', 'haiku', ''], { cwd: dir, env: process.env, stdio: 'ignore' })
    const { existsSync, readFileSync } = await import('node:fs')
    const until = async (f: () => boolean, ms = 8000): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (f()) return true
      return false
    }
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    const alive = (): boolean => {
      try { process.kill(childPid, 0); return true } catch { return false }
    }
    expect(alive()).toBe(true)
    stopProcess(proc)
    expect(await until(() => !alive(), 5000)).toBe(true)
  })
})
