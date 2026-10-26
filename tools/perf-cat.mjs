// Measures what the 3D cat costs: per pose, frames per second, milliseconds spent per frame (including waiting for the GPU
// to finish), and CPU use of the app's processes (main + renderer + GPU), sampled from `ps`.
//   node tools/perf-cat.mjs [--px=2] [--seconds=8]
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const flag = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=')[1]
const seconds = Number(flag('seconds', 8))
const PORT = await new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
const userData = mkdtempSync(join(tmpdir(), 'pet-perf-'))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ cat: { pixelSize: Number(flag('px', 2)) } }))
const app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_E2E_PORT: String(PORT), PET_SLEEP_AFTER_MS: '86400000', PET_REST: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ELECTRON = `${process.cwd()}/node_modules/electron/dist/Electron.app`

/** Cumulative CPU seconds of every process belonging to this app (main, renderer, GPU, utility). */
function cpuSeconds() {
  const out = execFileSync('ps', ['-axo', 'time=,command='], { encoding: 'utf8' })
  let total = 0
  for (const line of out.split('\n')) {
    if (!line.includes(ELECTRON) || line.includes('grep')) continue
    const m = line.trim().match(/^(?:(\d+):)?(\d+):(\d+\.\d+)\s/)
    if (m) total += Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return total
}
try {
  let t
  for (let i = 0; i < 100 && !t; i++) { try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.title === 'Desktop pet') } catch {} ; if (!t) await sleep(250) }
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } }
  const ev = (expr) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res: (r) => res(r.result?.value), rej }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })) })
  for (let i = 0; i < 40 && (await ev('typeof window.__cat3d')) !== 'object'; i++) await sleep(250)
  console.log(`size ${await ev('window.__cat3d.size()')}px internal; sampling ${seconds}s per pose (the real pet keeps running; its own mode changes may interrupt a sample)`)
  console.log('pose        fps    avg ms   p95 ms   max ms   CPU % of one core (all app processes)')
  for (const pose of ['idle', 'walk', 'curious', 'thinking', 'speaking', 'sleeping', 'listening', 'carried']) {
    await ev(`window.__cat3d.live(${JSON.stringify(pose)}, 1)`)
    await sleep(1500) // let the blend settle
    const f0 = await ev('window.__cat3d.frames()')
    const c0 = cpuSeconds()
    await sleep(seconds * 1000)
    const c1 = cpuSeconds()
    const f1 = await ev('window.__cat3d.frames()')
    const tm = await ev('window.__cat3d.timing()')
    console.log(`${pose.padEnd(10)} ${String(((f1 - f0) / seconds).toFixed(1)).padStart(5)}  ${tm.avgMs.toFixed(2).padStart(7)}  ${tm.p95Ms.toFixed(2).padStart(7)}  ${tm.maxMs.toFixed(2).padStart(7)}   ${(((c1 - c0) / seconds) * 100).toFixed(1).padStart(6)}`)
  }
  ws.close()
} finally {
  try { const pid = execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n')[0]; if (pid) process.kill(Number(pid), 'SIGTERM') } catch {}
  await sleep(600)
  rmSync(userData, { recursive: true, force: true })
}
