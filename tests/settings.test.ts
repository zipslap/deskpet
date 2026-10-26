import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, MAX_SLEEP_MS, MIN_SLEEP_MS, loadSettings, parseSettings } from '../src/services/memory/settings'

describe('parseSettings', () => {
  it('returns the defaults for empty input', () => {
    expect(parseSettings({})).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] })
    expect(parseSettings(undefined).settings).toEqual(DEFAULT_SETTINGS)
  })
  it('accepts valid overrides', () => {
    const { settings, warnings } = parseSettings({ shortcuts: { toggleChat: 'Alt+Shift+K' }, sleepAfterMs: 60_000 })
    expect(settings.shortcuts).toEqual({ ...DEFAULT_SETTINGS.shortcuts, toggleChat: 'Alt+Shift+K' })
    expect(settings.sleepAfterMs).toBe(60_000)
    expect(warnings).toEqual([])
  })
  it.each(['', 'Cmd+', '+P', 'Alt Shift K', 'Alt+Shift+K; rm -rf', 5, null, 'A'.repeat(100)])('rejects shortcut %j with a warning', (bad) => {
    const { settings, warnings } = parseSettings({ shortcuts: { toggleChat: bad } })
    expect(settings.shortcuts.toggleChat).toBe(DEFAULT_SETTINGS.shortcuts.toggleChat)
    expect(warnings.length).toBeGreaterThan(0)
  })
  it('rejects identical shortcuts', () => {
    const { settings, warnings } = parseSettings({ shortcuts: { toggleHide: 'Alt+K', toggleChat: 'Alt+K' } })
    expect(settings.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
    expect(warnings.join()).toContain('identical')
  })
  it.each([0, -5, MIN_SLEEP_MS - 1, MAX_SLEEP_MS + 1, NaN, Infinity, '300000', null])('rejects sleepAfterMs %j', (bad) => {
    const { settings, warnings } = parseSettings({ sleepAfterMs: bad })
    expect(settings.sleepAfterMs).toBe(DEFAULT_SETTINGS.sleepAfterMs)
    expect(warnings.length).toBe(1)
  })
  it.each([[[]], ['x'], [42], [null]])('non-object input %j falls back to defaults', (raw) => {
    expect(parseSettings(raw).settings).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(raw).warnings.length).toBe(1)
  })
  it('does not share mutable state with the defaults', () => {
    const { settings } = parseSettings({})
    settings.shortcuts.toggleChat = 'Changed'
    expect(DEFAULT_SETTINGS.shortcuts.toggleChat).not.toBe('Changed')
  })
})

