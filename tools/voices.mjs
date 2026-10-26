#!/usr/bin/env node
// Voice manager: sets up the local text-to-speech engine and downloads voice models.
//   node tools/voices.mjs setup                     create the Python environment (sherpa-onnx) used by the local voices
//   node tools/voices.mjs list [--installed] [--lang xx]
//   node tools/voices.mjs install <id...> | --recommended | --all | --lang en_GB
//   node tools/voices.mjs remove <id...>
//   node tools/voices.mjs try <id> ["text to say"] [--sid N] [--pitch 1.0]     audition a voice
//   node tools/voices.mjs path                      where everything is stored
// Everything lives under the app's data folder (override with DESKPET_DATA_DIR), never inside this repository. Works on macOS, Windows and Linux.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { die, flag, installArchive, playFile, pool, setupPython, venvPython, voicesDir as getVoicesDir } from './lib/common.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(join(root, 'assets/voices/catalog.json'), 'utf8'))
const voicesDir = getVoicesDir()
const modelsDir = join(voicesDir, 'models')
const python = venvPython()
const MARK = '.deskpet-model.json'

const find = (id) => catalog.voices.find((v) => v.id === id)
const isInstalled = (id) => existsSync(join(modelsDir, id, MARK))

function modelFilesOk(files, family) {
  const has = (re) => files.some((f) => re.test(f))
  if (!has(/\.onnx$/) || !has(/^tokens\.txt$/)) return false
  if (family === 'kokoro') return has(/^voices\.bin$/)
  return true
}

async function install(v, progress) {
  if (isInstalled(v.id)) return console.log(`  ${v.id}: already installed`)
  await installArchive({ url: catalog.downloadBase + v.asset, asset: v.asset, dest: join(modelsDir, v.id), id: v.id, extra: { family: v.family }, verify: (f) => modelFilesOk(f, v.family), progress })
  console.log(`  ${v.id}: installed (${v.mb} MB download)`)
}

function pick(args) {
  const all = flag(args, '--all')
  const rec = flag(args, '--recommended')
  const lang = flag(args, '--lang', true)
  let list = []
  if (all) list = catalog.voices
  else if (rec) list = catalog.voices.filter((v) => v.recommended)
  if (lang) list = [...list, ...catalog.voices.filter((v) => v.lang === lang || v.lang.startsWith(lang))]
  for (const id of args) {
    const v = find(id)
    if (!v) die(`Unknown voice "${id}". Run: node tools/voices.mjs list`)
    list.push(v)
  }
  return [...new Map(list.map((v) => [v.id, v])).values()]
}

const [cmd = 'help', ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'path':
    console.log(voicesDir)
    break
  case 'setup':
    setupPython()
    break
  case 'list': {
    const onlyInstalled = flag(rest, '--installed')
    const lang = flag(rest, '--lang', true)
    for (const v of catalog.voices) {
      if (onlyInstalled && !isInstalled(v.id)) continue
      if (lang && !(v.lang === lang || v.lang.startsWith(lang))) continue
      console.log(`${isInstalled(v.id) ? '✓' : ' '} ${v.recommended ? '★' : ' '} ${v.id.padEnd(46)} ${String(v.mb).padStart(4)} MB  ${v.label}`)
    }
    console.log(`\n✓ installed  ★ recommended set   (${voicesDir})`)
    break
  }
  case 'install': {
    const list = pick(rest)
    if (list.length === 0) die('Nothing to install. Give voice ids, or --recommended, --all or --lang xx_YY. See: node tools/voices.mjs list')
    const todo = list.filter((v) => !isInstalled(v.id))
    console.log(`${list.length - todo.length} already installed, ${todo.length} to download (~${todo.reduce((s, v) => s + v.mb, 0)} MB).`)
    const failures = await pool(todo, 3, (v) => install(v, todo.length === 1))
    if (failures.length) die(`${failures.length} download(s) failed: ${failures.join(', ')}. Run the same command again to retry them.`)
    console.log('Done.')
    break
  }
  case 'remove':
    for (const v of pick(rest)) {
      rmSync(join(modelsDir, v.id), { recursive: true, force: true })
      console.log(`removed ${v.id}`)
    }
    break
  case 'try': {
    const sid = flag(rest, '--sid', true) ?? '0'
    const pitch = flag(rest, '--pitch', true) ?? '1.0'
    const [id, ...words] = rest
    const v = id && find(id)
    if (!v) die('Usage: node tools/voices.mjs try <voice id> ["text"] [--sid N] [--pitch 1.0]')
    if (!isInstalled(v.id)) die(`${v.id} is not installed. Run: node tools/voices.mjs install ${v.id}`)
    if (!existsSync(python)) die('Run first: node tools/voices.mjs setup')
    const out = join(tmpdir(), `deskpet-try-${process.pid}.wav`)
    const text = words.join(' ') || 'Hello! This is how I sound. Pleased to meet you.'
    execFileSync(python, [join(root, 'native/tts/tts_server.py'), '--family', v.family, '--model', join(modelsDir, v.id), '--sid', sid, '--pitch', pitch, '--sample', text, '--out', out], { stdio: 'inherit' })
    playFile(out)
    rmSync(out, { force: true })
    break
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
}
