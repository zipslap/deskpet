import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '../src/services/ai/presets'
import { problemWith, saveChoice, splitArgs, testConnection, type KeyWriter } from '../src/services/setup/ai-setup'
import { countInstalled, packSteps, STARTER_VOICES, VoicePackRunner } from '../src/services/setup/voice-pack'
import { EMPTY_SETUP_UI, parseSetupRequest, parseSetupUiState, parseVoicePack, type SetupRequest } from '../src/shared/setup-types'

const req = (over: Partial<SetupRequest> = {}): SetupRequest => ({ provider: 'openai', model: '', baseUrl: '', command: '', args: '', key: '', ...over })

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'deskpet-setup-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

class FakeKeys implements KeyWriter {
  stored: Record<string, string> = {}
  constructor(readonly secure = true) {}
  set(account: string, key: string): void {
    if (!this.secure) throw new Error('no secure storage')
    this.stored[account] = key
  }
}

describe('parseSetupRequest', () => {
  it('accepts a normal choice and trims the key', () => {
    expect(parseSetupRequest({ provider: 'openai', model: 'gpt-4o', key: ' sk-abc123\n' })).toEqual({ provider: 'openai', model: 'gpt-4o', baseUrl: '', command: '', args: '', key: 'sk-abc123' })
  })
  it('refuses what is not a choice', () => {
    for (const bad of [null, 'x', 42, {}, { provider: 'OpenAI' }, { provider: 'a b' }, { provider: 'openai', model: 'bad model!' }, { provider: 'openai', key: 5 }, { provider: 'openai', key: 'k'.repeat(601) }, { provider: 'openai', baseUrl: 'x'.repeat(301) }, { provider: 'openai', command: 'a\nb' }]) {
      expect(parseSetupRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('parseVoicePack', () => {
  it('knows two packs', () => {
    expect(parseVoicePack('starter')).toBe('starter')
    expect(parseVoicePack('recommended')).toBe('recommended')
    expect(parseVoicePack('all')).toBeNull()
    expect(parseVoicePack(undefined)).toBeNull()
  })
})

describe('parseSetupUiState', () => {
  it('round-trips the empty state and rejects junk', () => {
    expect(parseSetupUiState(EMPTY_SETUP_UI)).toEqual(EMPTY_SETUP_UI)
    expect(parseSetupUiState(null)).toBeNull()
    expect(parseSetupUiState({ ...EMPTY_SETUP_UI, providers: [{ id: 'x y', label: 'l', hint: 'h', kind: 'mock' }] })).toBeNull()
    expect(parseSetupUiState({ ...EMPTY_SETUP_UI, providers: [{ id: 'x', label: 'l', hint: 'h', kind: 'telepathy' }] })).toBeNull()
  })
  it('clamps what it keeps', () => {
    const s = parseSetupUiState({ ...EMPTY_SETUP_UI, message: 'm'.repeat(2000), voice: { ...EMPTY_SETUP_UI.voice, log: Array.from({ length: 40 }, (_, i) => `line ${i}`), voices: -3 } })
    expect(s?.message.length).toBe(600)
    expect(s?.voice.log.length).toBe(12)
    expect(s?.voice.voices).toBe(0)
  })
})

describe('problemWith', () => {
  it('asks for a key only when the service needs one and none is stored', () => {
    expect(problemWith(req(), false)).toMatch(/key/)
    expect(problemWith(req(), true)).toBeNull()
    expect(problemWith(req({ key: 'sk-1' }), false)).toBeNull()
    expect(problemWith(req({ provider: 'ollama' }), false)).toBeNull()
  })
  it('wants a safe address for a custom server and a command for the command service', () => {
    expect(problemWith(req({ provider: 'custom' }), false)).toMatch(/address/)
    expect(problemWith(req({ provider: 'custom', baseUrl: 'http://example.com/v1' }), false)).toMatch(/https/)
    expect(problemWith(req({ provider: 'custom', baseUrl: 'http://localhost:8080/v1' }), false)).toBeNull()
    expect(problemWith(req({ provider: 'command' }), false)).toMatch(/command/)
    expect(problemWith(req({ provider: 'command', command: 'gemini' }), false)).toBeNull()
  })
  it('refuses an unknown service', () => {
    expect(problemWith(req({ provider: 'nope' }), true)).toMatch(/know/)
  })
})

describe('saveChoice', () => {
  const settings = join('SETTINGS.json')
  const file = (): string => join(dir, settings)
  const read = (): Record<string, any> => JSON.parse(readFileSync(file(), 'utf8'))

  it('creates the file, stores the key apart from it, and never writes the key into settings.json', () => {
    const keys = new FakeKeys()
    saveChoice(file(), req({ model: 'gpt-4o', key: 'sk-secret-1' }), keys)
    expect(keys.stored['openai']).toBe('sk-secret-1')
    expect(read().ai).toEqual({ provider: 'openai', model: 'gpt-4o' })
    expect(readFileSync(file(), 'utf8')).not.toContain('sk-secret-1')
  })
  it('keeps every other setting and the unrelated parts of "ai"', () => {
    writeFileSync(file(), JSON.stringify({ sleepAfterMs: 60000, voice: { rate: 200 }, ai: { provider: 'mock', persona: 'plain', timeoutSeconds: 30 } }))
    saveChoice(file(), req({ provider: 'ollama', model: 'llama3.2' }), new FakeKeys())
    expect(read()).toEqual({ sleepAfterMs: 60000, voice: { rate: 200 }, ai: { provider: 'ollama', model: 'llama3.2', persona: 'plain', timeoutSeconds: 30 } })
  })
  it('clears a leftover server address when switching away from a custom one, so a key cannot go to it', () => {
    writeFileSync(file(), JSON.stringify({ ai: { provider: 'custom', baseUrl: 'https://my.server/v1', apiKeyEnv: 'MY_KEY', command: 'x', args: ['a'] } }))
    saveChoice(file(), req({ provider: 'openai', key: 'sk-1' }), new FakeKeys())
    expect(read().ai).toEqual({ provider: 'openai', model: '' })
  })
  it('saves a custom server with its address, and keeps the key variable the person named', () => {
    writeFileSync(file(), JSON.stringify({ ai: { apiKeyEnv: 'MY_KEY' } }))
    saveChoice(file(), req({ provider: 'custom', baseUrl: 'http://localhost:8080/v1', model: 'my-model' }), new FakeKeys())
    expect(read().ai).toEqual({ provider: 'custom', model: 'my-model', baseUrl: 'http://localhost:8080/v1', apiKeyEnv: 'MY_KEY' })
  })
  it('saves a command and its arguments as a list', () => {
    saveChoice(file(), req({ provider: 'command', command: 'gemini', args: '-p   {prompt} --x' }), new FakeKeys())
    expect(read().ai).toMatchObject({ provider: 'command', command: 'gemini', args: ['-p', '{prompt}', '--x'] })
  })
  it('does not touch the key store when no key was typed', () => {
    const keys = new FakeKeys()
    saveChoice(file(), req(), keys)
    expect(keys.stored).toEqual({})
  })
  it('refuses a key for a service that has none, and a broken settings file, before storing anything', () => {
    const keys = new FakeKeys()
    expect(() => saveChoice(file(), req({ provider: 'ollama', key: 'k' }), keys)).toThrow(/does not use a key/)
    writeFileSync(file(), '{ not json')
    expect(() => saveChoice(file(), req({ key: 'sk-1' }), keys)).toThrow(/cannot be read/)
    expect(readFileSync(file(), 'utf8')).toBe('{ not json')
    expect(keys.stored).toEqual({})
  })
  it('says so when the system has no secure storage, and leaves settings.json as it was', () => {
    writeFileSync(file(), JSON.stringify({ ai: { provider: 'mock' } }))
    expect(() => saveChoice(file(), req({ key: 'sk-1' }), new FakeKeys(false))).toThrow(/secure storage/)
    expect(read().ai).toEqual({ provider: 'mock' })
  })
  it('refuses an unknown service', () => {
    expect(() => saveChoice(file(), req({ provider: 'nope' }), new FakeKeys())).toThrow(/know/)
  })
})

describe('splitArgs', () => {
  it('splits on any run of spaces', () => expect(splitArgs('  -p  {prompt}\t--x ')).toEqual(['-p', '{prompt}', '--x']))
})

describe('testConnection', () => {
  const ok = (): Response => new Response('{}', { status: 200 })
  const status = (n: number) => async (): Promise<Response> => new Response('', { status: n })
  const env = { HOME: '/nonexistent-home', PATH: '' }

  it('asks an OpenAI-style service for its models with the key', async () => {
    let seen: { url?: string; headers?: Record<string, string> } = {}
    const r = await testConnection({ req: req(), key: 'sk-1', env, fetchFn: (async (url: string, init: RequestInit) => ((seen = { url, headers: init.headers as Record<string, string> }), ok())) as unknown as typeof fetch })
    expect(r.state).toBe('ok')
    expect(seen.url).toBe('https://api.openai.com/v1/models')
    expect(seen.headers?.['authorization']).toBe('Bearer sk-1')
  })
  it('uses the Anthropic headers for Claude', async () => {
    let seen: Record<string, string> = {}
    await testConnection({ req: req({ provider: 'anthropic' }), key: 'sk-ant-1', env, fetchFn: (async (_u: string, init: RequestInit) => ((seen = init.headers as Record<string, string>), ok())) as unknown as typeof fetch })
    expect(seen['x-api-key']).toBe('sk-ant-1')
    expect(seen['anthropic-version']).toBeTruthy()
  })
  it('tells a rejected key from an unreachable service from another error', async () => {
    expect((await testConnection({ req: req(), key: 'bad', env, fetchFn: status(401) as unknown as typeof fetch })).state).toBe('key-rejected')
    expect((await testConnection({ req: req(), key: 'k', env, fetchFn: status(500) as unknown as typeof fetch })).state).toBe('http-error')
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect((await testConnection({ req: req({ provider: 'ollama' }), key: null, env, fetchFn: down })).message).toMatch(/Start the server/)
  })
  it('never sends a key to an address that is not https (or this computer)', async () => {
    let called = false
    const r = await testConnection({ req: req({ provider: 'custom', baseUrl: 'http://example.com/v1' }), key: 'k', env, fetchFn: (async () => ((called = true), ok())) as unknown as typeof fetch })
    expect(called).toBe(false)
    expect(r.state).toBe('unreachable')
  })
  it('does not send the typed address to a service that has its own', async () => {
    let url = ''
    await testConnection({ req: req({ baseUrl: 'https://evil.example/v1' }), key: 'sk-1', env, fetchFn: (async (u: string) => ((url = u), ok())) as unknown as typeof fetch })
    expect(url.startsWith('https://api.openai.com')).toBe(true)
  })
  it('looks for the claude command and for a custom command', async () => {
    expect((await testConnection({ req: req({ provider: 'claude-cli' }), key: null, env })).state).toBe('not-found')
    const bin = join(dir, 'mycli')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    if (process.platform !== 'win32') expect((await testConnection({ req: req({ provider: 'command', command: bin }), key: null, env })).state).toBe('ok')
    expect((await testConnection({ req: req({ provider: 'command', command: '' }), key: null, env })).state).toBe('not-found')
  })
  it('knows every service the app lists', async () => {
    for (const p of PROVIDER_PRESETS) expect(await testConnection({ req: req({ provider: p.id, baseUrl: 'https://x.example/v1', command: 'nothing-here' }), key: 'k', env, fetchFn: (async () => ok()) as unknown as typeof fetch }), p.id).toHaveProperty('state')
  })
})

describe('voice pack', () => {
  it('steps: set up Python, install voices, install speech recognition', () => {
    expect(packSteps('starter')).toEqual([['voices.mjs', 'setup'], ['voices.mjs', 'install', ...STARTER_VOICES], ['speech.mjs', 'install', 'stt-en']])
    expect(packSteps('recommended')[1]).toEqual(['voices.mjs', 'install', '--recommended'])
  })

  it('ships every installer script (and the shared helper) inside the packaged app', () => {
    const files: string[] = JSON.parse(readFileSync('package.json', 'utf8')).build.files
    for (const step of [...packSteps('starter'), ...packSteps('recommended')]) expect(files).toContain(`tools/${step[0]}`)
    expect(files).toContain('tools/lib/**')
  })
  it('the starter voices exist in the voice catalog', () => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../assets/voices/catalog.json'), 'utf8')) as { voices: Array<{ id: string }> }
    for (const id of STARTER_VOICES) expect(catalog.voices.map((v) => v.id), id).toContain(id)
  })
  it('counts only fully installed model folders', () => {
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', '.deskpet-model.json'), '{}')
    mkdirSync(join(dir, 'b')) // a download that did not finish
    expect(countInstalled(dir)).toBe(1)
    expect(countInstalled(join(dir, 'missing'))).toBe(0)
  })

  // fake installers: plain Node scripts, run by the test runner's own node
  const tools = (voices: string, speech = 'console.log("speech ok")'): string => {
    const t = join(dir, 'tools')
    mkdirSync(t, { recursive: true })
    writeFileSync(join(t, 'voices.mjs'), voices)
    writeFileSync(join(t, 'speech.mjs'), speech)
    return t
  }
  const run = (toolsDir: string) => {
    const logs: string[][] = []
    const runner = new VoicePackRunner()
    return { runner, logs, result: runner.run('starter', { toolsDir, execPath: process.execPath, dataDir: dir, onLog: (l) => logs.push(l) }) }
  }

  it('runs the steps in order, passes the data folder, and shows the progress lines', async () => {
    const t = tools(`import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DESKPET_DATA_DIR + '/order.txt', process.argv.slice(2).join(' ') + '|' + process.env.ELECTRON_RUN_AS_NODE + '\\n')
process.stdout.write('\\r  voice: 10%   \\r  voice: 20%   \\n')`, `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.DESKPET_DATA_DIR + '/order.txt', 'speech ' + process.argv.slice(2).join(' ') + '\\n')`)
    const { logs, result } = run(t)
    expect(await result).toEqual({ ok: true, reason: 'Done.' })
    const order = readFileSync(join(dir, 'order.txt'), 'utf8').trim().split('\n')
    expect(order).toEqual(['setup|1', `install ${STARTER_VOICES.join(' ')}|1`, 'speech install stt-en'])
    expect(logs.at(-1)?.join('\n')).toContain('voice: 20%')
    expect(logs.at(-1)?.join('\n')).not.toContain('voice: 10%') // the redrawn percentage replaces the old one
  })
  it('stops at the first failing step and reports what the installer said', async () => {
    const t = tools(`console.log('Creating the environment'); console.error('Python 3.9 or newer is needed for the offline voices'); process.exit(1)`, `throw new Error('must not run')`)
    const r = await run(t).result
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Python 3.9/)
  })
  it('can be cancelled, and one download runs at a time', async () => {
    const t = tools(`setInterval(() => {}, 1000)`)
    const { runner, result } = run(t)
    await new Promise((r) => setTimeout(r, 300))
    expect(runner.running).toBe(true)
    expect((await runner.run('starter', { toolsDir: t, execPath: process.execPath, dataDir: dir, onLog: () => {} })).reason).toMatch(/already running/)
    runner.cancel()
    expect(await result).toEqual({ ok: false, reason: 'Cancelled.' })
    expect(runner.running).toBe(false)
  })
  it('reports a missing executable instead of throwing', async () => {
    const r = await new VoicePackRunner().run('starter', { toolsDir: tools('//'), execPath: join(dir, 'no-such-program'), dataDir: dir, onLog: () => {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Could not start/)
  })
})