describe('parseSettings: voice', () => {
  it('live talking and the local neural voice are on by default, and their settings are checked', () => {
    expect(DEFAULT_SETTINGS.voice).toMatchObject({ live: true, engine: 'local', local: { model: 'kokoro-multi-lang-v1_0', sid: 3, pitch: 1 } })
    const ok = parseSettings({ voice: { live: false, engine: 'say', local: { model: 'piper-en_US-amy-medium', sid: 15, pitch: 1.2, speed: 1, python: '/opt/py/bin/python', modelsDir: '' } } })
    expect(ok.warnings).toEqual([])
    expect(ok.settings.voice).toMatchObject({ live: false, engine: 'say', local: { model: 'piper-en_US-amy-medium', sid: 15, pitch: 1.2, speed: 1, python: '/opt/py/bin/python' } })
    const bad = parseSettings({ voice: { live: 'yes', engine: 'robot', local: { sid: 9999, pitch: 3, model: '../x', python: 'python', modelsDir: '/a/../b' } } })
    expect(bad.warnings).toHaveLength(7)
    expect(bad.settings.voice).toMatchObject({ live: true, engine: 'local', local: DEFAULT_SETTINGS.voice.local })
  })
  it('has safe defaults: replies spoken, nothing auto-sent, recognition on-device only', () => {
    const v = parseSettings({}).settings.voice
    expect(v).toMatchObject({ speakReplies: true, allowServerRecognition: false, autoSend: false, voice: '' })
  })
  it('accepts valid overrides', () => {
    const { settings, warnings } = parseSettings({
      voice: { speakReplies: false, voice: 'Eddy (English (US))', rate: 200, locale: 'en-GB', autoSend: true, maxListenSeconds: 60, silenceMs: 2500, allowServerRecognition: true },
      shortcuts: { toggleListen: 'Alt+Shift+L' }
    })
    expect(warnings).toEqual([])
    expect(settings.voice).toEqual({ speakReplies: false, voice: 'Eddy (English (US))', rate: 200, locale: 'en-GB', allowServerRecognition: true, autoSend: true, maxSpokenChars: 600, maxListenSeconds: 60, silenceMs: 2500, live: true, engine: 'local', local: DEFAULT_SETTINGS.voice.local })
    expect(settings.shortcuts.toggleListen).toBe('Alt+Shift+L')
  })
  it.each([
    ['rate', 10], ['rate', 9999], ['rate', 'fast'], ['rate', NaN],
    ['maxListenSeconds', 0], ['maxListenSeconds', 99999], ['silenceMs', 5], ['silenceMs', 10 ** 9],
    ['speakReplies', 'yes'], ['autoSend', 1], ['allowServerRecognition', null]
  ])('rejects voice.%s = %j', (key, bad) => {
    const { settings, warnings } = parseSettings({ voice: { [key]: bad } })
    expect(settings.voice).toEqual(DEFAULT_SETTINGS.voice)
    expect(warnings).toHaveLength(1)
  })
  it.each(['', 'e', 'en_US', 'en-US-extra-long-garbage', '../../etc', 'EN-us ', 5, null])('rejects locale %j', (bad) => {
    expect(parseSettings({ voice: { locale: bad } }).settings.voice.locale).toBe('en-US')
  })
  it.each(['-v ? ; rm -rf /', 'Eddy\n', 'a'.repeat(61), '$(whoami)', '`x`', 5, null])('rejects voice name %j (it ends up on a command line)', (bad) => {
    expect(parseSettings({ voice: { voice: bad } }).settings.voice.voice).toBe('')
  })
  it('a bare language code is accepted', () => {
    expect(parseSettings({ voice: { locale: 'it' } }).settings.voice.locale).toBe('it')
  })
  it('three identical shortcuts or any pair are rejected', () => {
    const { settings, warnings } = parseSettings({ shortcuts: { toggleChat: 'Alt+K', toggleListen: 'Alt+K' } })
    expect(settings.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
    expect(warnings.join()).toContain('identical')
  })
  it('"voice" must be an object', () => {
    expect(parseSettings({ voice: 'loud' }).warnings).toHaveLength(1)
  })
})

describe('parseSettings: memory and spoken length', () => {
  it('defaults: memory read+write on, default folder; long replies spoken to 600 chars', () => {
    expect(DEFAULT_SETTINGS.memory).toEqual({ enabled: true, write: true, dir: '', summarize: true })
    expect(DEFAULT_SETTINGS.voice.maxSpokenChars).toBe(600)
  })
  it('accepts valid overrides', () => {
    const { settings, warnings } = parseSettings({ memory: { enabled: false, write: false, dir: '/Users/me/mem', summarize: false }, voice: { maxSpokenChars: 0 } })
    expect(settings.memory).toEqual({ enabled: false, write: false, dir: '/Users/me/mem', summarize: false })
    expect(settings.voice.maxSpokenChars).toBe(0)
    expect(warnings).toEqual([])
  })
  it.each(['relative/dir', '/a/../b', 5, null, '/' + 'x'.repeat(500)])('rejects memory.dir %j', (bad) => {
    const { settings, warnings } = parseSettings({ memory: { dir: bad } })
    expect(settings.memory.dir).toBe('')
    expect(warnings).toHaveLength(1)
  })
  it.each(['yes', 1, null])('memory flags must be booleans; %j is ignored', (bad) => {
    const { settings, warnings } = parseSettings({ memory: { write: bad, enabled: bad, summarize: bad } })
    expect(settings.memory).toEqual(DEFAULT_SETTINGS.memory)
    expect(warnings).toHaveLength(3)
  })
  it.each([-1, 20_001, NaN, '600'])('rejects maxSpokenChars %j', (bad) => {
    expect(parseSettings({ voice: { maxSpokenChars: bad } }).settings.voice.maxSpokenChars).toBe(600)
  })
})

describe('parseSettings: ai', () => {
  it('defaults to the offline demo: no service, the default model, no billed API', () => {
    expect(DEFAULT_SETTINGS.ai).toEqual({ provider: 'mock', model: '', models: [], baseUrl: '', apiKeyEnv: '', command: '', args: [], timeoutSeconds: 120, allowBilledApi: false, persona: 'playful' })
    expect(parseSettings({ voice: {} }).settings.ai).toEqual(DEFAULT_SETTINGS.ai)
  })
  it('accepts valid overrides', () => {
    const { settings, warnings } = parseSettings({
      ai: { provider: 'claude-cli', model: 'claude-haiku-5-5', command: '/opt/bin/claude', timeoutSeconds: 90, allowBilledApi: true }
    })
    expect(settings.ai).toEqual({ ...DEFAULT_SETTINGS.ai, provider: 'claude-cli', model: 'claude-haiku-5-5', command: '/opt/bin/claude', timeoutSeconds: 90, allowBilledApi: true })
    expect(warnings).toEqual([])
  })
  it.each(['mock', 'claude-cli', 'command', 'anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'ollama', 'lmstudio', 'custom'])('accepts provider %j', (provider) => {
    const { settings, warnings } = parseSettings({ ai: { provider } })
    expect(settings.ai.provider).toBe(provider)
    expect(warnings).toEqual([])
  })
  it.each(['sonnet[1m]', 'opus', 'claude-sonnet-5-5', 'gpt-4o', 'gemini-2.5-flash', 'openai/gpt-4o', 'llama3.2:latest', ''])('accepts model %j', (model) => {
    expect(parseSettings({ ai: { model } }).settings.ai.model).toBe(model)
  })
  it.each(['real', 'CLAUDE-CLI', '', 5, null, true])('an unknown provider %j falls back to mock with a warning', (bad) => {
    const { settings, warnings } = parseSettings({ ai: { provider: bad } })
    expect(settings.ai.provider).toBe('mock')
    expect(warnings).toHaveLength(1)
  })
  it.each(['--dangerously-skip-permissions', 'a b', 'x; rm -rf /', '$(id)', '../x', 'a'.repeat(90), 5, null])('rejects model %j', (bad) => {
    const { settings, warnings } = parseSettings({ ai: { model: bad } })
    expect(settings.ai.model).toBe('')
    expect(warnings).toHaveLength(1)
  })
  it.each(['rm -rf /', 'claude --flag', '../claude', '/usr/../bin/claude', 'bin/claude', '~/claude', '$HOME/claude', '/x;y', 5, null])('rejects command %j', (bad) => {
    const { settings, warnings } = parseSettings({ ai: { command: bad } })
    expect(settings.ai.command).toBe('')
    expect(warnings).toHaveLength(1)
  })
  it('accepts a command and its arguments (no shell is ever involved)', () => {
    const { settings, warnings } = parseSettings({ ai: { provider: 'command', command: 'gemini', args: ['-p', '{prompt}', '--model', '{model}'] } })
    expect(settings.ai).toMatchObject({ command: 'gemini', args: ['-p', '{prompt}', '--model', '{model}'] })
    expect(warnings).toEqual([])
    expect(parseSettings({ ai: { args: 'nope' } }).warnings).toHaveLength(1)
    expect(parseSettings({ ai: { args: [1] } }).settings.ai.args).toEqual([])
  })
  it.each(['https://api.example.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:8080', ''])('accepts baseUrl %j', (baseUrl) => {
    const { settings, warnings } = parseSettings({ ai: { baseUrl } })
    expect(settings.ai.baseUrl).toBe(baseUrl)
    expect(warnings).toEqual([])
  })
  it.each(['http://api.example.com/v1', 'ftp://x', 'localhost:1234', 'https://user:pw@x.com', 'javascript:alert(1)', 5])('rejects baseUrl %j (a key must not cross the network unencrypted)', (bad) => {
    const { settings, warnings } = parseSettings({ ai: { baseUrl: bad } })
    expect(settings.ai.baseUrl).toBe('')
    expect(warnings).toHaveLength(1)
  })
  it('apiKeyEnv is a variable NAME, never a key', () => {
    expect(parseSettings({ ai: { apiKeyEnv: 'MY_KEY' } }).settings.ai.apiKeyEnv).toBe('MY_KEY')
    const bad = parseSettings({ ai: { apiKeyEnv: 'sk-abc 123' } })
    expect(bad.settings.ai.apiKeyEnv).toBe('')
    expect(bad.warnings).toHaveLength(1)
  })
  it.each([0, 9, 601, NaN, Infinity, '45', null])('rejects timeoutSeconds %j', (bad) => {
    const { settings, warnings } = parseSettings({ ai: { timeoutSeconds: bad } })
    expect(settings.ai.timeoutSeconds).toBe(120)
    expect(warnings).toHaveLength(1)
  })
  it.each(['true', 1, null])('allowBilledApi must be a real boolean; %j stays off', (bad) => {
    const { settings, warnings } = parseSettings({ ai: { allowBilledApi: bad } })
    expect(settings.ai.allowBilledApi).toBe(false)
    expect(warnings).toHaveLength(1)
  })
  it('"ai" must be an object', () => {
    expect(parseSettings({ ai: 'yes' }).warnings).toHaveLength(1)
  })
})

describe('parseSettings: cat', () => {
  it('defaults to the standing figure at chunky pixels', () => {
    expect(DEFAULT_SETTINGS.cat).toEqual({ view: 'figure', coat: 'black', pixelSize: 2, bringWithMe: false, restAtHome: false, roam: 'edges' })
    expect(parseSettings({ voice: {} }).settings.cat).toEqual(DEFAULT_SETTINGS.cat)
  })
  it('accepts valid overrides', () => {
    const { settings, warnings } = parseSettings({ cat: { view: 'sprite', coat: 'orange', pixelSize: 1 } })
    expect(settings.cat).toEqual({ view: 'sprite', coat: 'orange', pixelSize: 1, bringWithMe: false, restAtHome: false, roam: 'edges' })
    expect(warnings).toEqual([])
  })
  it.each(['black', 'grey', 'orange', 'white', 'blue'])('accepts coat %s', (coat) => {
    expect(parseSettings({ cat: { coat } }).settings.cat.coat).toBe(coat)
  })
  it.each(['purple', '', 'Black', 5, null, 'constructor', '__proto__'])('rejects coat %j with a warning', (bad) => {
    const { settings, warnings } = parseSettings({ cat: { coat: bad } })
    expect(settings.cat.coat).toBe('black')
    expect(warnings).toHaveLength(1)
  })
  it.each(['2d', '3D', '', 1, null])('rejects view %j with a warning', (bad) => {
    const { settings, warnings } = parseSettings({ cat: { view: bad } })
    expect(settings.cat.view).toBe('figure')
    expect(warnings).toHaveLength(1)
  })
  it.each([0, 3, 5, 8, -1, 2.5, '2', null, NaN])('rejects pixelSize %j (only 1, 2, 4)', (bad) => {
    const { settings, warnings } = parseSettings({ cat: { pixelSize: bad } })
    expect(settings.cat.pixelSize).toBe(2)
    expect(warnings).toHaveLength(1)
  })
  it('"cat" must be an object', () => {
    expect(parseSettings({ cat: 'tabby' }).warnings).toHaveLength(1)
  })
})

describe('loadSettings', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'pet-settings-'))
    dirs.push(d)
    return d
  }
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it('creates the file with defaults on first run, then reads edits back', () => {
    const path = join(tmp(), 'sub', 'settings.json')
    expect(loadSettings(path).settings).toEqual(DEFAULT_SETTINGS)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(DEFAULT_SETTINGS)
    writeFileSync(path, JSON.stringify({ sleepAfterMs: 90_000 }))
    expect(loadSettings(path).settings.sleepAfterMs).toBe(90_000)
  })
  it('never overwrites a file it cannot parse', () => {
    const path = join(tmp(), 'settings.json')
    writeFileSync(path, '{ not json')
    const { settings, warnings } = loadSettings(path)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(warnings.length).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})

