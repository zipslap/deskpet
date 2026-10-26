// Resource use of the pet in the states that matter, measured on the real app (real 3D cat, real window helper).
//   node tools/bench-observe.mjs [seconds-per-scenario=30] [only-scenarios-containing-this-text]
// CPU is the cumulative CPU time of the whole Electron process tree divided by wall time (so 100% = one full core);
// memory is the summed resident set. Nothing here captures the screen: change-detection rules are not used, so the pixel
// sampler (which needs Screen Recording permission) is never called. Its cost is therefore NOT measured here.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECONDS = Number(process.argv[2] ?? 30)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })

function cpuSeconds(str) { // ps cputime: [dd-]hh:mm:ss or mm:ss.ss
  const [main, frac = '0'] = str.trim().split('.')
  const parts = main.split(/[:-]/).map(Number)
  while (parts.length < 3) parts.unshift(0)
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + Number(`0.${frac}`)
}
function tree(userData) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,cputime=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)
    return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], cpu: cpuSeconds(m[4]), cmd: m[5] }
  }).filter(Boolean)
  const helperParents = new Set(rows.filter((r) => r.cmd.includes(userData)).map((r) => r.ppid))
  const mains = rows.filter((r) => helperParents.has(r.pid))
  const ids = new Set(mains.map((r) => r.pid))
  return rows.filter((r) => ids.has(r.pid) || r.cmd.includes(userData))
}
const sum = (rows) => ({ cpu: rows.reduce((n, r) => n + r.cpu, 0), rss: rows.reduce((n, r) => n + r.rssKb, 0) / 1024 })

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } } }
  static async open(t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej }); const p = new Page(ws); await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }); return p }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
  async click(x, y) { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }) }
}

async function scenario(name, { settings = {}, env = {}, setup }) {
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'pet-bench-'))
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  const app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_E2E_PORT: String(port), PET_SLEEP_AFTER_MS: '3600000', PET_REST: '0', ...env }, stdio: 'ignore' })
  try {
    let petT
    for (let i = 0; i < 100 && !petT; i++) { try { petT = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.title === 'Desktop pet') } catch {} if (!petT) await sleep(250) }
    if (!petT) throw new Error('pet page never appeared')
    const pet = await Page.open(petT)
    await sleep(3000) // settle (shaders, first frames)
    if (setup) await setup({ pet, port })
    await sleep(2000)
    const a = sum(tree(userData)); const t0 = Date.now()
    let peak = a.rss
    while (Date.now() - t0 < SECONDS * 1000) { await sleep(1000); peak = Math.max(peak, sum(tree(userData)).rss) }
    const b = sum(tree(userData)); const wall = (Date.now() - t0) / 1000
    return { name, cpu: ((b.cpu - a.cpu) / wall) * 100, rss: b.rss, peak }
  } finally {
    try { const pids = execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n').filter(Boolean); for (const p of pids) process.kill(Number(p), 'SIGTERM') } catch {}
    await sleep(1200)
    rmSync(userData, { recursive: true, force: true })
  }
}

const openChatAndWatch = (watch) => async ({ pet, port }) => {
  const p3 = await pet.eval(`window.__cat3d ? window.__cat3d.bodyPoint() : null`)
  const [x, y] = p3 ?? [66, 98]
  await pet.click(x, y)
  let chatT
  for (let i = 0; i < 40 && !chatT; i++) { chatT = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.title === 'Chat'); if (!chatT) await sleep(250) }
  const chat = await Page.open(chatT)
  await sleep(800)
  if (watch) { await chat.eval(`document.getElementById('watch-btn').click()`); await sleep(500); await chat.eval(`document.getElementById('close').click()`) }
  return chat
}
const observe = (seconds) => ({ observe: { enabled: true, intervalSeconds: seconds, maxPerHour: 6, rules: [{ app: 'Mail', action: 'nudge', cooldownMinutes: 10 }] } })

// the helper alone: latency of one "which app is in front" check
const lat = []
for (let i = 0; i < 20; i++) { const t = process.hrtime.bigint(); execFileSync('native/window-helper', ['windows'], { stdio: 'ignore' }); lat.push(Number(process.hrtime.bigint() - t) / 1e6) }
lat.sort((a, b) => a - b)

const only = process.argv[3]
const want = (n) => !only || n.includes(only)
const results = []
if (want('asleep')) results.push(await scenario('asleep (after 5 min unused; here 3 s): the picture is frozen', { env: { PET_SLEEP_AFTER_MS: '3000', PET_REST: '0' } }))
if (want('3D cat')) results.push(await scenario('pet awake and wandering, chat closed (3D cat)', { env: { PET_REST: '0' } }))
if (want('sprite')) results.push(await scenario('pet idle / walking, chat closed (cat.view = "sprite", the lightest)', { settings: { cat: { view: 'sprite' } } }))
if (want('chat panel')) results.push(await scenario('chat panel open, nothing happening', { setup: openChatAndWatch(false) }))
if (want('every 20')) results.push(await scenario('watching ON, check every 20 s (default), chat closed', { settings: observe(20), setup: openChatAndWatch(true) }))
if (want('every 5')) results.push(await scenario('watching ON, check every 5 s (fastest allowed), chat closed', { settings: observe(5), setup: openChatAndWatch(true) }))

console.log(`\nwindow-helper (frontmost app + window list): median ${lat[10].toFixed(0)} ms, p90 ${lat[18].toFixed(0)} ms per check (20 runs)\n`)
console.log(`| State (${SECONDS} s each) | CPU, whole app | Memory now | Peak memory |\n|---|---|---|---|`)
for (const r of results) console.log(`| ${r.name} | ${r.cpu.toFixed(1)}% of one core | ${r.rss.toFixed(0)} MB | ${r.peak.toFixed(0)} MB |`)
