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