describe('parseSettings: screen', () => {
  it('defaults: on request only, the display the pet is on, password managers excluded', () => {
    expect(DEFAULT_SETTINGS.screen.enabled).toBe(true)
    expect(DEFAULT_SETTINGS.screen.display).toBe('pet')
    expect(DEFAULT_SETTINGS.screen.maxEdge).toBe(1568)
    expect(DEFAULT_SETTINGS.screen.excludeApps).toEqual(expect.arrayContaining(['1Password', 'Bitwarden', 'Keychain Access']))
  })
  it('accepts valid overrides', () => {
    const { settings, warnings } = parseSettings({ screen: { enabled: false, display: 'main', maxEdge: 1024, excludeApps: ['Banking', 'com.x.y'] } })
    expect(settings.screen).toEqual({ enabled: false, display: 'main', maxEdge: 1024, excludeApps: ['Banking', 'com.x.y'], allowUnchecked: false })
    expect(warnings).toEqual([])
  })
  it('an empty exclusion list is allowed (the user can remove the defaults)', () => {
    expect(parseSettings({ screen: { excludeApps: [] } }).settings.screen.excludeApps).toEqual([])
  })
  it.each([['display', 'all'], ['maxEdge', 100], ['maxEdge', 99999], ['maxEdge', '1568'], ['enabled', 'yes'], ['excludeApps', 'Bitwarden'], ['excludeApps', ['ok', 5]], ['excludeApps', ['']]])('rejects screen.%s = %j', (key, bad) => {
    const { settings, warnings } = parseSettings({ screen: { [key as string]: bad } })
    expect(settings.screen).toEqual(DEFAULT_SETTINGS.screen)
    expect(warnings).toHaveLength(1)
  })
  it('the look-at-screen shortcut is validated like the others', () => {
    expect(DEFAULT_SETTINGS.shortcuts.lookAtScreen).toBe('CommandOrControl+Alt+Shift+S')
    expect(parseSettings({ shortcuts: { lookAtScreen: 'Alt+Shift+K' } }).settings.shortcuts.lookAtScreen).toBe('Alt+Shift+K')
    expect(parseSettings({ shortcuts: { lookAtScreen: 'not valid' } }).warnings).toHaveLength(1)
  })
})

