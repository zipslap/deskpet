// End-to-end check of "change your pet" in the real app, against the fake `claude` command (no network, no cost):
// the drawer, ready-made pets, undo, an AI-written design from text + pictures, the offline recolour, and persistence.
//   npm run e2e:pet
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9347
const userData = mkdtempSync(join(tmpdir(), 'deskpet-e2e-pet-'))
const FAKE = join(process.cwd(), 'tools/fake-claude.mjs')
const designDir = join(userData, 'ai-home', 'pet')
mkdirSync(designDir, { recursive: true })
let app = null
let failures = 0
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (cond, name, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === '' ? '' : '  -> ' + detail}`) }
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100) } }
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() } catch { return [] } }
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const x = this.p.get(d.id); if (x) { this.p.delete(d.id); d.error ? x.rej(new Error(d.error.message)) : x.res(d.result) } } }
  static async open(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b }); return new Page(ws) }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
  async mouse(type, x, y) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
}
let pet, chat
async function boot(settings) {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_DEBUG: '1', PET_USER_DATA: userData, PET_SLEEP_AFTER_MS: '600000', PET_REST: '0', PET_E2E_PORT: String(PORT), PET_SAY_BIN: join(process.cwd(), 'tools/fake-say.mjs') }, stdio: 'ignore' })
  pet = await Page.open(await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.title === 'Desktop pet')))
  await pet.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(1000)
  const [x, y] = (await pet.eval(`window.__cat3d.bodyPoint()`)) ?? [50, 60]
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await pet.mouse(type, x, y)
  chat = await Page.open(await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.title === 'Chat')))
  await chat.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(600)
}
async function quit() {
  if (!app) return
  const a = app; app = null
  a.kill('SIGTERM')
  await sleep(1500)
  try { process.kill(a.pid, 0); a.kill('SIGKILL') } catch {}
}
const skin = () => pet.eval(`document.getElementById('pet').dataset.skin ?? ''`)
const msg = () => chat.eval(`document.getElementById('pet-msg').textContent`)
const click = (id) => chat.eval(`document.getElementById(${JSON.stringify(id)}).click()`)
const setFake = (cfg) => writeFileSync(join(designDir, 'fake-claude.json'), JSON.stringify(cfg))
const calls = () => (existsSync(join(designDir, 'fake-claude-calls.jsonl')) ? readFileSync(join(designDir, 'fake-claude-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.argv[0] !== 'auth') : [])
const type = async (id, text) => chat.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAZ6+Cf1fzXPHAAAAAElFTkSuQmCC'

const settings = { ai: { provider: 'claude-cli', model: 'haiku', command: FAKE, timeoutSeconds: 15 }, memory: { enabled: false, write: false, summarize: false }, screen: { enabled: false } }
try {
  await boot(settings)
  ok((await skin()) === '', 'the pet starts as the default cat')
  ok(await chat.eval(`!!document.getElementById('pet-btn')`), 'the header has a "Change your pet" button')
  await click('pet-btn')
  ok(await waitFor(() => chat.eval(`!document.getElementById('petbar').hidden`), 3000), 'the button opens the drawer')
  ok(await waitFor(() => chat.eval(`document.querySelectorAll('#pet-presets button').length === 4`), 3000), 'four ready-made pets are offered')
  ok(await chat.eval(`document.getElementById('pet-go').disabled`), 'Transform is disabled until there is something to say')

  // ready-made pet + undo + reset
  await chat.eval(`[...document.querySelectorAll('#pet-presets button')].find((b) => b.textContent === 'Mermaid').click()`)
  ok(await waitFor(async () => (await skin()) === 'Mermaid', 4000), 'a ready-made pet is applied live (Mermaid)', await skin())
  ok(await waitFor(async () => /Mermaid/.test(await msg()), 3000), 'and the drawer says so', await msg())
  ok(existsSync(join(userData, 'pet.json')), 'the look is saved to pet.json')
  await click('pet-undo')
  ok(await waitFor(async () => (await skin()) === '', 4000), 'Undo returns to the default cat', await skin())
  await chat.eval(`[...document.querySelectorAll('#pet-presets button')].find((b) => b.textContent === 'Robot').click()`)
  await waitFor(async () => (await skin()) === 'Robot', 4000)
  await click('pet-reset')
  ok(await waitFor(async () => (await skin()) === '', 4000), '"Default cat" resets', await skin())

  // an AI-written design from text and pictures
  setFake({ mode: 'ok', delayMs: 5, reply: JSON.stringify({ name: 'Sea cat', note: 'Teal fur and a shell top.', palette: { fur: '#2fa59a', furHi: '#7fd8cc' }, parts: { torso: { shapes: [{ kind: 'ellipsoid', center: [0, 4.3, 1.3], radii: [1.2, 1, 0.8], color: '#f58ab4' }] } } }) })
  await chat.eval(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'inspo.png', { type: 'image/png' })); document.getElementById('petbar').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })) })()`)
  ok(await waitFor(() => chat.eval(`document.querySelectorAll('#pet-thumbs .thumb').length === 1`), 4000), 'a dropped picture appears as a thumbnail')
  await type('pet-text', 'turn my pet into a sea creature like this picture')
  ok(await chat.eval(`!document.getElementById('pet-go').disabled`), 'Transform is enabled once there is text')
  await click('pet-go')
  ok(await waitFor(async () => (await skin()) === 'Sea cat', 15000), 'the AI design is applied live', `${await skin()} | ${await msg()}`)
  ok(await waitFor(async () => /Teal fur/.test(await msg()), 3000), "and the AI's one-line note is shown", await msg())
  const c = calls().at(-1)
  ok(!!c && /"type":"image"/.test(c.stdin) && c.stdin.includes('sea creature'), 'the request carried the text and the picture to the AI', c ? c.stdin.slice(0, 160) : 'no call')
  ok(!!c && !c.argv.join(' ').includes('sea creature'), 'the request is never on the command line')
  ok(await waitFor(() => chat.eval(`document.getElementById('pet-text').value === '' && document.querySelectorAll('#pet-thumbs .thumb').length === 0`), 3000), 'the form is cleared after a success')

  // a bad design is sent back for correction, then fixed
  setFake({ mode: 'ok', delayMs: 5, reply: '{"palette":{"fur":"green"}}' })
  await type('pet-text', 'make it green')
  await click('pet-go')
  ok(await waitFor(async () => /could not be used/.test(await msg()), 25000), 'a design that keeps failing validation is reported, not applied', await msg())
  ok((await skin()) === 'Sea cat', 'and the pet keeps its previous look', await skin())
  ok(calls().length >= 4, 'the AI was asked again after the first rejection', String(calls().length))

  // typed in the chat
  setFake({ mode: 'ok', delayMs: 5, reply: JSON.stringify({ name: 'Chat cat', note: 'Done from the chat.', palette: { fur: '#aa44cc' } }) })
  await click('pet-done')
  await chat.eval(`(() => { const i = document.getElementById('input'); i.value = ''; i.focus() })()`)
  await chat.send('Input.insertText', { text: 'turn my pet into a purple wizard' })
  await chat.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  ok(await waitFor(async () => (await skin()) === 'Chat cat', 20000), 'saying "turn my pet into…" in the chat changes the pet', await skin())
  const bubbles = await chat.eval(`[...document.querySelectorAll('#log li')].map((l) => l.textContent)`)
  ok(bubbles.some((b) => /Your pet is now "Chat cat"/.test(b)), 'the chat reports it', JSON.stringify(bubbles.slice(-3)))

  // persistence
  await quit()
  await boot(settings)
  ok(await waitFor(async () => (await skin()) === 'Chat cat', 6000), 'the custom pet is still there after a restart', await skin())
  await quit()

  // without an AI: only a plain recolour, and the presets
  rmSync(join(userData, 'pet.json'), { force: true })
  await boot({ ai: { provider: 'mock' } })
  await click('pet-btn')
  await type('pet-text', "change my cat's skin to green")
  await click('pet-go')
  ok(await waitFor(async () => (await skin()) === 'Green cat', 5000), 'offline, "change my cat\'s skin to green" recolours it', await skin())
  ok(await chat.eval(`document.getElementById('pet-add').disabled`), 'adding pictures is off without an AI that can see them')
  await type('pet-text', 'turn it into a mermaid')
  await click('pet-go')
  ok(await waitFor(async () => /Connect an AI/.test(await msg()), 4000), 'offline, a full design explains how to connect an AI', await msg())
} catch (e) {
  failures++
  console.log('FAIL  script error:', e.stack ?? e)
} finally {
  await quit()
  rmSync(userData, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(failures === 0 ? 0 : 1)
}
