// End-to-end check of the Claude provider path in the real app, against a fake `claude` command (tools/fake-claude.mjs):
// no network, no account, no cost. Launches the built app with settings that select "claude-cli", then drives the chat
// panel over the Chrome DevTools Protocol like tools/e2e.mjs does.
//   npm run e2e:claude
// With PET_E2E_REAL=1 it instead sends ONE short message through the real `claude` command signed in on this Mac
// (a single Haiku request on your subscription) and checks the reply arrives, is spoken (fake say), and nothing is left running.
//   PET_E2E_REAL=1 npm run e2e:claude
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL = process.env.PET_E2E_REAL === '1'
// A free port, so another app's DevTools port (or a previous run) can never collide with the test.
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
})
const userData = mkdtempSync(join(tmpdir(), 'pet-e2e-claude-'))
const home = join(userData, 'ai-home')
mkdirSync(home, { recursive: true })
const FAKE = join(process.cwd(), 'tools/fake-claude.mjs')
const settingsText = JSON.stringify({ ai: { provider: 'claude-cli', model: 'haiku', command: REAL ? 'claude' : FAKE, timeoutSeconds: REAL ? 45 : 10 } }, null, 2) + '\n'
writeFileSync(join(userData, 'settings.json'), settingsText)
const sayLog = join(userData, 'say.log')
const setFake = (cfg) => writeFileSync(join(home, 'fake-claude.json'), JSON.stringify(cfg))
const calls = () => (existsSync(join(home, 'fake-claude-calls.jsonl')) ? readFileSync(join(home, 'fake-claude-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const runCalls = () => calls().filter((c) => c.argv[0] !== 'auth')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const realProcs = () => { try { return execFileSync('pgrep', ['-f', '--no-session-persistence'], { encoding: 'utf8' }).split('\n').filter(Boolean).length } catch { return 0 } }
const fakeProcs = () => { try { return execFileSync('pgrep', ['-f', 'tools/fake-claude.mjs'], { encoding: 'utf8' }).split('\n').filter(Boolean).length } catch { return 0 } }

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

const app = spawn('node_modules/.bin/electron-vite', ['preview'], {
  env: {
    ...process.env,
    PET_E2E: '1', PET_DEBUG: '1', PET_USER_DATA: userData, PET_SLEEP_AFTER_MS: '600000', PET_REST: '0', PET_E2E_PORT: String(PORT),
    PET_STT_HELPER: join(process.cwd(), 'tools/fake-stt-helper.mjs'),
    PET_SAY_BIN: join(process.cwd(), 'tools/fake-say.mjs'), PET_FAKE_SAY_LOG: sayLog, PET_FAKE_SAY_MS_PER_CHAR: '10',
    // The app's own environment holds an API key and a cloud switch: the child must never see them.
    ...(REAL ? {} : { ANTHROPIC_API_KEY: 'sk-ant-e2e-must-not-leak', CLAUDE_CODE_USE_BEDROCK: '1' })
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
const chatEvents = (t = 0) => lines.filter((l) => l.event === 'chat-event' && l.t >= t).map((l) => `${l.kind}${l.outcome ? ':' + l.outcome : ''}`)

async function targets() { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() } catch { return [] } }
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } } }
  static async open(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej }); const p = new Page(ws); await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }); return p }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value }
  async mouse(type, x, y) { await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
  async click(x, y) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y) }
  async type(text) { await this.send('Input.insertText', { text }) }
  async key(key, code, vk, text) { const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) }; await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }) }
  close() { this.ws.close() }
}
const findTarget = async (title) => (await targets()).find((t) => t.type === 'page' && t.title === title)
let pet, chat = null
async function bodyPoint() { const p3 = await pet.eval(`window.__cat3d ? window.__cat3d.bodyPoint() : null`); if (p3) return p3; const left = await pet.eval(`document.getElementById('sprite').classList.contains('facing-left')`); const sx = 66, sy = 98; return [left ? 160 - sx : sx, sy] }
async function openChat() {
  if (chat) return true
  const [x, y] = await bodyPoint(); await pet.click(x, y)
  const t = await waitFor(() => findTarget('Chat'), 6000)
  if (!t) return false
  chat = await Page.open(t)
  await waitFor(() => chat.eval(`document.activeElement && document.activeElement.id === 'input'`), 4000)
  return true
}
async function closeChat() { await chat.eval(`document.getElementById('close').click()`); chat.close(); chat = null; await waitFor(async () => !(await findTarget('Chat')), 4000) }
async function say(text) { await chat.eval(`document.getElementById('input').focus()`); await chat.type(text); await chat.key('Enter', 'Enter', 13, '\r') }
const bubbles = () => chat.eval(`[...document.querySelectorAll('#log li')].map(li => li.className + '|' + li.textContent)`)
const lastBubble = async () => (await bubbles()).at(-1) ?? ''
const action = () => chat.eval(`document.getElementById('action').getAttribute('aria-label')`)
const idle = () => waitFor(async () => (await action()) === 'Send', 8000)

