import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandProvider, fillArgs, type CommandProviderOptions } from '../src/services/ai/command-provider'
import { ProviderError } from '../src/services/ai/provider'

const FAKE = resolve(__dirname, '../tools/fake-command.mjs')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deskpet-cmd-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const make = (over: Partial<CommandProviderOptions> = {}, mode = 'echo'): CommandProvider =>
  new CommandProvider({
    command: process.execPath,
    args: [FAKE, '--model', '{model}'],
    model: () => 'm-1',
    systemPrompt: () => 'You are DeskPet.',
    workdir: join(dir, 'work'),
    env: { ...process.env, FAKE_CMD_MODE: mode },
    ...over
  })
const collect = async (p: CommandProvider, msg = 'hello', ctx?: Parameters<CommandProvider['sendMessage']>[1], signal?: AbortSignal): Promise<string> => {
  let out = ''
  for await (const c of p.sendMessage(msg, ctx, signal)) out += c
  return out
}

describe('fillArgs', () => {
  it('replaces {model} and {prompt} inside arguments and reports whether the prompt travels as an argument', () => {
    expect(fillArgs(['-p', '{prompt}', '--model={model}'], 'gemini-x', 'hello world')).toEqual({ args: ['-p', 'hello world', '--model=gemini-x'], promptInArgs: true })
    expect(fillArgs(['--model', '{model}'], 'm', 'p')).toEqual({ args: ['--model', 'm'], promptInArgs: false })
  })
  it('does no shell interpretation: metacharacters in the prompt stay literal', () => {
    expect(fillArgs(['{prompt}'], 'm', '$(rm -rf /); `x` | y').args).toEqual(['$(rm -rf /); `x` | y'])
  })
})

describe('CommandProvider', () => {
  it('sends the system prompt and the conversation on stdin and returns stdout', async () => {
    const out = await collect(make(), 'what now?', { history: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'reply' }] })
    expect(out).toContain('model=m-1;')
    expect(out).toContain('has-system=true;')
    expect(out).toMatch(/last=Reply to the new message, as yourself\.$/)
  })
  it('can pass the prompt as an argument instead', async () => {
    const out = await collect(make({ args: [FAKE, '--prompt', '{prompt}'] }), 'ARGMODE')
    expect(out).toContain('has-system=true;')
    expect(out).toContain('ARGMODE')
  })
  it('turns a failing command into a readable error that includes its stderr', async () => {
    const err = await collect(make({}, 'fail')).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).toMatch(/failed \(exit 3\).*quota exceeded/)
  })
  it('a command that prints nothing is an error', async () => {
    await expect(collect(make({}, 'silent'))).rejects.toThrow(/without replying/)
  })
  it('cuts off a runaway reply', async () => {
    await expect(collect(make({ maxReplyChars: 100 }, 'long'))).rejects.toThrow(/too long/)
  })
  it('says which command is missing', async () => {
    await expect(collect(make({ command: 'definitely-not-installed-xyz' }))).rejects.toThrow(/Couldn't find the "definitely-not-installed-xyz" command/)
  })
  it("refuses to attach a screenshot (it has no way to carry an image)", async () => {
    await expect(collect(make(), 'look', { screenshotBase64: 'QUJD' })).rejects.toThrow(/can't look at pictures/)
  })
  it('stops the process when aborted', async () => {
    const ac = new AbortController()
    const p = make({}, 'slow')
    const run = (async () => {
      for await (const _c of p.sendMessage('hi', undefined, ac.signal)) ac.abort()
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
})
