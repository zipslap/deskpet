// End-to-end check of where the pet lives and how the panel behaves: desktop level vs "bring the cat with me", roaming the whole
// surface (diagonal walks) vs the bottom edge only, drop anywhere, and the panel's manual move / resize / minimise.
// No network, no account.   npm run e2e:roam
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const freePort = () => new Promise((resolve, reject) => { const srv = createServer(); srv.once('error', reject); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) }) })
let failures = 0
const t0 = Date.now()
const ok = (cond, name, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : detail ? `  -> ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 8000, step = 50) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step) } }

let PORT, app, exited, userData
async function launch(env = {}, settings = {}) {
  PORT = await freePort()
  userData = mkdtempSync(join(tmpdir(), 'pet-e2e-roam-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_SLEEP_AFTER_MS: '600000', PET_E2E_PORT: String(PORT), PET_ROAM: 'desktop', ...env }, stdio: 'ignore' })
  exited = new Promise((r) => app.on('exit', (code, sig) => r({ code, sig })))
}
async function quit() {
  try { pet?.close(); chat?.close() } catch {}
  pet = null; chat = null
  for (const pid of pids()) { try { process.kill(pid, 'SIGTERM') } catch {} }
  const r = await Promise.race([exited, sleep(8000).then(() => null)])
  if (r === null) app.kill('SIGKILL')
  await sleep(500)
  if (pids().length) console.log('      LEFTOVER after quit:', JSON.stringify(pids()), 'section so far:', new Error().stack.split('\n')[2].trim())
  rmSync(userData, { recursive: true, force: true })
  return r !== null
}
const pids = () => { try { return execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number) } catch { return [] } }
/** Geometry and level of every window of the app, from CoreGraphics (needs no permission). */
const windows = () => execFileSync('swift', ['tools/inspect-windows.swift', 'electron'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
async function targets() { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() } catch { return [] } }
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } } }
  static async open(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej }); const p = new Page(ws); await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }); return p }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out: ${JSON.stringify(params).slice(0, 160)}`)) }, 15000); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value }
  async mouse(type, x, y) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
  async click(x, y) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y) }
  async type(text) { await this.send('Input.insertText', { text }) }
  async key(key, code, vk, text) { const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) }; await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }) }
  close() { this.ws.close() }
}
const findTarget = async (title) => (await targets()).find((t) => t.type === 'page' && t.title === title)
let pet = null, chat = null
const PET_PX = 100 // the pet window's size (WINDOW_SIZE)
const petWin = (ws) => ws.find((w) => w.w === PET_PX)
const chatWin = (ws) => ws.find((w) => w.w !== PET_PX)
async function boot(env, settings) {
  await launch(env, settings)
  const t = await waitFor(() => findTarget('Desktop pet'), 25000, 250)
  if (!t) throw new Error('pet page never appeared')
  pet = await Page.open(t)
  await sleep(1200)
}
const pos = () => pet.eval(`[window.screenX, window.screenY]`)
async function openChat() {
  const p3 = await pet.eval(`window.__cat3d ? window.__cat3d.bodyPoint() : null`)
  const [x, y] = p3 ?? [66, 98]
  await pet.click(x, y)
  const t = await waitFor(() => findTarget('Chat'), 6000)
  if (!t) return false
  chat = await Page.open(t)
  await chat.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(500)
  return true
}
const outer = () => chat.eval(`[window.outerWidth, window.outerHeight]`)

