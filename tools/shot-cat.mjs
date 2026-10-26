// Launches the real app, puts the 3D cat into each pose through the debug hook, captures the pet window over DevTools and
// stitches a contact sheet. For looking at the cat; not a test.
//   node tools/shot-cat.mjs [out.png] [--view=figure|3d] [--bg=light|dark] [--poses=idle,walk] [--px=1|2|4] [--coat=black] [--scale=3] [--spec=assets/pets/mermaid.json]
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { blit, decodePng, encodePng, newSheet } from './png.mjs'

const args = process.argv.slice(2)
const flag = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${def}`).split('=')[1]
const out = args.find((a) => !a.startsWith('--')) ?? 'docs/shots/cat3d-poses.png'
const bg = flag('bg', 'light') === 'dark' ? [32, 34, 40, 255] : [214, 222, 228, 255]
const poses = flag('poses', 'idle,walk,curious,thinking,speaking,sleeping,listening,carried').split(',')
const times = flag('times', '0.4,1.1,2.3').split(',').map(Number)
const PORT = await new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
const userData = mkdtempSync(join(tmpdir(), 'pet-shot-'))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ cat: { view: flag('view', 'figure'), coat: flag('coat', 'black'), pixelSize: Number(flag('px', 2)) } }))
const app = spawn('node_modules/.bin/electron-vite', ['preview'], { env: { ...process.env, PET_E2E: '1', PET_USER_DATA: userData, PET_E2E_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
app.stderr.on('data', (d) => (stderr += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 100; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.title === 'Desktop pet'); if (t) return t } catch {}
    await sleep(250)
  }
  throw new Error('pet page never appeared\n' + stderr)
}
try {
  const t = await target()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } }
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
  await ev(`document.documentElement.style.background = 'rgb(${bg[0]},${bg[1]},${bg[2]})'`)
  for (let i = 0; i < 40 && !(await ev('typeof window.__cat3d')).startsWith('obj'); i++) await sleep(250)
  const view = await ev('window.__cat3d ? window.__cat3d.view() : "none"')
  console.log('view:', view, ' internal size:', await ev('window.__cat3d && window.__cat3d.size()'))
  if (view !== '3d') throw new Error('3D view is not active (WebGL unavailable?)\n' + stderr)

  if (flag('spec', '')) {
    const r = await ev(`window.__cat3d.spec(${JSON.stringify(readFileSync(flag('spec', ''), 'utf8'))})`)
    if (r !== 'ok') throw new Error('spec rejected: ' + r)
    await sleep(300)
  }
  const cells = []
  for (const pose of poses) {
    const row = []
    for (const [dir, tt] of times.map((tt, i) => [i === 2 ? -1 : 1, tt])) {
      await ev(`window.__cat3d.freeze(${JSON.stringify(pose)}, ${dir}, ${tt})`)
      await sleep(120)
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 100, height: 100, scale: Number(flag('scale', 3)) } })
      row.push(decodePng(Buffer.from(shot.data, 'base64')))
    }
    cells.push(row)
  }
  const cw = cells[0][0].width, ch = cells[0][0].height
  const sheet = newSheet(cw * times.length, ch * poses.length, bg)
  cells.forEach((row, r) => row.forEach((img, c) => blit(sheet, img, c * cw, r * ch)))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, encodePng(sheet))
  console.log(`wrote ${out}  (${sheet.width}x${sheet.height}, cell ${cw}x${ch}; rows: ${poses.join(', ')})`)
  ws.close()
} finally {
  try { const pid = execFileSync('pgrep', ['-f', `${process.cwd()}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`], { encoding: 'utf8' }).split('\n')[0]; if (pid) process.kill(Number(pid), 'SIGTERM') } catch {}
  await sleep(600)
  rmSync(userData, { recursive: true, force: true })
}
