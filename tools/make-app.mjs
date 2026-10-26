// Builds ~/Applications/DeskPet.app: a real macOS app (Dock icon, Cmd+Q, "open it like Chrome") that runs this project's
// build. It is a copy of the Electron runtime (an APFS clone, so it takes no extra disk space) with its own name, icon and
// permission texts, and a tiny Resources/app/package.json that points at out/main/index.js here. So the app does not need
// to be rebuilt to pick up code changes, only `npm run build` (or `npm run build`) to refresh out/.
//   npm run app                      # builds the code and the icon, then (re)creates the app
//   npm run app -- --desktop         # ... and also puts a shortcut to it on the Desktop
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('npm run app builds a macOS .app, so it only runs on a Mac. On Windows and Linux start DeskPet with: npm start')
  process.exit(0)
}

const root = resolve(new URL('..', import.meta.url).pathname)
const dist = join(root, 'node_modules/electron/dist/Electron.app')
const dest = join(homedir(), 'Applications', 'DeskPet.app')
const icon = join(root, 'assets/icon/deskpet.icns')
if (!existsSync(dist)) throw new Error('node_modules/electron is not installed: run npm install')
if (!existsSync(icon)) throw new Error('assets/icon/deskpet.icns is missing: run node tools/make-icon.mjs')
if (!existsSync(join(root, 'out/main/index.js'))) throw new Error('out/main/index.js is missing: run npm run build')
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] })

mkdirSync(join(homedir(), 'Applications'), { recursive: true })
rmSync(dest, { recursive: true, force: true })
run('cp', '-cR', dist, dest) // -c: clone (copy-on-write) on APFS

const plist = join(dest, 'Contents/Info.plist')
const set = (key, type, value) => {
  try { run('plutil', '-replace', key, `-${type}`, value, plist) } catch { run('plutil', '-insert', key, `-${type}`, value, plist) }
}
set('CFBundleName', 'string', 'DeskPet')
set('CFBundleDisplayName', 'string', 'DeskPet')
set('CFBundleIdentifier', 'string', 'com.deskpet.app')
set('LSMultipleInstancesProhibited', 'bool', 'true')
set('NSMicrophoneUsageDescription', 'string', 'DeskPet listens only while you press the microphone button, to turn what you say into text.')
set('NSSpeechRecognitionUsageDescription', 'string', 'DeskPet turns what you say into text on this Mac.')
set('NSScreenCaptureUsageDescription', 'string', 'DeskPet looks at your screen only when you ask it to.')
set('NSAppleEventsUsageDescription', 'string', 'DeskPet asks Finder where the icons on your desktop are, so the pet can walk around them instead of over them. Nothing else is read.')
try { run('plutil', '-remove', 'ElectronAsarIntegrity', plist) } catch { /* not present */ }
cpSync(icon, join(dest, 'Contents/Resources/electron.icns')) // the file name Info.plist already points at

const app = join(dest, 'Contents/Resources/app')
mkdirSync(app)
// (Electron wants a *relative* "main", so it is a one-line file that imports this project's build. The app's data folder is chosen
// in src/main/index.ts, not by this name.)
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'deskpet', version: '1.0.0', type: 'module', main: 'main.mjs' }, null, 2) + '\n')
writeFileSync(join(app, 'main.mjs'), `import ${JSON.stringify(pathToFileURL(join(root, 'out/main/index.js')).href)}\n`)

run('codesign', '--force', '--deep', '--sign', '-', dest) // ad hoc: you built it, so it only ever runs on this Mac
console.log(`built ${dest}`)

// an optional shortcut on the Desktop (a plain symlink: delete it any time, the app is untouched)
if (process.argv.includes('--desktop')) {
  const shortcut = join(homedir(), 'Desktop', 'DeskPet.app')
  try { if (existsSync(shortcut) || lstatSync(shortcut)) unlinkSync(shortcut) } catch { /* none yet */ }
  try { symlinkSync(dest, shortcut); console.log(`shortcut ${shortcut}`) } catch (e) { console.log(`no Desktop shortcut (${e.message})`) }
}
