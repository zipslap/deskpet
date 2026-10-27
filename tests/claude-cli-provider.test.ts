import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildArgs,
  buildEnv,
  classifyError,
  ClaudeCliProvider,
  initProblem,
  parseStreamLine,
  resolveCommand,
  type ClaudeCliOptions
} from '../src/services/ai/claude-cli-provider'
import { buildSystemPrompt, renderPrompt } from '../src/services/ai/prompt'
import { ProviderError } from '../src/services/ai/provider'
import { fakeCommand } from './helpers/fake-command'

const FAKE_SCRIPT = resolve(__dirname, '../tools/fake-claude.mjs')
let dir: string
let FAKE: string // (on Windows a .cmd launcher beside the fake, like an npm-installed claude)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pet-claude-test-'))
  FAKE = fakeCommand(FAKE_SCRIPT, join(dir, 'bin'), 'claude')
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
  } catch (e) {
    // Windows keeps a folder locked while the process that used it is still going down; the temp folder is harmless to leave
    if (process.platform !== 'win32') throw e
  }
})

const setCfg = (cfg: Record<string, unknown>): void => writeFileSync(join(dir, 'fake-claude.json'), JSON.stringify(cfg))
const calls = (): Array<{ argv: string[]; envKeys: string[]; cwd: string; stdin: string; pid: number }> =>
  existsSync(join(dir, 'fake-claude-calls.jsonl'))
    ? readFileSync(join(dir, 'fake-claude-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
const runCalls = () => calls().filter((c) => c.argv[0] !== 'auth')

const provider = (over: Partial<ClaudeCliOptions> = {}): ClaudeCliProvider =>
  new ClaudeCliProvider({ command: FAKE, model: 'haiku', workdir: dir, env: { ...process.env }, killGraceMs: 150, ...over })

async function collect(p: ClaudeCliProvider, message = 'hi', history: Array<{ role: 'user' | 'assistant'; text: string }> = [], signal?: AbortSignal) {
  const chunks: string[] = []
  let error: unknown = null
  try {
    for await (const c of p.sendMessage(message, { history }, signal)) chunks.push(c)
  } catch (e) {
    error = e
  }
  return { chunks, text: chunks.join(''), error }
}
const message = (e: unknown): string => (e instanceof ProviderError ? e.message : `NOT A ProviderError: ${String(e)}`)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (fn: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return fn()
}

describe('buildEnv', () => {
  it('keeps only what the CLI needs to find its login and the network', () => {
    const env = buildEnv({
      HOME: '/Users/x', PATH: '/bin', USER: 'x', LOGNAME: 'x', SHELL: '/bin/zsh', TMPDIR: '/tmp/', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://p'
    })
    expect(env).toEqual({ HOME: '/Users/x', PATH: '/bin', USER: 'x', LOGNAME: 'x', SHELL: '/bin/zsh', TMPDIR: '/tmp/', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://p' })
  })
  it('drops API keys, auth tokens, cloud-provider switches and everything else', () => {
    const env = buildEnv({
      HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://evil',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'g', FOO: 'bar'
    })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
    expect(JSON.stringify(env)).not.toMatch(/sk-ant|evil|secret/)
  })
})

describe('buildArgs', () => {
  const args = buildArgs('haiku', '/work/system-prompt.txt')
  const pair = (flag: string, value: string): boolean => args.some((a, i) => a === flag && args[i + 1] === value)
  it('turns every capability off', () => {
    expect(pair('--tools', '')).toBe(true)
    expect(args).toContain('--strict-mcp-config')
    expect(pair('--mcp-config', '{"mcpServers":{}}')).toBe(true)
    expect(pair('--setting-sources', '')).toBe(true)
    expect(args).toContain('--disable-slash-commands')
    expect(args).toContain('--no-session-persistence')
    expect(pair('--system-prompt-file', '/work/system-prompt.txt')).toBe(true)
    expect(args).not.toContain('--system-prompt')
    expect(pair('--model', 'haiku')).toBe(true)
  })
  it('adds --effort only when asked', () => {
    expect(args).not.toContain('--effort')
    const a = buildArgs('opus', '/f', 'high')
    expect(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
  })
  it('never grants permissions or resumes a session', () => {
    expect(args.join(' ')).not.toMatch(/dangerously|allowedTools|allowed-tools|permission|--resume|--continue|--add-dir/)
  })
})

describe('buildSystemPrompt', () => {
  const now = new Date('2026-10-19T10:00:00Z')
  it('asks for a normal conversation whose length follows the question, not a fixed cat persona', () => {
    const p = buildSystemPrompt({ now })
    expect(p).toMatch(/Match the length and depth/)
    expect(p).toMatch(/never cut a substantive answer short/)
    expect(p).not.toMatch(/one to three short sentences|plain text only/)
    expect(p).toContain('19 October 2026')
  })
  it('says honestly that it has no screen, files or connectors', () => {
    expect(buildSystemPrompt({ now })).toMatch(/cannot see the screen/)
  })
  it('includes memory only when given, and the remember instructions only when writing is on', () => {
    expect(buildSystemPrompt({ now })).not.toContain('<memory>')
    expect(buildSystemPrompt({ now })).not.toContain('<remember')
    const p = buildSystemPrompt({ now, memory: '### MEMORY.md\n- likes tea', memoryWrite: true })
    expect(p).toContain('<memory>\n### MEMORY.md\n- likes tea\n</memory>')
    expect(p).toContain('<remember type=')
    expect(buildSystemPrompt({ now, memory: 'x' })).not.toContain('<remember')
  })
})

describe('renderPrompt', () => {
  it('is just the message when there is no history', () => {
    expect(renderPrompt([], 'hello')).toBe('hello')
  })
  it('lays out earlier turns before the new message', () => {
    const p = renderPrompt([{ role: 'user', text: 'my name is Sam' }, { role: 'assistant', text: 'Hi Sam!' }], 'what is my name?')
    expect(p).toBe("Conversation so far:\nUser: my name is Sam\nYou: Hi Sam!\n\nThe user's new message:\nwhat is my name?\n\nReply to the new message, as yourself.")
  })
  it('drops the oldest turns first to fit, and always keeps the new message', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn${i} ${'x'.repeat(100)}` }))
    const p = renderPrompt(history, 'NEWEST', 450)
    expect(p).toContain('NEWEST')
    expect(p).toContain('turn9')
    expect(p).not.toContain('turn0')
    expect(p.length).toBeLessThan(450 + 200)
  })
  it('still sends the message when it alone exceeds the budget', () => {
    expect(renderPrompt([{ role: 'user', text: 'a' }], 'm'.repeat(100), 10)).toBe('m'.repeat(100))
  })
})

describe('parseStreamLine', () => {
  it('reads the init event', () => {
    const e = parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], apiKeySource: 'none' }))
    expect(e).toMatchObject({ kind: 'init', tools: [], mcpServers: [], apiKeySource: 'none' })
  })
  it('reads text deltas and ignores empty ones and other delta types', () => {
    const d = (delta: unknown): string => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta } })
    expect(parseStreamLine(d({ type: 'text_delta', text: 'Meow' }))).toEqual({ kind: 'text', text: 'Meow' })
    expect(parseStreamLine(d({ type: 'text_delta', text: '' }))).toBeNull()
    expect(parseStreamLine(d({ type: 'thinking_delta', thinking: 'secret' }))).toBeNull()
    expect(parseStreamLine(d({ type: 'text_delta', text: 5 }))).toBeNull()
  })
  it('reads the result', () => {
    expect(parseStreamLine('{"type":"result","is_error":true,"result":"Not logged in"}')).toEqual({ kind: 'result', isError: true, text: 'Not logged in' })
    expect(parseStreamLine('{"type":"result"}')).toEqual({ kind: 'result', isError: false, text: '' })
  })
  it.each(['', 'not json', '[]', '5', 'null', '{"type":"assistant"}', '{"type":"stream_event","event":5}'])('ignores %j', (line) => {
    expect(parseStreamLine(line)).toBeNull()
  })
})

describe('initProblem', () => {
  const ok = { kind: 'init' as const, tools: [], mcpServers: [], skills: [], slashCommands: [], apiKeySource: 'none' }
  it('accepts the locked-down subscription run', () => expect(initProblem(ok, false)).toBeNull())
  it('accepts an older init that omits skills and commands', () => expect(initProblem({ ...ok, skills: undefined, slashCommands: undefined }, false)).toBeNull())
  it('rejects tools, connectors, skills and commands', () => {
    expect(initProblem({ ...ok, tools: ['Bash'] }, false)).toMatch(/tools or connectors/)
    expect(initProblem({ ...ok, mcpServers: [{ name: 'gmail' }] }, false)).toMatch(/tools or connectors/)
    expect(initProblem({ ...ok, skills: ['x'] }, false)).toMatch(/skills or commands/)
    expect(initProblem({ ...ok, slashCommands: ['x'] }, false)).toMatch(/skills or commands/)
  })
  it('rejects an init that does not say whether tools are off', () => {
    expect(initProblem({ ...ok, tools: undefined }, false)).not.toBeNull()
    expect(initProblem({ ...ok, mcpServers: 'none' }, false)).not.toBeNull()
  })
  it('rejects any API key source unless billed API use is allowed', () => {
    expect(initProblem({ ...ok, apiKeySource: 'ANTHROPIC_API_KEY' }, false)).toMatch(/billed separately/)
    expect(initProblem({ ...ok, apiKeySource: undefined }, false)).toMatch(/billed separately/)
    expect(initProblem({ ...ok, apiKeySource: 'ANTHROPIC_API_KEY' }, true)).toBeNull()
  })
  it('allowBilledApi never relaxes the tool lock', () => expect(initProblem({ ...ok, tools: ['Bash'] }, true)).not.toBeNull())
})

describe('classifyError', () => {
  it.each([
    ['Not logged in · Please run /login', /claude auth login/],
    ['Invalid API key · Please run /login', /claude auth login/],
    ['OAuth token has expired', /claude auth login/],
    ["You've hit your limit · resets 3pm", /usage limit or rate limit.*resets 3pm/],
    ['API Error: 429 rate_limit_error', /usage limit or rate limit/],
    ['fetch failed ENOTFOUND api.anthropic.com', /internet connection/],
    ['API Error: 529 overloaded_error', /busy or having problems/],
    ['something unforeseen', /^Claude returned an error: something unforeseen$/]
  ])('%s', (raw, expected) => expect(classifyError(raw)).toMatch(expected))
  it('flattens control characters and bounds length', () => {
    const m = classifyError('bad\u0007\n\tthing ' + 'y'.repeat(1000))
    expect(m).not.toMatch(/[\u0000-\u001f]/)
    expect(m.length).toBeLessThan(200)
  })
  it('has a sensible message for empty text', () => expect(classifyError('')).toMatch(/try again/))
})

describe('resolveCommand', () => {
  it('accepts an executable absolute path and rejects a missing or non-executable one', () => {
    expect(resolveCommand(FAKE, {})).toBe(FAKE)
    expect(resolveCommand(join(dir, 'nope'), {})).toBeNull()
    writeFileSync(join(dir, 'plain'), 'x')
    chmodSync(join(dir, 'plain'), 0o644)
    expect(resolveCommand(join(dir, 'plain'), {})).toBeNull()
  })
  it('finds a bare name on PATH', () => {
    const win = process.platform === 'win32'
    const file = join(dir, win ? 'fakeclaudecmd.cmd' : 'fakeclaudecmd') // (Windows finds `fakeclaudecmd` by its extension)
    writeFileSync(file, win ? '@echo off\r\n' : '#!/bin/sh\n')
    chmodSync(file, 0o755)
    const sep = win ? ';' : ':'
    expect(resolveCommand('fakeclaudecmd', { PATH: `${join(dir, 'nonexistent')}${sep}${dir}`, HOME: dir })).toBe(file)
    expect(resolveCommand('definitely-not-installed-xyz', { PATH: join(dir, 'nonexistent'), HOME: dir })).toBeNull()
  })
})

describe('ClaudeCliProvider', () => {
  it('streams the reply in order', async () => {
    setCfg({ mode: 'ok', reply: 'Meow! Nice to meet you.' })
    const r = await collect(provider())
    expect(r.error).toBeNull()
    expect(r.chunks.length).toBeGreaterThan(1)
    expect(r.text).toBe('Meow! Nice to meet you.')
  })

  it('sends the message and history on stdin only, never on the command line', async () => {
    setCfg({ mode: 'ok' })
    const secret = 'ZZ-the-user-said-this-ZZ'
    await collect(provider(), secret, [{ role: 'user', text: 'earlier-user' }, { role: 'assistant', text: 'earlier-reply' }])
    const [c] = runCalls()
    expect(c!.stdin).toContain(secret)
    expect(c!.stdin).toContain('User: earlier-user')
    expect(c!.stdin).toContain('You: earlier-reply')
    expect(c!.argv.join(' ')).not.toContain(secret)
  })

  it('runs with every lock on, in the app-owned folder', async () => {
    setCfg({ mode: 'ok' })
    await collect(provider({ model: 'claude-haiku-5-5' }))
    const [c] = runCalls()
    // (a Windows .cmd launcher cannot carry the inline JSON, so it gets the same empty list as a file)
    const mcp = process.platform === 'win32' ? join(dir, 'no-mcp.json') : undefined
    expect(c!.argv).toEqual(buildArgs('claude-haiku-5-5', join(dir, 'system-prompt.txt'), undefined, false, mcp))
    const { realpathSync } = await import('node:fs')
    expect(realpathSync.native(c!.cwd)).toBe(realpathSync.native(dir))
  })

  it('gives the child no API key, cloud switch or unrelated variable even if the app has them', async () => {
    setCfg({ mode: 'ok' })
    const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'a', FOO_BAR: '1' }
    await collect(provider({ env }))
    const keys = runCalls()[0]!.envKeys
    for (const bad of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'FOO_BAR']) expect(keys).not.toContain(bad)
    expect(keys).toContain('HOME')
    expect(keys).toContain('PATH')
  })

  it('tolerates noise lines between events', async () => {
    setCfg({ mode: 'garbage' })
    expect((await collect(provider())).text).toBe('Hello there.')
  })

  it('falls back to the final text if no streaming deltas arrive', async () => {
    setCfg({ mode: 'nodeltas' })
    expect((await collect(provider())).text).toBe('All at once.')
  })

  it('yields nothing (and no error) for an empty reply, so the session can say so', async () => {
    setCfg({ mode: 'empty' })
    const r = await collect(provider())
    expect(r.chunks).toEqual([])
    expect(r.error).toBeNull()
  })

  describe('login checks', () => {
    it('asks the CLI how it is signed in once, not on every message', async () => {
      setCfg({ mode: 'ok' })
      const p = provider()
      await collect(p)
      await collect(p)
      expect(calls().filter((c) => c.argv[0] === 'auth')).toHaveLength(1)
      expect(runCalls()).toHaveLength(2)
    })
    it('stops before sending anything when not signed in', async () => {
      setCfg({ mode: 'ok', auth: { loggedIn: false } })
      const r = await collect(provider())
      expect(message(r.error)).toMatch(/claude auth login/)
      expect(runCalls()).toHaveLength(0)
    })
    it('keeps checking after a failure, so signing in later works without a restart', async () => {
      const p = provider()
      setCfg({ mode: 'ok', auth: { loggedIn: false } })
      expect((await collect(p)).error).not.toBeNull()
      setCfg({ mode: 'ok' })
      expect((await collect(p)).text).toBe('Meow! Nice to meet you.')
    })
    it.each([
      [{ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, /api_key.*billed separately/],
      [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, /billed separately/]
    ])('refuses a separately billed login %j', async (auth, expected) => {
      setCfg({ mode: 'ok', auth })
      const r = await collect(provider())
      expect(message(r.error)).toMatch(expected)
      expect(runCalls()).toHaveLength(0)
    })
    it('allows a billed login only when explicitly configured', async () => {
      setCfg({ mode: 'apikey', auth: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' } })
      const r = await collect(provider({ allowBilledApi: true }))
      expect(message(r.error)).not.toMatch(/billed separately/) // got past both checks
      expect(runCalls()).toHaveLength(1)
    })
    it('still applies the per-run check if the status output is unreadable', async () => {
      setCfg({ mode: 'apikey', auth: 'garbage' })
      expect(message((await collect(provider())).error)).toMatch(/billed separately/)
    })
  })

  describe('safety checks on the run itself', () => {
    it.each([
      ['tools', /tools or connectors/],
      ['connectors', /tools or connectors/],
      ['skills', /skills or commands/],
      ['apikey', /billed separately/]
    ])('stops a run that starts with %s and shows none of its output', async (mode, expected) => {
      setCfg({ mode })
      const r = await collect(provider())
      expect(message(r.error)).toMatch(expected)
      expect(r.chunks).toEqual([])
    })
    it('ignores output from a run that never sent an init event', async () => {
      setCfg({ mode: 'noinit' })
      const r = await collect(provider())
      expect(r.chunks).toEqual([])
      expect(message(r.error)).toMatch(/Unexpected output/)
    })
  })

  describe('errors become readable messages', () => {
    it.each([
      ['autherr', /claude auth login/],
      ['limit', /usage limit or rate limit.*resets 3pm/],
      ['network', /internet connection/],
      ['overloaded', /busy or having problems/],
      ['crash-start-auth', /claude auth login/],
      ['crash-start', /Claude returned an error: boom/],
      ['silent-ok', /ended without replying/]
    ])('%s', async (mode, expected) => {
      setCfg({ mode })
      const r = await collect(provider())
      expect(message(r.error)).toMatch(expected)
    })
    it('never passes control characters through', async () => {
      setCfg({ mode: 'weird' })
      expect(message((await collect(provider())).error)).not.toMatch(/[\u0000-\u001f]/)
    })
    it('reports a crash in the middle of a reply after the part that arrived', async () => {
      setCfg({ mode: 'crash-mid' })
      const r = await collect(provider())
      expect(r.text).toBe('Half a sen')
      expect(message(r.error)).toMatch(/stopped unexpectedly/)
    })
    it('says so when the claude command is not installed', async () => {
      const r = await collect(provider({ command: 'definitely-not-installed-xyz', env: { PATH: '/nonexistent', HOME: dir } }))
      expect(message(r.error)).toMatch(/Couldn't find the "definitely-not-installed-xyz" command.*claude auth login/)
    })
    it('refuses a reply that is absurdly long', async () => {
      setCfg({ mode: 'big' })
      const r = await collect(provider({ maxReplyChars: 5000 }))
      expect(message(r.error)).toMatch(/too long/)
      expect(r.text.length).toBeLessThanOrEqual(5000)
    })
    it('refuses an absurdly long output line', async () => {
      setCfg({ mode: 'bigline' })
      expect(message((await collect(provider())).error)).toMatch(/unexpectedly large/)
    })
  })

  describe('cancellation', () => {
    it('kills the child when aborted mid-reply and throws an AbortError', async () => {
      setCfg({ mode: 'hang' })
      const ac = new AbortController()
      const p = provider()
      const got: string[] = []
      const run = (async () => {
        try {
          for await (const c of p.sendMessage('hi', {}, ac.signal)) {
            got.push(c)
            ac.abort()
          }
        } catch (e) {
          return e
        }
        return null
      })()
      const err = (await run) as Error
      expect(err.name).toBe('AbortError')
      const pid = runCalls()[0]!.pid
      expect(await until(() => !alive(pid))).toBe(true)
    })
    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      setCfg({ mode: 'hang', ignoreTerm: true })
      const ac = new AbortController()
      const p = provider({ killGraceMs: 100 })
      const run = collect(p, 'hi', [], ac.signal)
      expect(await until(() => runCalls().length === 1)).toBe(true)
      ac.abort()
      await run
      expect(await until(() => !alive(runCalls()[0]!.pid))).toBe(true)
    })
    it('does not start anything if already aborted', async () => {
      setCfg({ mode: 'ok' })
      const ac = new AbortController()
      ac.abort()
      const r = await collect(provider(), 'hi', [], ac.signal)
      expect((r.error as Error).name).toBe('AbortError')
      expect(calls()).toHaveLength(0)
    })
    it('kills the child when the consumer stops reading early', async () => {
      setCfg({ mode: 'hang' })
      const p = provider()
      for await (const _ of p.sendMessage('hi')) break
      expect(await until(() => !alive(runCalls()[0]!.pid))).toBe(true)
    })
    it('dispose() stops runs in flight (app quit)', async () => {
      setCfg({ mode: 'hang' })
      const p = provider()
      const run = collect(p)
      expect(await until(() => runCalls().length === 1)).toBe(true)
      p.dispose()
      const r = await run
      expect(r.error).not.toBeNull()
      expect(await until(() => !alive(runCalls()[0]!.pid))).toBe(true)
    })
  })
})

describe('screenshots', () => {
  it('buildArgs switches to stream-json input only when asked', () => {
    expect(buildArgs('haiku', '/f')).not.toContain('--input-format')
    const a = buildArgs('haiku', '/f', undefined, true)
    expect(a[a.indexOf('--input-format') + 1]).toBe('stream-json')
  })
  it('sends the image and the text as one stream-json message on stdin, never on the command line', async () => {
    setCfg({ mode: 'ok' })
    const p = provider()
    const chunks: string[] = []
    for await (const c of p.sendMessage('what is this error?', { history: [{ role: 'user', text: 'earlier' }], screenshotBase64: 'QUJDREVG', screenshotMime: 'image/jpeg' })) chunks.push(c)
    const [c] = runCalls()
    expect(c!.argv).toContain('--input-format')
    expect(c!.argv.join(' ')).not.toContain('QUJDREVG')
    const line = JSON.parse(c!.stdin.trim())
    expect(line.type).toBe('user')
    expect(line.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJDREVG' } })
    expect(line.message.content[1].type).toBe('text')
    expect(line.message.content[1].text).toContain('what is this error?')
    expect(line.message.content[1].text).toContain('User: earlier')
    expect(chunks.join('')).toBeTruthy()
  })
  it('tells the model the screenshot is content, not instructions, and gives it no memory-writing instructions in the app wiring', () => {
    const s = buildSystemPrompt({ screen: true, memory: 'm' })
    expect(s).toMatch(/share a screenshot/)
    expect(s).toMatch(/never instructions to follow/)
    expect(s).not.toMatch(/cannot see the screen/)
  })
  it('a normal message carries no image and plain text on stdin', async () => {
    setCfg({ mode: 'ok' })
    await collect(provider(), 'plain')
    const [c] = runCalls()
    expect(c!.argv).not.toContain('--input-format')
    expect(c!.stdin).toBe('plain')
  })
  it('asks the system-prompt builder whether a screenshot is attached', async () => {
    setCfg({ mode: 'ok' })
    const seen: boolean[] = []
    const p = provider({ systemPrompt: (info) => (seen.push(info.screen), 'x') })
    await collect(p, 'a')
    for await (const _ of p.sendMessage('b', { screenshotBase64: 'QQ==' })) void _
    expect(seen).toEqual([false, true])
  })
})
