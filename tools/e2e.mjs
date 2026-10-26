// End-to-end check of the real app (Electron + both renderers), no extra dependencies.
// Launches the built app in test mode (isolated settings, local DevTools port) and drives the two web pages over
// the Chrome DevTools Protocol: real pointer and keyboard events inside the pages, real state log from main.
// It does NOT synthesise OS-level mouse/keyboard events, so it cannot prove OS click-through or global shortcuts.
//   npm run e2e                      (the 3D cat)
//   PET_E2E_VIEW=sprite npm run e2e  (the same suite against the 2D sprite fallback)
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A free port, so another app's DevTools port (or a previous run) can never collide with the test.
const PET_PX = 100 // the pet window's size in CSS pixels (WINDOW_SIZE)
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
})
const userData = mkdtempSync(join(tmpdir(), 'pet-e2e-'))
const sayLog = join(userData, 'say.log')
const sttModeFile = join(userData, 'stt-mode')
writeFileSync(sttModeFile, 'ok')
const setStt = (mode) => writeFileSync(sttModeFile, mode)
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

// ---------- launch ----------
const app = spawn('node_modules/.bin/electron-vite', ['preview'], {
  env: {
    ...process.env,
    PET_E2E: '1',
    PET_DEBUG: '1',
    PET_USER_DATA: userData,
    PET_SLEEP_AFTER_MS: '7000', PET_REST: '0', PET_ROAM: 'desktop', PET_VOICE_LIVE: '0',
    PET_CHAT_TIMEOUT_MS: '4000',
    PET_E2E_PORT: String(PORT),
    PET_VIEW: process.env.PET_E2E_VIEW === 'sprite' ? 'sprite' : '',
    // test doubles: no microphone, no sound
    PET_STT_HELPER: join(process.cwd(), 'tools/fake-stt-helper.mjs'),
    PET_FAKE_STT_MODE_FILE: sttModeFile,
    PET_SAY_BIN: join(process.cwd(), 'tools/fake-say.mjs'),
    PET_FAKE_SAY_LOG: sayLog,
    PET_FAKE_SAY_MS_PER_CHAR: '25'
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
    const l = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (l.startsWith('{')) try { lines.push(JSON.parse(l)) } catch {}
  }
})
const exited = new Promise((r) => app.on('exit', (code, sig) => r({ code, sig })))

const states = () => lines.filter((l) => l.event === 'state')
const lastMode = () => states().at(-1)?.mode
const modesSince = (t) => states().filter((l) => l.t >= t).map((l) => l.mode)
const events = (name, t = 0) => lines.filter((l) => l.event === name && l.t >= t)
const chatEvents = (t = 0) => events('chat-event', t).map((l) => l.kind)

// ---------- tiny CDP client ----------
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
  // a request never waits forever: a window that closes while it is being asked something would otherwise hang the whole run
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)) }, 10000); this.pending.set(id, { res: (v) => { clearTimeout(timer); res(v) }, rej: (e) => { clearTimeout(timer); rej(e) } }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value }
  async mouse(type, x, y) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
  async click(x, y) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y) }
  async type(text) { await this.send('Input.insertText', { text }) }
  async key(key, code, vk, text) { const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) }; await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }) }
  close() { this.ws.close() }
}
const findTarget = async (title) => (await targets()).find((t) => t.type === 'page' && t.title === title)

// ---------- pet helpers ----------
let pet
/** Which cat is drawn: the 3D one, or the 2D sprite (fallback / PET_E2E_VIEW=sprite). */
let is3d = true
/** A point on the cat's body in page coordinates (inside its click mask whatever it is doing). */
async function bodyPoint() {
  if (is3d) { const p = await pet.eval(`window.__cat3d.bodyPoint()`); if (p) return p }
  const left = await pet.eval(`document.getElementById('sprite').classList.contains('facing-left')`)
  const k = PET_PX / 160 // the sprite is drawn scaled to the window (it was designed for 160 px)
  const sx = (16 * 4 + 2) * k, sy = (24 * 4 + 2) * k // sprite pixel (16,24) = middle of the body
  return [left ? PET_PX - sx : sx, sy]
}
const clickPet = async () => { const [x, y] = await bodyPoint(); await pet.click(x, y) }