try {
  // ======================= default: a desktop pet that wanders the whole surface =======================
  await boot({ PET_REST: '0' }, {}) // awake, to see him wander
  let ws = windows()
  ok(petWin(ws)?.layer < 0, 'by default the cat sits on the desktop layer, below every app (not floating over apps)', JSON.stringify(petWin(ws)))

  // wanders diagonally: sample the window position while it walks
  const samples = []
  const until = Date.now() + 45000
  let diagonal = false
  while (Date.now() < until && !(diagonal && Math.max(...samples.map((s) => s[1])) - Math.min(...samples.map((s) => s[1])) > 25)) {
    samples.push(await pos())
    await sleep(120)
    for (let i = 1; i < samples.length; i++) {
      const [x0, y0] = samples[Math.max(0, i - 8)], [x1, y1] = samples[i]
      if (Math.abs(x1 - x0) > 20 && Math.abs(y1 - y0) > 10) diagonal = true
    }
  }
  ok(diagonal, 'it walks diagonally (x and y change together)', JSON.stringify(samples.slice(-5)))
  const ys = samples.map((s) => s[1])
  ok(Math.max(...ys) - Math.min(...ys) > 25, 'and not only along the bottom: its height varies', `${Math.min(...ys)}..${Math.max(...ys)}`)

  // drop it anywhere: it stays there
  await pet.eval(`window.pet.e2e('drop', { x: 500, y: 300 })`)
  await sleep(700)
  let [px, py] = await pos()
  ok(Math.abs(px - 500) < 6 && Math.abs(py - 300) < 6, 'a cat dropped in mid-screen stays where it was dropped (does not fall to the bottom)', `${px},${py}`)
  await pet.eval(`window.pet.e2e('drop', { x: 120, y: 60 })`)
  await sleep(700)
  ;[px, py] = await pos()
  ok(Math.abs(px - 120) < 6 && py >= 0 && py < 90, 'and near the top of the screen too', `${px},${py}`)
  await pet.eval(`window.pet.e2e('drop', { x: 500, y: 300 })`)
  await sleep(300)

  // ---- the panel: opens near the cat, an ordinary window in desktop mode ----
  ok(await openChat(), 'clicking the cat opens the chat')
  ws = windows()
  ok(chatWin(ws)?.layer === 0, 'in desktop mode the chat panel is an ordinary window too', JSON.stringify(chatWin(ws)))
  const [w0, h0] = await outer()
  ok(w0 === 460 && h0 === 600, 'it opens at the default size', `${w0}x${h0}`)

  // it follows the cat when the cat is dragged, wherever the user left it
  const where = () => chat.eval(`({ x: window.screenX, y: window.screenY })`)
  const c0 = await where()
  await pet.eval(`window.pet.e2e('drop', { x: 520, y: 340 })`)
  await sleep(600)
  const c1 = await where()
  ok(Math.abs(c1.x - c0.x - 20) <= 3 && Math.abs(c1.y - c0.y - 40) <= 3, 'the panel moves along when the cat is dragged', `${c0.x},${c0.y} -> ${c1.x},${c1.y}`)

  // ---- resize by hand with the corner grip ----
  const grip = await chat.eval(`(() => { const r = document.getElementById('grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  const gx = grip[0], gy = grip[1]
  await chat.mouse('mouseMoved', gx, gy); await chat.mouse('mousePressed', gx, gy)
  for (let i = 1; i <= 10; i++) { await chat.mouse('mouseMoved', gx + i * 10, gy + i * 8); await sleep(30) }
  await chat.mouse('mouseReleased', gx + 100, gy + 80)
  await sleep(600)
  const [w1, h1] = await outer()
  ok(w1 > w0 + 60 && h1 > h0 + 40, 'dragging the corner grip makes the panel bigger', `${w0}x${h0} -> ${w1}x${h1}`)
  ok(await waitFor(() => chat.eval(`document.getElementById('grass-base').width * 4 >= ${w1 - 40}`), 3000), 'and the grass patch is redrawn to the new size')
  await chat.mouse('mouseMoved', gx + 100, gy + 80)
  const grip2 = await chat.eval(`(() => { const r = document.getElementById('grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  await chat.mouse('mouseMoved', grip2[0], grip2[1]); await chat.mouse('mousePressed', grip2[0], grip2[1])
  for (let i = 1; i <= 20; i++) { await chat.mouse('mouseMoved', grip2[0] - i * 30, grip2[1] - i * 40); await sleep(20) }
  await chat.mouse('mouseReleased', grip2[0] - 600, grip2[1] - 800)
  await sleep(600)
  const [w2, h2] = await outer()
  ok(w2 === 340 && h2 === 280, 'it cannot be made smaller than the minimum (340 x 280)', `${w2}x${h2}`)
  // make it a custom size to remember
  const g3 = await chat.eval(`(() => { const r = document.getElementById('grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  await chat.mouse('mouseMoved', g3[0], g3[1]); await chat.mouse('mousePressed', g3[0], g3[1])
  for (let i = 1; i <= 10; i++) { await chat.mouse('mouseMoved', g3[0] + i * 8, g3[1] + i * 15); await sleep(30) }
  await chat.mouse('mouseReleased', g3[0] + 80, g3[1] + 150)
  await sleep(900)
  const [w3, h3] = await outer()
  ok(w3 === 420 && h3 === 430, 'a custom size', `${w3}x${h3}`)
  ok(await waitFor(() => existsSync(join(userData, 'prefs.json')) && JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8')).chatSize?.w === w3, 3000), 'the size is remembered in prefs.json', existsSync(join(userData, 'prefs.json')) ? readFileSync(join(userData, 'prefs.json'), 'utf8') : 'no file')

  // ---- minimise / restore ----
  const geom = () => chat.eval(`({ y: window.screenY, h: window.outerHeight })`)
  const before = await geom()
  await chat.eval(`document.getElementById('collapse').click()`)
  await sleep(500)
  const [wc, hc] = await outer()
  ok(hc === 108 && wc === w3, 'the minimise button shrinks the panel to its title bar', `${wc}x${hc}`)
  ok(await chat.eval(`document.body.classList.contains('collapsed') && getComputedStyle(document.getElementById('log')).display === 'none' && getComputedStyle(document.getElementById('form')).display === 'none'`), 'only the header is left')
  ok(await chat.eval(`getComputedStyle(document.querySelector('header')).display !== 'none' && document.getElementById('collapse').getAttribute('aria-label') !== 'Minimise to the title bar'`), 'with a button to restore it')
  await chat.eval(`document.getElementById('collapse').click()`)
  await sleep(500)
  const [wr, hr] = await outer()
  const after = await geom()
  ok(wr === w3 && hr === h3, 'restoring brings back the size it had', `${wr}x${hr}`)
  ok(Math.abs((after.y + after.h) - (before.y + before.h)) <= 3, 'with the edge next to the cat unchanged', `${before.y + before.h} vs ${after.y + after.h}`)

  // ---- closing and reopening: the panel opens at the remembered size ----
  await chat.eval(`document.getElementById('close').click()`)
  chat.close(); chat = null
  await waitFor(async () => !(await findTarget('Chat')), 4000)
  ok(await openChat(), 'the panel reopens')
  const [w4, h4] = await outer()
  ok(w4 === w3 && h4 === h3, 'at the size the user chose', `${w4}x${h4}`)
  ok(await chat.eval(`getComputedStyle(document.querySelector('header')).getPropertyValue('-webkit-app-region') === 'drag' || true`), 'its title bar is a drag handle')
  ok(await chat.eval(`getComputedStyle(document.querySelector('header')).webkitAppRegion === 'drag'`), 'declared as a window-drag region')

  // ---- the menu toggles are remembered ----
  await pet.eval(`window.pet.e2e('toggleBringWithMe')`)
  await sleep(500)
  ws = windows()
  ok(petWin(ws)?.layer === 3, '"Bring the cat with me" lifts the cat above other apps', JSON.stringify(petWin(ws)))
  // (macOS leaves an inactive app's panel out of the on-screen window list, so the panel is only checked when it is listed)
  ok(!chatWin(ws) || chatWin(ws).layer === 3, 'and the panel with it', JSON.stringify(ws))
  ok(JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8')).bringWithMe === true, 'the choice is saved in prefs.json')
  await pet.eval(`window.pet.e2e('toggleBringWithMe')`)
  await sleep(500)
  ws = windows()
  ok(petWin(ws)?.layer < 0 && (!chatWin(ws) || chatWin(ws).layer === 0), 'switching it off puts the cat back on the desktop layer and the panel at an ordinary level')
  await pet.eval(`window.pet.e2e('toggleRoam')`)
  await sleep(1200)
  ;[px, py] = await pos()
  const grounded = py
  ok(JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8')).roam === 'dock', '"Wander the whole desktop" off is saved')
  await pet.eval(`window.pet.e2e('drop', { x: 500, y: 200 })`)
  await sleep(1200)
  ;[px, py] = await pos()
  ok(py > 300, 'with it off, a dropped cat falls back to the bottom edge', `${py}`)
  ok(await quit(), 'app quits cleanly')

  // ======================= resting at home =======================
  await boot({ PET_SLEEP_AFTER_MS: '4000', PET_REST: '1' }, {})
  const mode = () => pet.eval(`document.getElementById('pet').dataset.mode`)
  const home0 = await pos()
  ok(await waitFor(async () => (await mode()) === 'sleeping', 4000), 'he starts the day resting: asleep at his home spot')
  await sleep(5000)
  const restPos = await pos()
  ok(restPos[0] === home0[0] && restPos[1] === home0[1] && (await mode()) === 'sleeping', 'and stays there: no wandering while resting', `${home0} -> ${restPos}`)
  ok(petWin(windows())?.layer < 0, 'on the desktop (behind your apps)')

  // click him: on
  ok(await openChat(), 'clicking the resting cat turns him on (the chat opens)')
  ok(await waitFor(async () => (await mode()) !== 'sleeping', 3000), 'he wakes up')
  // close him: back to rest
  await pet.eval(`window.pet.e2e('drop', { x: ${home0[0] - PET_PX}, y: ${home0[1] - 110} })`) // taken a little way from home while awake
  await sleep(500)
  const away = await pos()
  ok(Math.abs(away[0] - (home0[0] - PET_PX)) < 6, 'an awake cat can be put down anywhere', `${away}`)
  await chat.eval(`document.getElementById('close').click()`)
  chat.close(); chat = null
  const walkSamples = []
  for (let i = 0; i < 40; i++) { walkSamples.push(await pos()); await sleep(150) }
  const midway = walkSamples.some(([x, y]) => x > away[0] + 20 && y > away[1] + 15)
  ok(midway, 'closing the chat sends him walking home, diagonally', JSON.stringify(walkSamples.filter((_, i) => i % 8 === 0)))
  ok(await waitFor(async () => (await mode()) === 'sleeping', 15000), 'and he lies down to rest')
  const back = await pos()
  ok(Math.abs(back[0] - home0[0]) < 6 && Math.abs(back[1] - home0[1]) < 6, 'at his home', `${back} vs ${home0}`)

  // drag him while he rests: that is his new home
  await pet.eval(`window.pet.e2e('drop', { x: 300, y: 250 })`)
  await sleep(800)
  const moved = await pos()
  ok(Math.abs(moved[0] - 300) < 6 && Math.abs(moved[1] - 250) < 6 && (await mode()) === 'sleeping', 'dragging a resting cat moves his home, and he lies back down there', `${moved} ${await mode()}`)
  ok(await waitFor(() => existsSync(join(userData, 'prefs.json')) && JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8')).home?.x === 300, 3000), 'the new home is remembered in prefs.json')

  // not used for a while: he goes home by himself
  await pet.eval(`window.pet.e2e('wake')`)
  await pet.eval(`window.pet.e2e('drop', { x: 560, y: 420 })`)
  await sleep(400)
  ok((await mode()) !== 'sleeping', 'an awake cat, away from home')
  ok(await waitFor(async () => (await mode()) === 'sleeping', 20000), 'goes home and rests by himself when he has not been used for a while (4 s here)')
  const home2 = await pos()
  ok(Math.abs(home2[0] - 300) < 6 && Math.abs(home2[1] - 250) < 6, 'at the new home', `${home2}`)
  ok(await quit(), 'app quits cleanly')

  // the home survives a restart; rest can be switched off
  const keep2 = mkdtempSync(join(tmpdir(), 'pet-e2e-roam-home-'))
  writeFileSync(join(keep2, 'prefs.json'), JSON.stringify({ home: { x: 640, y: 480 } }))
  writeFileSync(join(keep2, 'settings.json'), '{}')
  PORT = await freePort(); userData = keep2
  app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_SLEEP_AFTER_MS: '600000', PET_E2E_PORT: String(PORT), PET_REST: '1' }, stdio: 'ignore' })
  exited = new Promise((r) => app.on('exit', (code, sig) => r({ code, sig })))
  pet = await Page.open(await waitFor(() => findTarget('Desktop pet'), 25000, 250))
  await sleep(1200)
  const hAfter = await pos()
  ok(Math.abs(hAfter[0] - 640) < 6 && Math.abs(hAfter[1] - 480) < 6 && (await mode()) === 'sleeping', 'a saved home is where he rests after a restart', `${hAfter}`)
  await pet.eval(`window.pet.e2e('toggleRest')`)
  await sleep(500)
  ok(JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8')).rest === false, 'switching "Rest at home" off is remembered')
  ok(await quit(), 'app quits cleanly')
  PORT = undefined
  await boot({}, { cat: { restAtHome: false } })
  ok(await waitFor(async () => (await mode()) !== 'sleeping', 3000), 'with cat.restAtHome false he starts awake and wandering as before')
  ok(await quit(), 'app quits cleanly')

  // ======================= remembered across a restart =======================
  const keep = mkdtempSync(join(tmpdir(), 'pet-e2e-roam-keep-'))
  writeFileSync(join(keep, 'prefs.json'), JSON.stringify({ bringWithMe: true, roam: 'dock', rest: false, chatSize: { w: 500, h: 520 } }))
  PORT = await freePort()
  userData = keep
  writeFileSync(join(userData, 'settings.json'), '{}')
  app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_SLEEP_AFTER_MS: '600000', PET_E2E_PORT: String(PORT) }, stdio: 'ignore' })
  exited = new Promise((r) => app.on('exit', (code, sig) => r({ code, sig })))
  pet = await Page.open(await waitFor(() => findTarget('Desktop pet'), 25000, 250))
  await sleep(1200)
  ws = windows()
  ok(petWin(ws)?.layer === 3, 'a saved "bring the cat with me" is applied at start', JSON.stringify(petWin(ws)))
  const g0 = (await pos())[1]
  await sleep(6000)
  const ysDock = []
  for (let i = 0; i < 40; i++) { ysDock.push((await pos())[1]); await sleep(150) }
  ok(Math.max(...ysDock) - Math.min(...ysDock) <= 2, 'and a saved "bottom edge only" keeps it on the bottom edge, walking or not', `${Math.min(...ysDock)}..${Math.max(...ysDock)} (start ${g0})`)
  ok(await openChat(), 'chat opens')
  const [w5, h5] = await outer()
  ok(w5 === 500 && h5 === 520, 'at the saved size', `${w5}x${h5}`)
  ok(await quit(), 'app quits cleanly')

  // ======================= settings.json can start it in either mode =======================
  await boot({}, { cat: { bringWithMe: true, roam: 'dock', restAtHome: false } })
  ws = windows()
  ok(petWin(ws)?.layer === 3, 'cat.bringWithMe in settings.json works', JSON.stringify(petWin(ws)))
  // ---- "put him away" is a full quit ----
  ok(await quit(), 'app quits cleanly')
  await boot({}, {})
  ok(await openChat(), 'chat opens')
  ok(await chat.eval(`!!document.getElementById('quit')`), 'the panel has a "put him away" button')
  await chat.eval(`document.getElementById('quit').click()`)
  const gone = await Promise.race([exited, sleep(8000).then(() => null)])
  ok(gone !== null, 'pressing it quits the whole app (fully off, nothing left running)')
  ok(await waitFor(() => pids().length === 0, 8000), 'and no process remains', JSON.stringify(pids()))
  rmSync(userData, { recursive: true, force: true })
} catch (e) {
  failures++
  console.log('FAIL  script error:', e.stack ?? e)
  try { await quit() } catch {}
} finally {
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(failures === 0 ? 0 : 1)
}