try {
  const petTarget = await waitFor(() => findTarget('Desktop pet'), 25000, 250)
  ok(!!petTarget, 'pet window loads')
  if (!petTarget) throw new Error('pet page never appeared; stderr:\n' + stderr)
  pet = await Page.open(petTarget)
  await waitFor(() => states().length > 0, 5000)
  ok(lines.some((l) => l.event === 'assistant' && l.provider === 'claude-cli' && l.model === 'haiku'), 'settings.json selects the Claude provider (haiku)')
  ok(readFileSync(join(userData, 'settings.json'), 'utf8') === settingsText, 'settings.json is not rewritten by the app')

  if (REAL) {
    ok(await openChat(), 'chat opens')
    ok((await chat.eval(`document.getElementById('title').textContent`)) === 'Chat · Claude subscription (haiku)', 'panel header names the assistant')
    const t = Date.now()
    const sent = Date.now()
    await say('Reply with exactly five words about cats.')
    const got = await waitFor(async () => (await lastBubble()).startsWith('assistant|'), 30000)
    const firstMs = Date.now() - sent
    await idle()
    const text = (await lastBubble()).slice('assistant|'.length)
    console.log(`      real reply: ${JSON.stringify(text)} (first text after ${firstMs} ms)`)
    ok(!!got && text.trim().length > 0, 'a real reply from Claude appears in the panel')
    ok(JSON.stringify(chatEvents(t)) === JSON.stringify(['submitted', 'started', 'ended:completed']), 'events: submitted, started, ended(completed)', chatEvents(t).join(','))
    ok(modesSince(t).includes('thinking') && modesSince(t).includes('speaking'), 'pet goes thinking, then speaking', modesSince(t).join(','))
    ok(existsSync(sayLog) && readFileSync(sayLog, 'utf8').length > 10, 'the real reply reached the voice (fake say)')
    ok(await waitFor(() => lines.some((l) => l.event === 'speaking' && l.on === false && l.t >= t), 8000), 'pet settles after speaking')
    throw Object.assign(new Error('real flow done'), { done: true })
  }

  // ---------- the panel says who answers ----------
  setFake({ mode: 'ok', reply: 'Meow! Nice to meet you.', delayMs: 40 })
  ok(await openChat(), 'chat opens')
  ok(await waitFor(async () => (await chat.eval(`document.getElementById('title').textContent`)) === 'Chat · Claude subscription (haiku)', 3000), 'panel header names the assistant', await chat.eval(`document.getElementById('title').textContent`))
  ok(await chat.eval(`document.getElementById('empty-mock').hidden && !document.getElementById('empty-ai').hidden`), 'empty state explains messages go to Claude, not the mock text')

  // ---------- a normal exchange ----------
  let t = Date.now()
  await say('hello there')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Meow'), 8000)
  await idle()
  ok((await bubbles()).join('\n') === 'user|hello there\nassistant|Meow! Nice to meet you.', 'reply streams into the transcript', (await bubbles()).join(' / '))
  ok(JSON.stringify(chatEvents(t)) === JSON.stringify(['submitted', 'started', 'ended:completed']), 'events: submitted, started, ended(completed)', chatEvents(t).join(','))
  const m = modesSince(t)
  ok(m.includes('thinking') && m.includes('speaking'), 'pet goes thinking, then speaking', m.join(','))
  ok(await waitFor(() => lines.some((l) => l.event === 'speaking' && l.on === false && l.t >= t), 6000), 'reply was read aloud (fake say) and the pet settled')
  ok(existsSync(sayLog) && readFileSync(sayLog, 'utf8').includes('Meow'), 'the reply text reached the voice')
  ok(runCalls().length === 1 && runCalls()[0].stdin === 'hello there', 'first message is sent as-is on stdin', JSON.stringify(runCalls()[0]?.stdin))
  const argv = runCalls()[0].argv
  ok(argv.includes('--strict-mcp-config') && argv.includes('--no-session-persistence') && argv.includes('--disable-slash-commands') && argv[argv.indexOf('--tools') + 1] === '', 'the real app launches claude with the lockdown flags')
  ok(!argv.join(' ').includes('hello there'), 'the message is never on the command line')
  const env = runCalls()[0].envKeys
  ok(!env.includes('ANTHROPIC_API_KEY') && !env.includes('CLAUDE_CODE_USE_BEDROCK'), 'the app\'s API key and cloud switch never reach the child', env.join(','))
  ok(runCalls()[0].cwd.endsWith('/ai-home'), 'it runs in the app-owned folder')

  // ---------- a coherent conversation ----------
  setFake({ mode: 'ok', reply: 'Your name is Sam.', delayMs: 10 })
  await say('what is my name?')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Your name'), 8000)
  await idle()
  const second = runCalls()[1]?.stdin ?? ''
  ok(second.includes('User: hello there') && second.includes('You: Meow! Nice to meet you.') && second.includes('what is my name?'), 'the second message carries the first exchange as history', JSON.stringify(second))

  // ---------- slow first word: the pet stays animated and the panel responsive ----------
  setFake({ mode: 'ok', reply: 'Slow but sure.', delayMs: 2500 })
  t = Date.now()
  await say('take your time')
  await sleep(1200)
  ok(lastMode() === 'thinking', 'pet shows thinking while Claude is slow', lastMode())
  ok(await pet.eval(`(async () => { const c = document.getElementById('cat3d'); if (!c) return getComputedStyle(document.querySelector('#sprite .sheet')).animationName !== 'none'; const f0 = window.__cat3d.frames(); await new Promise((r) => setTimeout(r, 500)); return window.__cat3d.frames() > f0 })()`), 'the cat keeps animating during the wait')
  ok((await chat.eval(`1 + 1`)) === 2 && (await action()) === 'Stop', 'panel stays responsive and offers Stop')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Slow'), 12000)
  await idle()

  // ---------- Stop mid-reply kills the child ----------
  setFake({ mode: 'hang' })
  const before = runCalls().length
  await say('this will hang')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Start'), 8000)
  const pid = runCalls().at(-1)?.pid
  ok(runCalls().length === before + 1 && alive(pid), 'a claude process is running mid-reply')
  t = Date.now()
  await chat.eval(`document.getElementById('action').click()`)
  await idle()
  ok((await waitFor(() => !alive(pid), 4000)) !== null, 'Stop kills the claude process')
  ok(chatEvents(t).includes('ended:cancelled'), 'request ends as cancelled', chatEvents(t).join(','))
  ok(['curious', 'speaking'].includes(lastMode()) || (await waitFor(() => lastMode() === 'curious', 6000)) !== null, 'pet returns to curious after cancel', lastMode())

  // ---------- errors are readable and recoverable ----------
  const cases = [
    ['autherr', /claude auth login/],
    ['limit', /usage limit.*resets 3pm/],
    ['network', /internet connection/],
    ['crash-start', /boom/],
    ['tools', /Safety check failed/],
    ['apikey', /billed separately/]
  ]
  for (const [mode, re] of cases) {
    setFake({ mode })
    t = Date.now()
    await say(`trigger ${mode}`)
    const got = await waitFor(async () => (await lastBubble()).startsWith('notice error|'), 8000)
    await idle()
    const text = await lastBubble()
    ok(!!got && re.test(text), `error case "${mode}" shows a readable message`, text)
    ok(!(await bubbles()).join('\n').includes('should never be shown'), `error case "${mode}" shows none of the blocked run's output`)
    ok(chatEvents(t).includes('ended:failed'), `error case "${mode}" ends as failed`, chatEvents(t).join(','))
    ok(lastMode() !== 'thinking', `pet is not stuck thinking after "${mode}"`, lastMode())
  }
  setFake({ mode: 'ok', reply: 'Back to normal.', delayMs: 10 })
  await say('are you ok now?')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Back'), 8000)
  await idle()
  ok((await lastBubble()) === 'assistant|Back to normal.', 'a normal reply works again after all those failures')

  // ---------- a stalled reply times out and the child is killed ----------
  setFake({ mode: 'hang' })
  t = Date.now()
  await say('stall please')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Start'), 8000)
  const stalled = runCalls().at(-1).pid
  const timedOut = await waitFor(async () => (await lastBubble()).startsWith('notice error|No reply in time'), 16000)
  await idle()
  ok(!!timedOut, 'silence for 10 s (the configured timeout) fails with a readable message', await lastBubble())
  ok((await waitFor(() => !alive(stalled), 4000)) !== null, 'the stalled claude process is killed')

  // ---------- closing the panel mid-request ----------
  setFake({ mode: 'hang' })
  await say('close on me')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Start'), 8000)
  const closing = runCalls().at(-1).pid
  await closeChat()
  ok((await waitFor(() => !alive(closing), 4000)) !== null, 'closing the panel kills the claude process')
  ok(fakeProcs() === 0, 'no claude process is left running')

  // ---------- quitting mid-request ----------
  ok(await openChat(), 'chat reopens')
  setFake({ mode: 'hang' })
  await say('quit on me')
  await waitFor(async () => (await lastBubble()).startsWith('assistant|Start'), 8000)
  const quitting = runCalls().at(-1).pid
  ok(alive(quitting), 'a claude process is running when the app is told to quit')
} catch (e) {
  if (!e?.done) {
    failures++
    console.log('FAIL  script error:', e.stack ?? e)
  }
} finally {
  try { pet?.close(); chat?.close() } catch {}
  const pid = execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n')[0]
  if (pid) process.kill(Number(pid), 'SIGTERM')
  const r = await Promise.race([exited, sleep(8000).then(() => null)])
  ok(r !== null, 'app exits cleanly on SIGTERM')
  if (r === null) console.log('      app stderr tail:', JSON.stringify(stderr.slice(-1200)))
  await sleep(600)
  ok(REAL ? realProcs() === 0 : fakeProcs() === 0, 'quitting leaves no claude process behind')
  if (r === null) app.kill('SIGKILL')
  ok(readFileSync(join(userData, 'settings.json'), 'utf8') === settingsText, 'settings.json still untouched at the end')
  const renderer = lines.filter((l) => l.event === 'renderer-console')
  ok(renderer.length === 0, 'no renderer console warnings/errors', JSON.stringify(renderer.slice(0, 3)))
  rmSync(userData, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(failures === 0 ? 0 : 1)
}
