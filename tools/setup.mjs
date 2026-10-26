#!/usr/bin/env node
// Interactive setup: choose which AI answers, store its API key in your system's secure storage, and (optionally) get offline voices
// and speech recognition. Works on macOS, Windows and Linux.
//   npm run setup                                   guided
//   npm run setup -- --show                         print the current choice
//   npm run setup -- --provider openai --model gpt-4o      non-interactive (the key is still asked for, or set the environment variable)
// Only the "ai" section of settings.json is touched (everything else is kept); the file is written atomically and a file
// that cannot be parsed is never overwritten. API keys are encrypted by the OS (Keychain / DPAPI / Linux keyring), never put in settings.json.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { dataDir } from './lib/common.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const presets = JSON.parse(readFileSync(join(root, 'src/services/ai/providers.json'), 'utf8'))
const settingsPath = process.env['PET_SETTINGS'] || join(dataDir(), 'settings.json')

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function readSettings() {
  if (!existsSync(settingsPath)) return {}
  try {
    const j = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('not a JSON object')
    return j
  } catch (e) {
    console.error(`Not changing ${settingsPath}: it cannot be parsed (${e.message}). Fix or delete it first.`)
    process.exit(1)
  }
}
function writeSettings(json) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(`${settingsPath}.tmp`, JSON.stringify(json, null, 2) + '\n')
  renameSync(`${settingsPath}.tmp`, settingsPath)
}

/**
 * Keys are encrypted by the operating system's own secure storage (macOS Keychain, Windows DPAPI, Linux keyring) through the app
 * itself: this runs the app once with no window (`--deskpet-key ...`) and sends the key on stdin, so it is never in a command line.
 */
function keyTool(action, account, input = '') {
  let bin
  try {
    bin = createRequire(import.meta.url)('electron')
  } catch {
    return { ok: false, error: 'Electron is not installed: run npm install' }
  }
  if (!existsSync(join(root, 'out/main/index.js'))) {
    console.log('Building the app once (needed to reach the secure storage) ...')
    spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, stdio: 'inherit' })
  }
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const r = spawnSync(bin, [root, '--deskpet-key', action, account], { cwd: root, input, encoding: 'utf8', env, timeout: 60_000 })
  const line = String(r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{'))
  try {
    return JSON.parse(line ?? '')
  } catch {
    return { ok: false, error: `the secure storage could not be reached${r.stderr ? ` (${String(r.stderr).trim().split('\n').pop()?.slice(0, 120)})` : ''}` }
  }
}
const hasKey = (account) => keyTool('has', account).has === true
const storeKey = (account, key) => keyTool('store', account, key)

/** Ask without echoing what is typed (a key). */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    const done = (v) => {
      stdin.setRawMode?.(false)
      stdin.off('data', onData)
      stdin.pause()
      process.stdout.write('\n')
      resolve(v)
    }
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') return done(buf)
        if (c === '\u0003') {
          stdin.setRawMode?.(false)
          process.exit(130)
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1)
        else if (c >= ' ') buf += c
      }
    }
    stdin.on('data', onData)
  })
}

async function checkConnection(preset, baseUrl, key) {
  if (preset.kind !== 'openai-compatible' && preset.kind !== 'anthropic') return null
  const url = (baseUrl || preset.baseUrl).replace(/\/+$/, '') + (preset.kind === 'anthropic' ? '/v1/models?limit=1' : '/models')
  const headers = preset.kind === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : key ? { authorization: `Bearer ${key}` } : {}
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    return res.ok ? 'ok' : res.status === 401 || res.status === 403 ? 'key-rejected' : `http-${res.status}`
  } catch {
    return 'unreachable'
  }
}

function printCurrent() {
  const ai = readSettings().ai ?? {}
  const p = presets.find((x) => x.id === (ai.provider ?? 'mock')) ?? presets[0]
  console.log(`ai.provider = "${ai.provider ?? 'mock'}"  (${p.label})`)
  if (ai.model) console.log(`ai.model    = "${ai.model}"`)
  if (p.needsKey) console.log(`API key     = ${hasKey(p.id) ? 'stored (encrypted by your system)' : process.env[p.keyEnv] ? `from $${p.keyEnv}` : 'NOT FOUND (run: npm run setup)'}`)
  console.log(`settings    = ${settingsPath}`)
}

if (argv.includes('--show')) {
  printCurrent()
  process.exit(0)
}

const ask = async (q, def = '') => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim() || def
  } finally {
    rl.close()
  }
}