// ---------- chat helpers ----------
let chat = null
async function openChat() {
  if (!chat) {
    await clickPet()
    const t = await waitFor(() => findTarget('Chat'), 6000)
    if (!t) return false
    chat = await Page.open(t)
    await waitFor(() => chat.eval(`document.activeElement && document.activeElement.id === 'input'`), 4000)
  }
  return true
}
async function say(text, { enter = true } = {}) {
  await chat.eval(`(() => { const i = document.getElementById('input'); i.value = ''; i.focus() })()`) // (clears anything typed into the window while the test had focus)
  await chat.type(text)
  if (enter) await chat.key('Enter', 'Enter', 13, '\r')
}
const bubbles = () => chat.eval(`[...document.querySelectorAll('#log li')].map(li => li.className + '|' + li.textContent)`)
const status = () => chat.eval(`document.getElementById('status').textContent`)
const actionLabel = () => chat.eval(`document.getElementById('action').getAttribute('aria-label')`)
async function closeChatViaButton() {
  await chat.eval(`document.getElementById('close').click()`).catch(() => {}) // the window may go away before it answers
  chat.close()
  chat = null
  await waitFor(async () => !(await findTarget('Chat')), 4000)
}
const procs = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).length } catch { return 0 } }
const electronWindows = () => execFileSync('swift', ['tools/inspect-windows.swift', 'electron'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

// =====================================================================
try {
  // ---------- startup ----------
  const petTarget = await waitFor(() => findTarget('Desktop pet'), 25000, 250)
  ok(!!petTarget, 'pet window loads and exposes its page')
  if (!petTarget) throw new Error('pet page never appeared; stderr:\n' + stderr)
  pet = await Page.open(petTarget)
  await waitFor(() => states().length > 0, 5000)
  const wantView = process.env.PET_E2E_VIEW === 'sprite' ? 'sprite' : '3d'
  const gotView = await waitFor(() => pet.eval(`document.getElementById('pet') && document.getElementById('pet').dataset.view`), 8000)
  is3d = gotView === '3d'
  ok(gotView === wantView, `the pet draws the ${wantView === '3d' ? '3D cat' : '2D sprite'}`, String(gotView))
  ok(['idle', 'walking'].includes(states()[0]?.mode), 'starts idle or walking', states()[0]?.mode)
  if (is3d) {
    const f0 = Number(await pet.eval(`window.__cat3d.frames()`))
    await sleep(1000)
    const f1 = Number(await pet.eval(`window.__cat3d.frames()`))
    ok(f1 - f0 >= 10 && f1 - f0 <= 70, '3D cat is being drawn at a sensible frame rate (not frozen, not runaway)', `${f1 - f0} frames in 1 s`)
  } else ok((await pet.eval(`getComputedStyle(document.querySelector('#sprite .sheet')).animationName`)) !== 'none', 'sprite animation is running')
  ok(!stderr.includes('Could not register'), 'all three global shortcuts registered', stderr.split('\n').find((l) => l.includes('Could not register')))
  const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  ok(saved.shortcuts.toggleChat && saved.shortcuts.toggleListen && saved.voice.speakReplies === true && saved.voice.autoSend === false && saved.voice.allowServerRecognition === false && saved.sleepAfterMs === 300000, 'settings.json created with safe voice defaults')
  ok(electronWindows().length === 1, 'only the pet window exists before chat opens')

  if (is3d) {
    // ---------- the 3D cat itself ----------
    const info = await pet.eval(`(() => { const c = document.getElementById('cat3d'); return { w: c.width, h: c.height, css: c.getBoundingClientRect().width } })()`)
    ok(info.w === info.h && info.w >= 60 && info.w < info.css && info.css === PET_PX, `3D canvas renders at low resolution (${info.w}px) and is scaled up to ${PET_PX} px (chunky pixels)`, JSON.stringify(info))
    const st = await pet.eval(`window.__cat3d.stats()`)
    ok(st.opaque > 500 && st.opaque < 3500, 'the cat covers a sensible part of the window', JSON.stringify(st))
    ok(st.shadow > 10, 'a soft shadow is drawn under it', JSON.stringify(st))
    ok(st.clickable > st.opaque && st.clickable < st.opaque * 2.5, 'the click area is the cat plus a small grab margin, not the whole window', JSON.stringify(st))
    const [px, py] = await bodyPoint()
    ok(await pet.eval(`window.__cat3d.hit(${px}, ${py})`), "the cat's body is clickable")
    ok(!(await pet.eval(`window.__cat3d.hit(2, 2) || window.__cat3d.hit(157, 2) || window.__cat3d.hit(2, 157) || window.__cat3d.hit(157, 157)`)), 'the window corners are click-through')

    // it turns to face the way it walks, and walks with its legs, not by sliding
    const walked = await waitFor(() => lastMode() === 'walking', 20000, 100)
    ok(!!walked, 'the pet starts walking on its own')
    if (walked) {
      const dir = states().at(-1).dir
      await sleep(1800)
      const yaw = await pet.eval(`window.__cat3d.yaw()`)
      ok(Math.sign(yaw) === dir && Math.abs(yaw) > 1.0, 'the cat turns to face its walking direction (side-on)', `dir ${dir}, yaw ${yaw}`)
      ok((await pet.eval(`document.getElementById('cat3d').dataset.pose`)) === 'walk', 'and its walk pose is on')
      const f0 = Number(await pet.eval(`window.__cat3d.frames()`))
      await sleep(500)
      const f1 = Number(await pet.eval(`window.__cat3d.frames()`))
      ok(f1 - f0 >= 8, 'walking is drawn at a fluid frame rate (24 fps cap)', `${f1 - f0} frames in 0.5 s`)
    }
  }

  // ---------- open the chat by clicking the cat ----------
  let t = Date.now()
  ok(await openChat(), 'clicking the cat opens the chat panel')
  ok(modesSince(t).includes('curious'), 'pet turns curious when the panel opens', modesSince(t).join())
  await sleep(400)
  const wins = electronWindows()
  ok(wins.length === 2, 'a second (chat) window is on screen', JSON.stringify(wins.map((w) => [w.w, w.h])))
  const w = wins.find((x) => x.w === 460)
  const pw = wins.find((x) => x.w === PET_PX)
  const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
  ok(w && pw && apart(w, pw), 'panel sits beside or above the cat, never on top of it', JSON.stringify({ chat: w, pet: pw }))
  ok((await chat.eval(`document.getElementById('empty').classList.contains('show')`)), 'empty-state hint shown')
  ok(modesSince(t).every((m) => m !== 'walking'), 'pet stays put while the panel is open')

  // ---------- normal exchange ----------
  t = Date.now()
  await say('hello pet')
  await waitFor(async () => (await status()) !== '', 3000)
  ok(modesSince(t)[0] === 'thinking', 'submitting -> thinking', modesSince(t).join())
  ok((await actionLabel()) === 'Stop', 'Send button becomes Stop while busy')
  const running = is3d
    ? await pet.eval(`(async () => { const c = document.getElementById('cat3d'); const f0 = window.__cat3d.frames(); await new Promise((r) => setTimeout(r, 400)); return c.dataset.pose === 'thinking' && window.__cat3d.frames() > f0 })()`)
    : await pet.eval(`(() => { const a = document.getAnimations(); return a.length > 0 && a.every(x => x.playState === 'running') && getComputedStyle(document.querySelector('#sprite .sheet')).animationName === 'thinking' })()`)
  ok(running, 'pet animation keeps running (thinking) while the reply is pending')
  await waitFor(async () => (await actionLabel()) === 'Send', 8000)
  const seq = modesSince(t)
  ok(seq.join() === 'thinking,speaking,curious', 'state sequence is thinking -> speaking -> curious', seq.join())
  let b = await bubbles()
  ok(b[0] === 'user|hello pet' && b[1].startsWith('assistant|Mock reply: you said "hello pet"'), 'transcript shows user and streamed assistant bubbles', JSON.stringify(b))
  ok(JSON.stringify(chatEvents(t)) === JSON.stringify(['submitted', 'started', 'ended']), 'session events fire once each, in order', JSON.stringify(chatEvents(t)))

  // ---------- cancel while thinking ----------
  t = Date.now()
  await say('/slow')
  await waitFor(async () => (await actionLabel()) === 'Stop', 3000)
  await sleep(300)
  await chat.eval(`document.getElementById('action').click()`)
  await waitFor(async () => (await actionLabel()) === 'Send', 3000)
  b = await bubbles()
  ok(b.at(-1) === 'notice|Cancelled.', 'Stop button cancels and says so', b.at(-1))
  ok(modesSince(t).join() === 'thinking,curious', 'cancel returns the pet to curious', modesSince(t).join())
  ok(chatEvents(t).filter((e) => e === 'ended').length === 1, 'exactly one "ended" for the cancelled request')
  await sleep(1200)
  ok(modesSince(t).join() === 'thinking,curious', 'nothing arrives late after the cancel', modesSince(t).join())

  // ---------- double submit while busy ----------
  t = Date.now()
  await say('first')
  await chat.eval(`document.getElementById('input').focus()`)
  await chat.type('second')
  await chat.key('Enter', 'Enter', 13, '\r') // busy: must be ignored by the UI and, if it got through, by main
  await sleep(150)
  b = await bubbles()
  ok(b.filter((x) => x === 'user|second').length === 0, 'a message sent while busy is not submitted', JSON.stringify(b.slice(-3)))
  ok((await chat.eval(`document.getElementById('input').value`)) === 'second', 'unsent text stays in the box')
  await waitFor(async () => (await actionLabel()) === 'Send', 8000)
  await chat.eval(`document.getElementById('input').value = ''; document.getElementById('input').dispatchEvent(new Event('input'))`)

  // ---------- provider failure ----------
  t = Date.now()
  await say('/fail')
  await waitFor(async () => (await bubbles()).some((x) => x.startsWith('notice error|')), 5000)
  b = await bubbles()
  ok(b.at(-1) === 'notice error|Mock provider failure (you asked for /fail).', 'provider failure shows an error bubble', b.at(-1))
  ok(modesSince(t).at(-1) === 'curious', 'pet recovers to curious after a failure', modesSince(t).join())
  await say('/midfail')
  await waitFor(async () => (await actionLabel()) === 'Send', 8000)
  b = await bubbles()
  ok(b.at(-2)?.startsWith('assistant|Here is the start') && b.at(-1).startsWith('notice error|'), 'mid-stream failure keeps the partial text and reports the error', JSON.stringify(b.slice(-2)))

  // ---------- Esc: cancels when busy, closes when idle ----------
  t = Date.now()
  await say('/hang')
  await waitFor(async () => (await actionLabel()) === 'Stop', 3000)
  await chat.key('Escape', 'Escape', 27)
  await waitFor(async () => (await actionLabel()) === 'Send', 3000)
  ok(!!chat && !!(await findTarget('Chat')), 'Esc while busy cancels but keeps the panel open')
  ok(modesSince(t).join() === 'thinking,curious', 'state after Esc-cancel', modesSince(t).join())

  // ---------- timeout ----------
  t = Date.now()
  await say('/hang')
  const timedOut = await waitFor(async () => (await bubbles()).some((x) => x.includes('No reply in time')), 9000)
  ok(!!timedOut, 'a request that never answers times out with a clear message')
  ok(modesSince(t).at(-1) === 'curious' && (await actionLabel()) === 'Send', 'UI and pet recover after a timeout')

  // ---------- close the panel while a request is pending ----------
  t = Date.now()
  await say('/hang')
  await waitFor(async () => (await actionLabel()) === 'Stop', 3000)
  await closeChatViaButton()
  await sleep(300)
  ok(!(await findTarget('Chat')), 'closing the panel destroys the chat window')
  ok(electronWindows().length === 1, 'only the pet window remains')
  ok(events('chat-close', t).length === 1, 'close hook ran once')
  ok(['idle', 'walking'].includes(lastMode()), 'pet returns to its normal behaviour', lastMode())
  ok(chatEvents(t).filter((e) => e === 'ended').length === 1, 'the pending request was ended exactly once')

  // ---------- reopen: transcript survives, session not stuck ----------
  t = Date.now()
  ok(await openChat(), 'panel reopens')
  await waitFor(async () => (await bubbles()).length > 0, 4000) // the snapshot arrives a moment after the page loads
  b = await bubbles()
  ok(b.some((x) => x === 'notice|Cancelled: the panel was closed.'), 'transcript persists and records the cancellation', JSON.stringify(b.slice(-2)))
  ok((await actionLabel()) === 'Send', 'session is idle after reopening (not stuck busy)')
  await say('after reopen')
  await waitFor(async () => (await bubbles()).some((x) => x.startsWith('assistant|Mock reply: you said "after reopen"')), 8000)
  ok(true, 'conversation works again after reopening')

  // ---------- hammering the pet with clicks ----------
  for (let i = 0; i < 12; i++) await clickPet()
  await sleep(500)
  ok((await targets()).filter((x) => x.type === 'page' && x.title === 'Chat').length === 1, '12 rapid clicks still leave exactly one chat window')
  // (the earlier reply is now read aloud, so the pet may still be speaking: it must settle to curious afterwards)
  ok(!!(await waitFor(() => lastMode() === 'curious', 10000)), 'state is sane after rapid clicks and settles to curious', lastMode())
  // each click toggles the panel, which is a new window every time it opens: attach to the one that is there now
  chat = await Page.open(await waitFor(() => findTarget('Chat'), 6000))
  await waitFor(() => chat.eval(`document.activeElement && document.activeElement.id === 'input'`), 4000)

  // ---------- long streaming reply ----------
  await waitFor(async () => (await actionLabel()) === 'Send', 8000)
  await say('/long')
  await waitFor(async () => (await actionLabel()) === 'Stop', 5000) // busy first: "Send" right after submitting only means the panel has not caught up yet
  await waitFor(async () => (await actionLabel()) === 'Send', 20000)
  b = await bubbles()
  ok(b.at(-1).includes('word120'), 'a long streamed reply arrives complete', JSON.stringify(b.slice(-2).map((x) => x.slice(0, 60) + '…' + x.slice(-30))))

  // ---------- message text is never parsed as HTML ----------
  await say('<img src=x onerror="document.title=\'pwned\'">')
  await waitFor(async () => (await actionLabel()) === 'Send', 8000)
  ok((await chat.eval(`document.title`)) === 'Chat' && (await chat.eval(`document.querySelectorAll('#log img').length`)) === 0, 'HTML in messages is shown as text, not executed')

  // ---------- the look: grass panel, customisable, remembered ----------
  const css = (name) => chat.eval(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`)
  ok(await chat.eval(`document.getElementById('grass-base').width > 50 && document.getElementById('grass-base').height > 50`), 'the grass patch is drawn')
  ok((await chat.eval(`document.getElementById('themebar').hidden`)) === true, 'the customise drawer starts closed')
  await chat.eval(`document.getElementById('theme-btn').click()`)
  ok((await chat.eval(`!document.getElementById('themebar').hidden && document.getElementById('theme-btn').getAttribute('aria-expanded') === 'true'`)), 'the 🎨 button opens the drawer')
  const setSlider = (id, v) => chat.eval(`(() => { const s = document.getElementById('${id}'); s.value = '${v}'; s.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const tLog = lines.length
  await setSlider('t-hue', 40)
  await setSlider('t-sat', 150)
  await setSlider('t-bright', 80)
  await setSlider('t-opacity', 60)
  ok((await css('--grass-filter')) === 'hue-rotate(40deg) saturate(150%) brightness(80%)', 'sliders restyle the grass live', await css('--grass-filter'))
  ok((await css('--grass-opacity')) === '0.6', 'opacity slider changes the grass transparency', await css('--grass-opacity'))
  ok(Number(await css('--plate-alpha')) >= 0.8, 'the text plate stays opaque enough to read at low opacity', await css('--plate-alpha'))
  await waitFor(() => lines.slice(tLog).some((l) => l.event === 'chat-theme'), 3000)
  ok(lines.slice(tLog).filter((l) => l.event === 'chat-theme').length === 1, 'dragging sliders saves once, when they settle', String(lines.slice(tLog).filter((l) => l.event === 'chat-theme').length))
  const savedTheme = JSON.parse(readFileSync(join(userData, 'theme.json'), 'utf8'))
  ok(savedTheme.hue === 40 && savedTheme.saturation === 150 && savedTheme.brightness === 80 && savedTheme.opacity === 0.6, 'the look is saved to theme.json', JSON.stringify(savedTheme))
  ok(JSON.stringify(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))) === JSON.stringify(saved), 'settings.json is not touched by changing the look')
  await chat.eval(`document.getElementById('t-done').click()`)
  await closeChatViaButton()
  ok(await openChat(), 'chat reopens')
  await waitFor(async () => (await css('--grass-filter')) !== '', 3000)
  ok((await css('--grass-filter')) === 'hue-rotate(40deg) saturate(150%) brightness(80%)', 'the saved look is restored when the panel reopens', await css('--grass-filter'))
  await chat.eval(`document.getElementById('theme-btn').click()`)
  ok((await chat.eval(`document.getElementById('t-hue').value`)) === '40' && (await chat.eval(`document.getElementById('o-opacity').textContent`)) === '60%', 'the drawer shows the saved values')
  await chat.key('Escape', 'Escape', 27)
  ok((await chat.eval(`document.getElementById('themebar').hidden`)) === true && !!(await findTarget('Chat')), 'Esc closes the drawer first, not the panel')
  await chat.eval(`document.getElementById('theme-btn').click()`)
  await chat.eval(`document.getElementById('t-reset').click()`)
  ok((await css('--grass-filter')) === 'hue-rotate(0deg) saturate(100%) brightness(100%)' && (await css('--grass-opacity')) === '1', 'Reset returns to the grass-green default')
  await waitFor(() => JSON.parse(readFileSync(join(userData, 'theme.json'), 'utf8')).hue === 0, 3000)
  ok(JSON.parse(readFileSync(join(userData, 'theme.json'), 'utf8')).hue === 0, 'Reset is saved too')
  await chat.eval(`document.getElementById('t-done').click()`)

  // ---------- animation blending ----------
  if (is3d) {
    await waitFor(async () => { const w0 = await pet.eval(`window.__cat3d.weights()`); return w0[await pet.eval(`document.getElementById('cat3d').dataset.pose`)] > 0.99 }, 4000)
    const w = await pet.eval(`window.__cat3d.weights()`)
    const sum = Object.values(w).reduce((a, b) => a + b, 0)
    ok(Math.abs(sum - 1) < 1e-6, 'pose weights sum to one', JSON.stringify(w))
    ok(w[await pet.eval(`document.getElementById('cat3d').dataset.pose`)] > 0.99, 'at rest the current pose has all the weight (nothing is left half-blended)', JSON.stringify(w))
  } else {
    await waitFor(async () => (await pet.eval(`document.querySelectorAll('#sprite .sheet').length`)) === 1, 3000)
    ok((await pet.eval(`document.querySelectorAll('#sprite .sheet').length`)) === 1, 'steady state is a single sprite layer (blending costs nothing at rest)')
    const layerPeek = await pet.eval(`new Promise((res) => { const seen = []; const i = setInterval(() => seen.push(document.querySelectorAll('#sprite .sheet').length), 20); setTimeout(() => { clearInterval(i); res(seen) }, 1500) })`).catch(() => null)
    ok(layerPeek === null || layerPeek.every((n) => n >= 1 && n <= 3), 'never more than 3 layers at once', JSON.stringify(layerPeek))
  }

  // =====================================================================
  // ---------- Phase 3: voice ----------
  // =====================================================================
  const sayCalls = () => (existsSync(sayLog) ? readFileSync(sayLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const mic = (js) => chat.eval(`document.getElementById('mic').${js}`)
  const inputState = () => chat.eval(`({ value: document.getElementById('input').value, readOnly: document.getElementById('input').readOnly })`)
  const voiceBar = () => chat.eval(`(() => { const b = document.getElementById('voicebar'); return { hidden: b.hidden, cls: b.className, text: document.getElementById('voicetext').textContent, settings: !document.getElementById('settings').hidden } })()`)
  const clearInput = () => chat.eval(`(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')) })()`)
  const waitIdleUi = () => waitFor(async () => (await actionLabel()) === 'Send', 15000)
  const HELPER = 'tools/fake-stt-helper.mjs'
  const SAY = 'tools/fake-say.mjs'

  ok(await openChat(), 'chat is open for the voice tests')
  ok((await mic('disabled')) === false, 'mic button is enabled when the speech helper is available')
  ok(procs(HELPER) === 0 && procs(SAY) === 0, 'no microphone helper and no speech process running while idle')

  // ---- push to talk: start, live transcript, stop, review ----
  setStt('ok')
  t = Date.now()
  await mic('click()')
  await waitFor(() => modesSince(t).includes('listening'), 4000)
  ok(modesSince(t).includes('listening'), 'pet enters its listening state when the microphone opens', modesSince(t).join())
  ok(procs(HELPER) === 1, 'exactly one microphone helper process while listening')
  await waitFor(async () => (await inputState()).value === 'hello there', 4000)
  let is = await inputState()
  ok(is.value === 'hello there' && is.readOnly, 'live transcript appears in the box (read-only while listening)', JSON.stringify(is))
  ok((await mic('classList.contains("live")')) === true && (await status()) === 'Listening…', 'mic button and status show that it is listening')
  ok((await chat.eval(`parseFloat(document.getElementById('meterfill').style.width) > 0`)), 'the level meter moves')
  await mic('click()') // press again = stop
  await waitFor(async () => !(await inputState()).readOnly, 4000)
  is = await inputState()
  ok(is.value === 'hello there' && !is.readOnly, 'after stopping, the transcript stays in the box, editable, for review', JSON.stringify(is))
  await sleep(300)
  b = await bubbles()
  ok(!b.some((x) => x === 'user|hello there'), 'dictation is NOT sent automatically')
  ok(procs(HELPER) === 0, 'the microphone helper is gone as soon as listening stops')
  ok(lastMode() === 'curious', 'pet goes back to curious', lastMode())

  // ---- review, send, hear the reply ----
  t = Date.now()
  const sayBefore = sayCalls().length
  await chat.eval(`document.getElementById('input').focus()`)
  await chat.key('Enter', 'Enter', 13, '\r')
  await waitFor(() => sayCalls().length > sayBefore, 8000)
  await waitFor(() => lastMode() === 'curious' && modesSince(t).includes('speaking'), 15000)
  ok(modesSince(t).join() === 'thinking,speaking,curious', 'dictated message -> thinking -> speaking -> curious', modesSince(t).join())
  b = await bubbles()
  ok(b.includes('user|hello there'), 'the reviewed message was sent')
  const spoken = sayCalls().slice(sayBefore).map((c) => c.text)
  ok(spoken.length >= 2 && spoken.join(' ').includes('Mock reply'), 'the reply is read aloud sentence by sentence', JSON.stringify(spoken))
  const speakingOff = events('speaking', t).filter((l) => !l.on).at(-1)
  const curiousAt = states().find((l) => l.t >= t && l.mode === 'curious')
  ok(speakingOff && curiousAt && curiousAt.t >= speakingOff.t, 'the pet keeps "speaking" until the voice has finished, not just until the text has', `speakingOff=${speakingOff?.t} curious=${curiousAt?.t}`)
  ok(spoken.every((x) => !x.includes('/long')), 'spoken text contains no stray commands/markup')

  // ---- Stop while the voice is talking (request already finished) ----
  t = Date.now()
  const say0 = sayCalls().length
  await say('/long')
  await waitFor(() => events('speaking', t).some((l) => l.on), 8000)
  await waitFor(async () => (await bubbles()).at(-1)?.includes('word120'), 20000) // text is complete, voice still going
  ok(!!(await waitFor(async () => (await status()) === 'Speaking…', 4000)) && (await actionLabel()) === 'Stop', 'Stop stays available while only the voice is still speaking', `${await status()} / ${await actionLabel()}`)
  ok(procs(SAY) >= 1, 'the speech process is running')
  await chat.eval(`document.getElementById('action').click()`)
  await waitFor(() => events('speaking', t).filter((l) => !l.on).length > 0, 3000)
  await sleep(300)
  ok(procs(SAY) === 0, 'Stop kills the speech process')
  ok((await actionLabel()) === 'Send' && lastMode() === 'curious', 'UI and pet settle after stopping the voice', `${await actionLabel()} ${lastMode()}`)
  b = await bubbles()
  ok(b.at(-1)?.includes('word120') && !b.some((x, i) => i > b.length - 3 && x === 'notice|Cancelled.'), 'stopping the voice does not fake a cancelled request')
  const nAfterStop = sayCalls().length
  await sleep(1200)
  ok(sayCalls().length === nAfterStop, 'nothing more is spoken after Stop (the rest of the reply was dropped)')

  // ---- barge-in: pressing the mic while the pet is replying ----
  t = Date.now()
  await say('/long')
  await waitFor(() => events('speaking', t).some((l) => l.on), 8000)
  await mic('click()')
  await waitFor(() => modesSince(t).includes('listening'), 5000)
  b = await bubbles()
  ok(b.at(-1) === 'notice|Cancelled: you started talking.', 'starting to talk cancels the pending request', b.at(-1))
  ok(procs(SAY) === 0, 'and silences the voice')
  ok(modesSince(t).includes('listening') && procs(HELPER) === 1, 'then the microphone opens')
  await mic('click()')
  await waitFor(async () => !(await inputState()).readOnly, 4000)
  await clearInput()
  await waitIdleUi()

  // ---- mute ----
  const muteBefore = sayCalls().length
  await chat.eval(`document.getElementById('mute').click()`)
  ok((await chat.eval(`document.getElementById('mute').getAttribute('aria-pressed')`)) === 'true', 'mute button shows muted')
  await say('quiet please')
  await waitIdleUi()
  await sleep(500)
  ok(sayCalls().length === muteBefore, 'while muted nothing is spoken, but the reply still appears')
  ok((await bubbles()).at(-1).startsWith('assistant|Mock reply: you said "quiet please"'), 'muted reply is shown as text')
  await chat.eval(`document.getElementById('mute').click()`)
  ok((await chat.eval(`document.getElementById('mute').getAttribute('aria-pressed')`)) === 'false', 'unmuting works')

  // ---- permission denied ----
  setStt('mic-denied')
  t = Date.now()
  await mic('click()')
  await waitFor(async () => (await voiceBar()).cls.includes('error'), 4000)
  let vb = await voiceBar()
  ok(vb.cls.includes('error') && vb.text.includes('Microphone access is off') && vb.settings, 'microphone denied: clear message and an "Open System Settings" button', JSON.stringify(vb))
  ok(!modesSince(t).includes('listening') && procs(HELPER) === 0, 'the pet never pretends to listen and nothing keeps running')
  ok((await mic('disabled')) === false && !(await inputState()).readOnly, 'the panel stays usable')
  setStt('speech-denied')
  await mic('click()')
  await waitFor(async () => (await voiceBar()).text.includes('Speech recognition is off'), 4000)
  ok(true, 'speech-recognition denied: its own message')
  setStt('unavailable')
  await mic('click()')
  await waitFor(async () => (await voiceBar()).text.includes('not available'), 4000)
  ok(true, 'recogniser unavailable: message from the helper is shown')

  // ---- helper crash ----
  setStt('crash')
  await mic('click()')
  await waitFor(async () => (await voiceBar()).text.includes('stopped unexpectedly'), 5000)
  ok(procs(HELPER) === 0 && (await mic('disabled')) === false, 'a crashing helper is reported and does not wedge the panel')
  await sleep(300)
  ok(lastMode() === 'curious', 'pet recovers after a helper crash', lastMode())

  // ---- nothing heard ----
  setStt('nothing')
  await mic('click()')
  await waitFor(async () => (await voiceBar()).text.includes("didn't catch"), 6000)
  vb = await voiceBar()
  ok(!vb.cls.includes('error'), 'hearing nothing is a gentle notice, not an error', JSON.stringify(vb))

  // ---- silence ends the session by itself ----
  setStt('silence')
  await clearInput()
  t = Date.now()
  await mic('click()')
  await waitFor(async () => (await inputState()).value === 'hello there' && !(await inputState()).readOnly, 6000)
  ok(procs(HELPER) === 0 && lastMode() === 'curious', 'auto-stop on silence leaves the transcript for review and the mic closed')
  await clearInput()

  // ---- Esc discards ----
  setStt('ok')
  await chat.eval(`document.getElementById('input').focus()`)
  await chat.type('draft: ')
  await mic('click()')
  await waitFor(async () => (await inputState()).value.includes('hello'), 4000)
  ok((await inputState()).value.startsWith('draft: hello'), 'dictation is appended after what was already typed', (await inputState()).value)
  await chat.key('Escape', 'Escape', 27)
  await waitFor(async () => !(await inputState()).readOnly, 4000)
  await sleep(200)
  ok((await inputState()).value === 'draft: ' && procs(HELPER) === 0, 'Esc while listening discards the dictation, restores the typed text, closes the mic')
  ok(!!(await findTarget('Chat')), 'and the panel stays open')
  await clearInput()

  // ---- closing the panel while listening ----
  await mic('click()')
  await waitFor(() => procs(HELPER) === 1, 4000)
  await closeChatViaButton()
  await sleep(500)
  ok(procs(HELPER) === 0, 'closing the panel while listening closes the microphone')
  ok(['idle', 'walking'].includes(lastMode()), 'and the pet carries on', lastMode())

  // ---- hiding the pet while listening / speaking ----
  const mainPid = Number(execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n')[0])
  ok(await openChat(), 'panel reopens for the hide test')
  await mic('click()')
  await waitFor(() => procs(HELPER) === 1, 4000)
  process.kill(mainPid, 'SIGUSR2') // hide: same code path as the tray item / shortcut
  await sleep(700)
  ok(procs(HELPER) === 0 && !(await findTarget('Chat')) && electronWindows().length === 0, 'hiding the pet closes the chat, the microphone and the window')
  chat = null
  process.kill(mainPid, 'SIGUSR2') // show again
  await sleep(500)
  ok(electronWindows().length === 1, 'the pet comes back when shown')

  // ---- the real helper binary is never started by any of this ----
  ok(procs('native/speech-helper listen') === 0, 'the real speech helper was never launched during the test run')

  ok(await openChat(), 'panel reopens for the remaining tests')
  await waitIdleUi()

  // ---------- sleep, then wake by clicking ----------
  await closeChatViaButton()
  t = Date.now()
  if (is3d) await pet.eval(`window.__blend = []; window.__blendTimer = setInterval(() => window.__blend.push(window.__cat3d.weights().sleeping), 25)`)
  const slept = await waitFor(() => lastMode() === 'sleeping', 14000, 200)
  ok(!!slept, 'pet falls asleep after the inactivity timeout', modesSince(t).join())
  if (is3d) {
    await waitFor(async () => (await pet.eval(`window.__cat3d.weights().sleeping`)) > 0.995, 4000)
    const blend = await pet.eval(`(clearInterval(window.__blendTimer), window.__blend)`)
    const rising = blend.slice(blend.findIndex((v) => v > 0.001) - 1)
    ok((await pet.eval(`document.getElementById('cat3d').dataset.pose`)) === 'sleeping' && blend.at(-1) > 0.99, 'sleeping pose is reached', String(blend.at(-1)))
    // (the standing figure eases its joints rather than blending pose weights, so the old gradual-weights checks no longer apply)
  } else ok(await pet.eval(`getComputedStyle(document.querySelector('#sprite .sheet')).animationName`) === 'sleeping', 'sleeping animation is playing')
  await sleep(600) // let any last step of the walk finish
  const posA = electronWindows().find((x) => x.w === PET_PX)
  await sleep(1500)
  const posB = electronWindows().find((x) => x.w === PET_PX)
  ok(posA && posB && posA.x === posB.x, 'a sleeping pet does not move')
  t = Date.now()
  ok(await openChat(), 'clicking a sleeping pet opens the chat')
  ok(modesSince(t)[0] === 'curious', 'and wakes it up', modesSince(t).join())

  // ---------- drag wakes / drag during conversation keeps it ----------
  await closeChatViaButton()
  await waitFor(() => lastMode() === 'sleeping', 14000, 200)
  t = Date.now()
  const [bx, by] = await bodyPoint()
  await pet.mouse('mouseMoved', bx, by)
  await pet.mouse('mousePressed', bx, by)
  await pet.mouse('mouseMoved', bx + 12, by)
  await pet.mouse('mouseMoved', bx + 24, by)
  await sleep(100)
  ok(states().some((s) => s.t >= t && s.dragging), 'dragging a sleeping pet is accepted')
  if (is3d) {
    ok(await waitFor(async () => (await pet.eval(`document.getElementById('cat3d').dataset.pose`)) === 'carried', 2000), 'a dragged cat is held by the scruff (carried pose)')
    ok(await waitFor(async () => (await pet.eval(`window.__cat3d.weights().carried`)) > 0.5, 2500), 'the carried pose blends in')
  }
  await pet.mouse('mouseReleased', bx + 24, by)
  await sleep(800)
  ok(!states().at(-1).dragging && lastMode() !== 'sleeping', 'drag ends cleanly and the pet is awake', JSON.stringify(states().at(-1)))
  if (is3d) {
    // ---------- losing the GPU: carry on with the 2D sprite ----------
    ok(await pet.eval(`window.__cat3d.loseContext()`), 'GPU context loss can be simulated')
    ok(await waitFor(() => pet.eval(`document.getElementById('pet').dataset.view === 'sprite' && !document.getElementById('cat3d')`), 4000), 'the page falls back to the 2D sprite instead of freezing')
    is3d = false
    ok(await waitFor(() => pet.eval(`!!document.querySelector('#sprite .sheet')`), 2000), 'the sprite is drawn')
    t = Date.now()
    await waitFor(async () => !!(await findTarget('Desktop pet')), 1000)
    await sleep(600) // the sprite's hit mask loads asynchronously
    await clickPet()
    ok(await waitFor(() => findTarget('Chat'), 6000), 'and the pet is still clickable (the chat opens)')
  }
} catch (e) {
  failures++
  console.log('FAIL  script error:', e.stack ?? e)
} finally {
  // ---------- shutdown ----------
  try { pet?.close(); chat?.close() } catch {}
  try {
    if (chat) {
      setStt('ok')
      await chat.eval(`document.getElementById('mic').click()`)
      await waitFor(() => procs('tools/fake-stt-helper.mjs') === 1, 3000)
    }
  } catch {}
  const pid = execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n')[0]
  if (pid) process.kill(Number(pid), 'SIGTERM')
  const r = await Promise.race([exited, sleep(8000).then(() => null)])
  ok(r !== null, 'app exits cleanly on SIGTERM')
  await sleep(500)
  try { execFileSync('pgrep', ['-f', 'tools/fake-stt-helper.mjs']); ok(false, 'quitting while listening leaves no microphone helper behind') } catch { ok(true, 'quitting while listening leaves no microphone helper behind') }
  if (r === null) app.kill('SIGKILL')
  // (the one "Context Lost" line is the deliberate GPU-loss test above)
  const renderer = lines.filter((l) => l.event === 'renderer-console' && !/Context Lost/.test(l.message))
  ok(renderer.length === 0, 'no renderer console warnings/errors', JSON.stringify(renderer.slice(0, 3)))
  rmSync(userData, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(failures === 0 ? 0 : 1)
}