describe('parseSettings: observe and proactive', () => {
  it('everything that watches is off by default, with no rules', () => {
    expect(DEFAULT_SETTINGS.observe).toEqual({ enabled: false, intervalSeconds: 20, maxPerHour: 6, rules: [] })
    expect(DEFAULT_SETTINGS.proactive).toEqual({ enabled: false })
    expect(DEFAULT_SETTINGS.shortcuts.toggleWatch).toBe('CommandOrControl+Alt+Shift+W')
  })
  it('accepts a full rule and fills in the defaults of a short one', () => {
    const { settings, warnings } = parseSettings({
      observe: { enabled: true, intervalSeconds: 30, maxPerHour: 3, rules: [{ app: 'Mail', action: 'ask', minChange: 0.25, cooldownMinutes: 30, prompt: 'Summarise.' }, { app: ' Numbers ' }] },
      proactive: { enabled: true }
    })
    expect(warnings).toEqual([])
    expect(settings.observe.rules).toEqual([
      { app: 'Mail', action: 'ask', minChange: 0.25, cooldownMinutes: 30, prompt: 'Summarise.' },
      { app: 'Numbers', action: 'nudge', minChange: 0, cooldownMinutes: 10, prompt: 'What am I looking at here? Keep it brief.' }
    ])
    expect(settings.observe).toMatchObject({ enabled: true, intervalSeconds: 30, maxPerHour: 3 })
    expect(settings.proactive.enabled).toBe(true)
  })
  it.each([
    [{ app: '' }], [{ action: 'nudge' }], [{ app: 'x', action: 'delete' }], [{ app: 'x', minChange: 2 }], [{ app: 'x', minChange: 'a' }],
    [{ app: 'x', cooldownMinutes: 0 }], [{ app: 'x', cooldownMinutes: 5000 }], [{ app: 'x', prompt: '' }], [{ app: 'x', prompt: 'p'.repeat(501) }], ['Mail'], [null]
  ])('ignores the bad rule %j with a warning and keeps the settings', (rule) => {
    const { settings, warnings } = parseSettings({ observe: { rules: [rule] } })
    expect(settings.observe.rules).toEqual([])
    expect(warnings).toHaveLength(1)
  })
  it.each([['intervalSeconds', 4], ['intervalSeconds', 601], ['maxPerHour', 0], ['maxPerHour', 61], ['enabled', 'yes']])('rejects observe.%s = %j', (k, bad) => {
    const { settings, warnings } = parseSettings({ observe: { [k as string]: bad } })
    expect(settings.observe).toEqual(DEFAULT_SETTINGS.observe)
    expect(warnings).toHaveLength(1)
  })
  it('caps the number of rules', () => {
    expect(parseSettings({ observe: { rules: Array.from({ length: 31 }, () => ({ app: 'x' })) } }).warnings).toHaveLength(1)
  })
  it.each(['yes', 1, null])('proactive.enabled must be a real boolean; %j stays off', (bad) => {
    const { settings, warnings } = parseSettings({ proactive: { enabled: bad } })
    expect(settings.proactive.enabled).toBe(false)
    expect(warnings).toHaveLength(1)
  })
})