console.log('\nDeskPet setup — choose which AI answers.\n')
let preset = presets.find((p) => p.id === arg('--provider'))
if (arg('--provider') && !preset) {
  console.error(`Unknown provider "${arg('--provider')}". Choices: ${presets.map((p) => p.id).join(', ')}`)
  process.exit(2)
}
if (!preset) {
  presets.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.label}\n      ${p.hint}`))
  const n = Number(await ask('\nNumber:', '1'))
  preset = presets[n - 1]
  if (!preset) {
    console.error('Not a choice.')
    process.exit(2)
  }
}

const ai = { ...(readSettings().ai ?? {}), provider: preset.id }
if (preset.kind === 'claude-cli') {
  const found = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim()
  if (found) console.log(`\nFound the claude command at ${found}. Make sure it is signed in (run: claude auth login).`)
  else console.log('\nThe `claude` command was not found. Install Claude Code (https://docs.claude.com/en/docs/claude-code) and run `claude auth login`, then DeskPet will use your Claude plan.')
}
if (preset.kind === 'command') {
  ai.command = await ask('\nProgram to run (name or full path):', ai.command ?? '')
  console.log('Arguments, separated by spaces (use {prompt} if the program takes the prompt as an argument; otherwise it is sent on stdin; {model} is replaced by the model name).')
  const args = await ask('Arguments:', Array.isArray(ai.args) ? ai.args.join(' ') : '')
  ai.args = args ? args.split(/\s+/) : []
}
if (preset.id === 'custom') ai.baseUrl = await ask('\nServer address (https://... or http://localhost:...):', ai.baseUrl ?? '')
if (preset.needsKey || (preset.id === 'custom' && (await ask('Does it need an API key? (y/n)', 'n')).toLowerCase().startsWith('y'))) {
  if (preset.id === 'custom' && !ai.apiKeyEnv) ai.apiKeyEnv = ''
  const interactive = Boolean(process.stdin.isTTY)
  const have = interactive || arg('--provider') ? hasKey(preset.id) : false
  const replace = !interactive ? false : have ? (await ask(`\nA key for "${preset.id}" is already stored. Replace it? (y/n)`, 'n')).toLowerCase().startsWith('y') : true
  let typed
  if (replace) {
    console.log(`\nPaste your ${preset.label} key (nothing is shown as you type). It is encrypted by your system's secure storage and never written to settings.json.`)
    console.log(`Prefer an environment variable? Press Enter on an empty line, export ${preset.keyEnv ?? 'YOUR_KEY_VAR'} (or name yours in "ai.apiKeyEnv"), and run this again.`)
    typed = (await askHidden('Key: ')).trim()
    if (typed) {
      const r = storeKey(preset.id, typed)
      console.log(r.ok ? '✓ Key stored.' : `✗ The key was not stored: ${r.error}`)
    }
  } else if (have) console.log('\nKeeping the stored key.')
  const state = await checkConnection(preset, ai.baseUrl, typed || (preset.keyEnv ? process.env[preset.keyEnv] : undefined))
  if (state === 'ok') console.log('\n✓ Connected: the service accepted the key.')
  else if (state === 'key-rejected') console.log('\n✗ The service rejected that key. Run this again with a valid one.')
  else if (state) console.log(`\n? Could not confirm the connection (${state}). You can still try it in the chat.`)
} else if (preset.kind === 'openai-compatible') {
  const state = await checkConnection(preset, ai.baseUrl, undefined)
  console.log(state === 'ok' ? '\n✓ The local server answered.' : `\n? The server at ${ai.baseUrl || preset.baseUrl} did not answer (${state}). Start it, then DeskPet will find it.`)
}
if (preset.kind !== 'mock') {
  const model = arg('--model') ?? (await ask(`\nModel (blank = ${preset.defaultModel || 'ask me later'}; you can switch any time in the chat with /model):`, ai.model ?? ''))
  ai.model = model
}

const json = readSettings()
json.ai = ai
writeSettings(json)
console.log(`\nSaved to ${settingsPath}.`)

if (!argv.includes('--no-voices') && process.stdin.isTTY) {
  console.log('\nVoices and talking: DeskPet can speak with offline neural voices (Kokoro, Piper) and understand you with offline speech recognition.')
  console.log(`(Skip this and it uses your system's voices${process.platform === 'darwin' ? ' and Apple speech recognition' : ''}.)`)
  const v = await ask('  1 = starter: a few voices + English speech recognition (~450 MB)\n  2 = big collection: 70+ voices in 40 languages + English speech recognition (~2.3 GB)\n  3 = skip\n  Choice:', '3')
  if (v === '1' || v === '2') {
    const run = (script, args) => spawnSync(process.execPath, [join(root, 'tools', script), ...args], { stdio: 'inherit' })
    run('voices.mjs', ['setup'])
    run('voices.mjs', ['install', ...(v === '2' ? ['--recommended'] : ['kokoro-int8-en-v0_19', 'piper-en_US-lessac-medium', 'piper-en_GB-alba-medium'])])
    run('speech.mjs', ['install', 'stt-en'])
  }
}
console.log('\nAll set. Start DeskPet with:  npm start   (or build the app with: npm run app)\n')
