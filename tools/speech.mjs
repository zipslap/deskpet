#!/usr/bin/env node
// Offline speech recognition models (so you can talk to the pet on any OS). Same private Python environment as the voices.
//   node tools/speech.mjs list [--installed]
//   node tools/speech.mjs install <id...> | --recommended | --lang en
//   node tools/speech.mjs remove <id...>
//   node tools/speech.mjs try <id> <file.wav>        transcribe a recording (16-bit WAV) to check a model
//   node tools/speech.mjs path
// Models are stored in the app's data folder (DESKPET_DATA_DIR overrides), never in this repository.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { die, flag, installArchive, pool, setupPython, speechDir as getSpeechDir, venvPython } from './lib/common.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(join(root, 'assets/speech/catalog.json'), 'utf8'))
const modelsDir = join(getSpeechDir(), 'models')
const MARK = '.deskpet-model.json'
const find = (id) => catalog.models.find((m) => m.id === id)
const isInstalled = (id) => existsSync(join(modelsDir, id, MARK))

async function install(m, progress) {
  if (isInstalled(m.id)) return console.log(`  ${m.id}: already installed`)
  const ok = (f) => f.some((x) => /^encoder.*\.onnx$/.test(x)) && f.some((x) => /^decoder.*\.onnx$/.test(x)) && f.some((x) => /^joiner.*\.onnx$/.test(x)) && f.includes('tokens.txt')
  await installArchive({ url: catalog.downloadBase + m.asset, asset: m.asset, dest: join(modelsDir, m.id), id: m.id, extra: { family: m.family }, verify: ok, progress })
  console.log(`  ${m.id}: installed (${m.mb} MB download)`)
}

function pick(args) {
  const rec = flag(args, '--recommended')
  const lang = flag(args, '--lang', true)
  let list = rec ? catalog.models.filter((m) => m.recommended) : []
  if (lang) list = [...list, ...catalog.models.filter((m) => m.lang === lang)]
  for (const id of args) {
    const m = find(id)
    if (!m) die(`Unknown model "${id}". Run: node tools/speech.mjs list`)
    list.push(m)
  }
  return [...new Map(list.map((m) => [m.id, m])).values()]
}

const [cmd = 'help', ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'path':
    console.log(modelsDir)
    break
  case 'list': {
    const only = flag(rest, '--installed')
    for (const m of catalog.models) if (!only || isInstalled(m.id)) console.log(`${isInstalled(m.id) ? '✓' : ' '} ${m.recommended ? '★' : ' '} ${m.id.padEnd(16)} ${String(m.mb).padStart(4)} MB  ${m.label}`)
    console.log(`\n✓ installed  ★ recommended   (${modelsDir})`)
    break
  }
  case 'install': {
    const list = pick(rest)
    if (list.length === 0) die('Nothing to install. Give model ids, or --recommended or --lang xx. See: node tools/speech.mjs list')
    setupPython()
    const todo = list.filter((m) => !isInstalled(m.id))
    console.log(`${list.length - todo.length} already installed, ${todo.length} to download (~${todo.reduce((s, m) => s + m.mb, 0)} MB).`)
    const failures = await pool(todo, 2, (m) => install(m, todo.length === 1))
    if (failures.length) die(`${failures.length} download(s) failed: ${failures.join(', ')}. Run the same command again to retry.`)
    console.log('Done. Set "speech.model" in settings.json to choose one (the first installed English model is used by default).')
    break
  }
  case 'remove':
    for (const m of pick(rest)) {
      rmSync(join(modelsDir, m.id), { recursive: true, force: true })
      console.log(`removed ${m.id}`)
    }
    break
  case 'try': {
    const [id, wav] = rest
    const m = id && find(id)
    if (!m || !wav) die('Usage: node tools/speech.mjs try <model id> <file.wav>')
    if (!isInstalled(m.id)) die(`${m.id} is not installed. Run: node tools/speech.mjs install ${m.id}`)
    const r = spawnSync(venvPython(), [join(root, 'native/stt/stt_server.py'), '--model', join(modelsDir, m.id), 'transcribe', wav], { stdio: 'inherit' })
    process.exit(r.status ?? 1)
    break
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
}