describe('parseSettings: where the cat lives', () => {
  it('defaults: a desktop pet that walks around the edges of your windows and does not follow you over other apps', () => {
    expect(DEFAULT_SETTINGS.cat.bringWithMe).toBe(false)
    expect(DEFAULT_SETTINGS.cat.roam).toBe('edges')
  })
  it('accepts the other choices', () => {
    const { settings, warnings } = parseSettings({ cat: { bringWithMe: true, roam: 'dock' } })
    expect(settings.cat).toMatchObject({ bringWithMe: true, roam: 'dock' })
    expect(warnings).toEqual([])
  })
  it.each([['bringWithMe', 'yes'], ['bringWithMe', 1], ['roam', 'sky'], ['roam', true]])('rejects cat.%s = %j', (k, bad) => {
    const { settings, warnings } = parseSettings({ cat: { [k as string]: bad } })
    expect(settings.cat.bringWithMe).toBe(false)
    expect(settings.cat.roam).toBe('edges')
    expect(warnings).toHaveLength(1)
  })
})

describe('parseSettings: resting at home', () => {
  it('off by default (he is a real app you open and quit); a boolean', () => {
    expect(DEFAULT_SETTINGS.cat.restAtHome).toBe(false)
    expect(parseSettings({ cat: { restAtHome: true } }).settings.cat.restAtHome).toBe(true)
    const bad = parseSettings({ cat: { restAtHome: 'no' } })
    expect(bad.settings.cat.restAtHome).toBe(false)
    expect(bad.warnings).toHaveLength(1)
  })
})

