// Screenshots of the chat panel and the pet (via DevTools; no screen-recording permission needed) in a few looks.
//   node tools/shot-chat.mjs        -> docs/shots/*.png
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9343
const userData = mkdtempSync(join(tmpdir(), 'pet-shot-'))
mkdirSync('docs/shots', { recursive: true })
const app = spawn('node_modules/.bin/electron-vite', ['preview'], {
  env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_E2E_PORT: String(PORT), PET_SAY_BIN: join(process.cwd(), 'tools/fake-say.mjs') },
  stdio: 'ignore'
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() } catch { return [] } }
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100) } }
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } } }
  static async open(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej }); return new Page(ws) }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); writeFileSync(file, Buffer.from(r.data, 'base64')) }
  async mouse(type, x, y) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
}
try {
  const pt = await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.title === 'Desktop pet'))
  const pet = await Page.open(pt)
  await pet.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(800)
  await pet.shot('docs/shots/pet.png')
  const [x, y] = (await pet.eval(`window.__cat3d ? window.__cat3d.bodyPoint() : null`)) ?? [50, 60]
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await pet.mouse(type, x, y)
  const ct = await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.title === 'Chat'))
  const chat = await Page.open(ct)
  await chat.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(600)
  const look = async (name, t) => {
    await chat.eval(`window.__setLook && window.__setLook(${JSON.stringify(t)})`)
    await sleep(300)
    await chat.shot(`docs/shots/chat-${name}.png`)
  }
  await chat.shot('docs/shots/chat-default-empty.png')
  // a small conversation
  await chat.eval(`document.getElementById('input').focus()`)
  await chat.send('Input.insertText', { text: 'hello there' })
  await chat.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await sleep(6500)
  await chat.shot('docs/shots/chat-default.png')
  await chat.eval(`document.getElementById('theme-btn').click()`)
  await sleep(300)
  await chat.shot('docs/shots/chat-drawer.png')
  const presets = await chat.eval(`document.querySelectorAll('.swatch').length`)
  for (const [i, name] of [[3, 'ocean'], [5, 'sakura'], [6, 'ghost']]) {
    await chat.eval(`document.querySelectorAll('.swatch')[${i}].click()`)
    await sleep(300)
    await chat.shot(`docs/shots/chat-${name}.png`)
  }
  console.log('shots written; presets:', presets)
} finally {
  try { const pid = execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n')[0]; if (pid) process.kill(Number(pid), 'SIGTERM') } catch {}
  await sleep(800)
  app.kill('SIGKILL')
  rmSync(userData, { recursive: true, force: true })
  process.exit(0)
}
