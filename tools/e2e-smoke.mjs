// Cross-platform smoke test of the real app (Electron + both renderers), for macOS, Linux (under xvfb) and Windows.
// The full suites (e2e, e2e:roam) read the OS window list with a macOS-only tool, so this one sticks to what every platform
// can answer: the pages load, the cat is drawn, clicking it opens the chat, a message gets a streamed reply, the state
// machine runs thinking -> speaking -> curious, settings land on disk, and the app quits without leaving processes behind.
//   npm run e2e:smoke
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PET_PX = 100
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
})
const userData = mkdtempSync(join(tmpdir(), 'pet-smoke-'))
const lines = []
let failures = 0
const t0 = Date.now()
const ok = (cond, name, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : detail ? `  -> ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return null
    await sleep(step)
  }
}

// PET_SMOKE_BIN=<path to the packaged DeskPet executable> checks a built download (npm run dist) instead of the source tree.
const packaged = process.env['PET_SMOKE_BIN']
const bin = packaged || join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
const app = spawn(bin, packaged ? [] : ['preview'], {
  // (.cmd shims need a shell on Windows)
  shell: !packaged && process.platform === 'win32',
  env: {
    ...process.env,
    PET_E2E: '1', PET_DEBUG: '1', PET_USER_DATA: userData, PET_E2E_PORT: String(PORT),
    PET_SLEEP_AFTER_MS: '600000', PET_REST: '0', PET_ROAM: 'desktop', PET_VOICE_LIVE: '0', PET_CHAT_TIMEOUT_MS: '4000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let stderr = ''
app.stderr.on('data', (d) => (stderr += d))
let buf = ''
app.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (l.startsWith('{')) try { lines.push(JSON.parse(l)) } catch {}
  }
})
const exited = new Promise((r) => app.on('exit', (code, sig) => r({ code, sig })))
const states = () => lines.filter((l) => l.event === 'state')
const modesSince = (t) => states().filter((l) => l.t >= t).map((l) => l.mode)

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() } catch { return [] }
}
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } } }
  static async open(t) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const p = new Page(ws)
    await p.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    return p
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)) }, 10000); this.pending.set(id, { res: (v) => { clearTimeout(timer); res(v) }, rej: (e) => { clearTimeout(timer); rej(e) } }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value }
  async mouse(type, x, y) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
  async click(x, y) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y) }
  async type(text) { await this.send('Input.insertText', { text }) }
  async key(key, code, vk, text) { const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) }; await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }) }
  close() { this.ws.close() }
}
const findTarget = async (title) => (await targets()).find((t) => t.type === 'page' && t.title === title)

let pet, chat
try {
  console.log(`platform ${process.platform} ${process.arch}, node ${process.version}`)
  const petTarget = await waitFor(() => findTarget('Desktop pet'), 40000, 250)
  ok(!!petTarget, 'pet window loads and exposes its page')
  if (!petTarget) throw new Error('pet page never appeared; stderr:\n' + stderr.slice(-2000))
  pet = await Page.open(petTarget)
  await waitFor(() => states().length > 0, 8000)
  ok(states().length > 0, 'the main process reports the pet state')

  const view = await waitFor(() => pet.eval(`document.getElementById('pet') && document.getElementById('pet').dataset.view`), 10000)
  ok(view === '3d' || view === 'sprite', 'the pet is drawn (3D cat, or the 2D fallback)', String(view))
  if (view === '3d') {
    const f0 = Number(await pet.eval(`window.__cat3d.frames()`))
    await sleep(1000)
    const f1 = Number(await pet.eval(`window.__cat3d.frames()`))
    ok(f1 - f0 >= 5, '3D cat is animating (software rendering is allowed to be slow)', `${f1 - f0} frames in 1 s`)
    const st = await pet.eval(`window.__cat3d.stats()`)
    ok(st.opaque > 300, 'the cat actually covers pixels (not a blank canvas)', JSON.stringify(st))
  } else {
    console.log('NOTE  3D view unavailable here, so the 2D fallback is shown')
    console.log('--- app stderr (tail) ---\n' + stderr.slice(-2500))
    console.log('--- renderer console ---\n' + lines.filter((l) => l.event === 'renderer-console').map((l) => l.message).join('\n').slice(-1500))
  }

  ok(existsSync(join(userData, 'settings.json')), 'settings.json is created in the data folder')
  const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  ok(saved.voice?.autoSend === false && saved.voice?.allowServerRecognition === false, 'voice defaults are the safe ones')

  // ---- open the chat by clicking the cat ----
  const point = (view === '3d' && (await pet.eval(`window.__cat3d.bodyPoint()`))) || [PET_PX / 2, PET_PX / 2]
  await pet.click(point[0], point[1])
  const ct = await waitFor(() => findTarget('Chat'), 8000)
  ok(!!ct, 'clicking the cat opens the chat panel')
  if (!ct) throw new Error('chat never opened')
  chat = await Page.open(ct)
  ok(!!(await waitFor(() => chat.eval(`document.activeElement && document.activeElement.id === 'input'`), 5000)), 'the message box has focus')

  // ---- a message gets a streamed reply ----
  const t = Date.now()
  await chat.eval(`(() => { const i = document.getElementById('input'); i.value = ''; i.focus() })()`)
  await chat.type('hello pet')
  await chat.key('Enter', 'Enter', 13, '\r')
  await waitFor(async () => (await chat.eval(`document.getElementById('action').getAttribute('aria-label')`)) === 'Stop', 3000)
  ok(await waitFor(async () => (await chat.eval(`document.getElementById('action').getAttribute('aria-label')`)) === 'Send', 15000), 'the reply finishes and Send comes back')
  const bubbles = await chat.eval(`[...document.querySelectorAll('#log li')].map(li => li.className + '|' + li.textContent)`)
  ok(bubbles[0] === 'user|hello pet' && String(bubbles[1]).startsWith('assistant|Mock reply: you said "hello pet"'), 'the transcript shows the message and the streamed reply', JSON.stringify(bubbles))
  const seq = modesSince(t)
  ok(seq[0] === 'thinking' && seq.at(-1) === 'curious' && seq.includes('speaking'), 'pet goes thinking -> speaking -> curious', seq.join())

  // ---- the Set up drawer: connect an AI without a terminal ----
  await chat.eval(`document.getElementById('setup-btn').click()`)
  ok(!!(await waitFor(() => chat.eval(`!document.getElementById('setupbar').hidden && document.querySelectorAll('#setup-provider option').length >= 10`), 5000)), 'the Set up drawer opens and lists the services')
  const pick = (id) => chat.eval(`(() => { const s = document.getElementById('setup-provider'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')) })()`)
  const shown = (id) => chat.eval(`!document.getElementById(${JSON.stringify(id)}).hidden`)
  await pick('openai')
  ok((await shown('setup-key-row')) && !(await shown('setup-url-row')), 'a hosted service asks for a key, not an address')
  await pick('ollama')
  ok(!(await shown('setup-key-row')), 'a local server asks for no key')
  await pick('command')
  ok((await shown('setup-cmd-row')) && (await shown('setup-args-row')), 'a command-line assistant asks for the command')
  await pick('custom')
  await chat.eval(`(() => { const u = document.getElementById('setup-url'); u.value = 'http://example.com/v1'; document.getElementById('setup-test').click() })()`)
  ok(!!(await waitFor(() => chat.eval(`/https/.test(document.getElementById('setup-msg').textContent)`), 5000)), 'an unsafe server address is refused before any key could be sent')
  await pick('ollama')
  await chat.eval(`document.getElementById('setup-save').click()`)
  ok(!!(await waitFor(() => lines.some((l) => l.event === 'setup-restart'), 5000, 100)), 'saving asks the app to restart (suppressed in tests)')
  const after = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  ok(after.ai?.provider === 'ollama' && after.voice?.autoSend === false, 'the choice is written to settings.json and everything else is kept', JSON.stringify(after.ai))
  await chat.eval(`document.getElementById('setup-done').click()`)
  ok(await chat.eval(`document.getElementById('setupbar').hidden`), 'Done closes the drawer')

  // ---- Esc closes the chat, the pet carries on ----
  await chat.key('Escape', 'Escape', 27).catch(() => {}) // the window may go away before it answers
  ok(!!(await waitFor(async () => !(await findTarget('Chat')), 5000)), 'Esc closes the chat panel')
  chat.close(); chat = null
  ok(!!(await findTarget('Desktop pet')), 'and the pet window is still there')
} catch (e) {
  failures++
  console.log('FAIL  script error: ' + e.stack)
} finally {
  try { pet?.close(); chat?.close() } catch {}
  // ask the app to quit the way the OS would; Windows has no SIGTERM, so it is ended outright there
  app.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
  const r = await Promise.race([exited, sleep(10000).then(() => null)])
  ok(r !== null, 'the app exits when asked to quit')
  if (r === null) app.kill('SIGKILL')
  const bad = lines.filter((l) => l.event === 'renderer-console' && !/Context Lost|GPU|WebGL|swiftshader/i.test(l.message))
  ok(bad.length === 0, 'no renderer console warnings or errors', JSON.stringify(bad.slice(0, 3)))
  if (failures) console.log('\n--- app stderr (tail) ---\n' + stderr.slice(-3000))
  try { rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {} // (Windows keeps files locked for a moment after exit)
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(failures === 0 ? 0 : 1)
}