describe('parseSettings: speech and cross-platform paths', () => {
  it('speech defaults to automatic engine choice', () => {
    expect(DEFAULT_SETTINGS.speech).toEqual({ engine: 'auto', model: '' })
    expect(parseSettings({ speech: { engine: 'local', model: 'stt-en' } }).settings.speech).toEqual({ engine: 'local', model: 'stt-en' })
  })
  it.each([[{ engine: 'cloud' }], [{ model: '../x' }], [{ model: 5 }], ['yes']])('rejects speech %j', (bad) => {
    const r = parseSettings({ speech: bad })
    expect(r.warnings).toHaveLength(1)
    expect(r.settings.speech).toEqual(DEFAULT_SETTINGS.speech)
  })
  it('screen.allowUnchecked is a real boolean, off by default', () => {
    expect(DEFAULT_SETTINGS.screen.allowUnchecked).toBe(false)
    expect(parseSettings({ screen: { allowUnchecked: true } }).settings.screen.allowUnchecked).toBe(true)
    expect(parseSettings({ screen: { allowUnchecked: 'yes' } }).warnings).toHaveLength(1)
  })
  it.each(['/Users/me/mem', 'C:\\Users\\me\\mem', 'D:/data/mem', '\\\\server\\share\\mem', '/home/me/.config/DeskPet/memory'])('accepts the absolute path %j on any OS', (dir) => {
    const r = parseSettings({ memory: { dir }, voice: { local: { python: dir, modelsDir: dir } } })
    expect(r.warnings).toEqual([])
    expect(r.settings.memory.dir).toBe(dir)
  })
  it.each(['relative/path', '~/mem', '/a/../b', 'C:\\a\\..\\b', '..\\x', '.', 'mem'])('rejects the path %j', (dir) => {
    const r = parseSettings({ memory: { dir } })
    expect(r.warnings).toHaveLength(1)
    expect(r.settings.memory.dir).toBe('')
  })
  it('accepts a Windows program path for ai.command', () => {
    expect(parseSettings({ ai: { command: 'C:\\Program Files\\gemini\\gemini.exe' } }).settings.ai.command).toBe('C:\\Program Files\\gemini\\gemini.exe')
    expect(parseSettings({ ai: { command: 'C:\\a\\..\\gemini.exe' } }).warnings).toHaveLength(1)
  })
})
