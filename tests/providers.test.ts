import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProvider, describeProvider } from '../src/services/ai/create-provider'
import { HttpProvider } from '../src/services/ai/http-provider'
import { CommandProvider } from '../src/services/ai/command-provider'
import { ClaudeCliProvider } from '../src/services/ai/claude-cli-provider'
import { MockProvider } from '../src/services/ai/mock-provider'
import { isSafeBaseUrl, PROVIDER_IDS, PROVIDER_PRESETS, presetFor } from '../src/services/ai/presets'
import { DEFAULT_SETTINGS, parseSettings, type AiSettings } from '../src/services/memory/settings'

const ai = (over: Partial<AiSettings>): AiSettings => ({ ...DEFAULT_SETTINGS.ai, ...over })
const first = (it: AsyncIterable<string>): Promise<IteratorResult<string>> => it[Symbol.asyncIterator]().next()
const input = (a: AiSettings, keyStore = async (): Promise<string | null> => null) => ({ ai: a, env: {}, workdir: '/tmp/x', model: () => 'm', effort: () => undefined, systemPrompt: () => 's', keyStore })

describe('presets', () => {
  it('have unique ids, and every service has what it needs', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length)
    for (const p of PROVIDER_PRESETS) {
      expect(p.label, p.id).toBeTruthy()
      expect(p.hint, p.id).toBeTruthy()
      if (p.kind === 'openai-compatible' || p.kind === 'anthropic') {
        if (p.id !== 'custom') expect(isSafeBaseUrl(p.baseUrl!), `${p.id} address`).toBe(true)
        if (p.needsKey) expect(p.keyEnv, `${p.id} key variable`).toMatch(/^[A-Z][A-Z0-9_]+$/)
      }
      expect(p.models.length === 0 || p.models.includes(p.defaultModel), `${p.id} default is listed`).toBe(true)
    }
  })
  it('the setup tool and the app read the same file', () => {
    const file = JSON.parse(readFileSync(join(__dirname, '../src/services/ai/providers.json'), 'utf8')) as Array<{ id: string }>
    expect(file.map((p) => p.id)).toEqual([...PROVIDER_IDS])
  })
  it('an unknown id is the offline demo', () => expect(presetFor('nope').id).toBe('mock'))
  it.each([
    ['https://api.openai.com/v1', true],
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:1234', true],
    ['http://[::1]:8080/v1', true],
    ['http://api.openai.com/v1', false],
    ['http://localhost.evil.com/v1', false],
    ['https://u:p@host/v1', false],
    ['file:///etc/passwd', false],
    ['not a url', false]
  ])('isSafeBaseUrl(%s) = %s', (url, ok) => expect(isSafeBaseUrl(url)).toBe(ok))
})

describe('describeProvider', () => {
  it('only the Claude subscription route has an effort setting; only the command route cannot see screenshots', () => {
    expect(describeProvider(ai({ provider: 'claude-cli' })).hasEffort).toBe(true)
    expect(describeProvider(ai({ provider: 'openai' })).hasEffort).toBe(false)
    expect(describeProvider(ai({ provider: 'command' })).hasVision).toBe(false)
    expect(describeProvider(ai({ provider: 'gemini' })).hasVision).toBe(true)
  })
  it('lists the chosen model first, then the suggestions and your own extras, without repeats', () => {
    const d = describeProvider(ai({ provider: 'openai', model: 'gpt-4o-mini', models: ['my-ft', 'gpt-4o'] }))
    expect(d.models[0]).toBe('gpt-4o-mini')
    expect(new Set(d.models).size).toBe(d.models.length)
    expect(d.models).toEqual(expect.arrayContaining(['gpt-4o', 'my-ft']))
  })
  it('uses the service default model when none is set', () => {
    expect(describeProvider(ai({ provider: 'gemini' })).defaultModel).toBe('gemini-2.5-flash')
    expect(describeProvider(ai({ provider: 'claude-cli' })).defaultModel).toBe('sonnet')
  })
})

describe('createProvider', () => {
  it('builds the right kind of provider for each route', () => {
    expect(createProvider(input(ai({ provider: 'mock' })))).toBeInstanceOf(MockProvider)
    expect(createProvider(input(ai({ provider: 'claude-cli' })))).toBeInstanceOf(ClaudeCliProvider)
    expect(createProvider(input(ai({ provider: 'command', command: 'gemini' })))).toBeInstanceOf(CommandProvider)
    for (const id of ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'ollama', 'lmstudio']) {
      expect(createProvider(input(ai({ provider: id }))), id).toBeInstanceOf(HttpProvider)
    }
  })
  it('a service that cannot work explains why when you talk to it', async () => {
    for (const a of [ai({ provider: 'command' }), ai({ provider: 'custom' })]) {
      const p = createProvider(input(a))
      await expect(first(p.sendMessage('hi'))).rejects.toThrow(/settings\.json/)
    }
  })
  it('reads the key from the Keychain first, then the named variable', async () => {
    let auth: string | undefined
    const real = globalThis.fetch
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)['authorization']
      return new Response('data: [DONE]\n\n', { status: 200 })
    }) as typeof fetch
    try {
      const p = createProvider({ ...input(ai({ provider: 'openai' }), async () => 'kc-key'), env: { OPENAI_API_KEY: 'env-key' } })
      await first(p.sendMessage('hi')).catch(() => undefined)
      expect(auth).toBe('Bearer kc-key')
      const q = createProvider({ ...input(ai({ provider: 'openai', apiKeyEnv: 'MY_VAR' })), env: { MY_VAR: 'custom-env-key' } })
      await first(q.sendMessage('hi')).catch(() => undefined)
      expect(auth).toBe('Bearer custom-env-key')
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('settings → providers', () => {
  it('every preset id is accepted by the settings parser', () => {
    for (const id of PROVIDER_IDS) expect(parseSettings({ ai: { provider: id } }).warnings, id).toEqual([])
  })
})
