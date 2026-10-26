// Shared by the setup tools (voices, speech, setup): where DeskPet keeps its data on each OS, the private Python environment
// the offline voices and speech recognition run in, downloads, and playing a sound file. Plain Node, no dependencies.
import { execFileSync, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'

/** The same folder Electron's app.getPath('userData') gives the app (DESKPET_DATA_DIR overrides both). */
export function dataDir() {
  if (process.env['DESKPET_DATA_DIR']) return process.env['DESKPET_DATA_DIR']
  if (isMac) return join(homedir(), 'Library', 'Application Support', 'DeskPet')
  if (isWin) return join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'DeskPet')
  return join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'DeskPet')
}
export const voicesDir = () => join(dataDir(), 'voices')
export const speechDir = () => join(dataDir(), 'speech')
export const venvDir = () => join(voicesDir(), 'venv')
export const venvPython = () => join(venvDir(), isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python')

export function die(msg) {
  console.error(msg)
  process.exit(1)
}

/** Pull `--name value` (or a bare `--name` flag) out of an argument list. */
export function flag(args, name, takesValue = false) {
  const i = args.indexOf(name)
  if (i < 0) return takesValue ? undefined : false
  if (!takesValue) {
    args.splice(i, 1)
    return true
  }
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

/** Python >= 3.9: DESKPET_PYTHON, python3.x, python3, python, or the Windows `py -3` launcher. */
function findPython() {
  const candidates = [
    ...(process.env['DESKPET_PYTHON'] ? [[process.env['DESKPET_PYTHON'], []]] : []),
    ...['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].map((c) => [c, []]),
    ...(isWin ? [['py', ['-3']]] : [])
  ]
  return candidates.find(([cmd, pre]) => spawnSync(cmd, [...pre, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { stdio: 'ignore' }).status === 0)
}

/** Create the private Python environment (sherpa-onnx pinned: newer releases changed the text frontend these models need). */
export function setupPython() {
  const py = venvPython()
  const ready = () => existsSync(py) && spawnSync(py, ['-c', 'import sherpa_onnx, numpy, sounddevice; assert sherpa_onnx.__version__ == "1.13.8"'], { stdio: 'ignore' }).status === 0
  if (ready()) return console.log(`The Python environment is ready (${venvDir()}).`)
  const found = findPython()
  if (!found) die('Python 3.9 or newer is needed for the offline voices and speech recognition (https://www.python.org, or your package manager). The system voices work without it.')
  mkdirSync(voicesDir(), { recursive: true })
  console.log(`Creating ${venvDir()} with ${found[0]} ...`)
  execFileSync(found[0], [...found[1], '-m', 'venv', venvDir()], { stdio: 'inherit' })
  console.log('Installing sherpa-onnx 1.13.8, numpy and sounddevice ...')
  execFileSync(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'sherpa-onnx==1.13.8', 'numpy', 'sounddevice'], { stdio: 'inherit' })
  if (!ready()) die('The Python environment could not be set up.')
  console.log('Ready.')
}

export async function download(url, to, label, progress) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    got += c.length
    const pct = total ? Math.floor((got / total) * 100) : -1
    if (progress && pct !== lastPct && pct % 10 === 0) {
      lastPct = pct
      process.stdout.write(`\r  ${label}: ${pct}%   `)
    }
  })
  await pipeline(body, createWriteStream(to))
  if (progress) process.stdout.write('\r' + ' '.repeat(label.length + 20) + '\r')
}

/**
 * Download a .tar.bz2 model archive from `url`, check that it unpacks to one folder holding what `verify(files)` accepts, mark it
 * installed and move it to `dest`. Uses the system `tar` (macOS, Linux and Windows 10+ all ship one that reads .bz2).
 */
export async function installArchive({ url, asset, dest, id, extra, verify, progress }) {
  const work = join(tmpdir(), `deskpet-dl-${process.pid}-${id}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  try {
    const archive = join(work, asset)
    await download(url, archive, id, progress)
    execFileSync('tar', ['-xjf', archive, '-C', work], { stdio: 'inherit' })
    const dirs = readdirSync(work).filter((n) => statSync(join(work, n)).isDirectory())
    if (dirs.length !== 1) throw new Error('unexpected archive layout')
    const extracted = join(work, dirs[0])
    if (!verify(readdirSync(extracted))) throw new Error('the download is missing model files')
    writeFileSync(join(extracted, '.deskpet-model.json'), JSON.stringify({ id, ...extra, installed: new Date().toISOString() }) + '\n')
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(join(dest, '..'), { recursive: true })
    renameSync(extracted, dest)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Run up to `n` jobs at a time; returns the ids that failed. */
export async function pool(items, n, fn) {
  const queue = [...items]
  const failures = []
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let v = queue.shift(); v; v = queue.shift()) {
        try {
          await fn(v)
        } catch (e) {
          failures.push(v.id)
          console.error(`  ${v.id}: FAILED (${e.message})`)
        }
      }
    })
  )
  return failures
}

/** Play a sound file with whatever the OS has. */
export function playFile(file) {
  if (isMac) return spawnSync('afplay', [file], { stdio: 'inherit' })
  if (isWin) return spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], { stdio: 'inherit' })
  for (const [cmd, args] of [['paplay', [file]], ['aplay', ['-q', file]], ['play', ['-q', file]], ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]]]) {
    if (spawnSync(cmd, ['--help'], { stdio: 'ignore' }).error?.code !== 'ENOENT') return spawnSync(cmd, args, { stdio: 'inherit' })
  }
  console.log(`(no audio player found; the sample is at ${file})`)
}
