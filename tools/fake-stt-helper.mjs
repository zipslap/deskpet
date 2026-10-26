#!/usr/bin/env node
// Stand-in for native/speech-helper used by tests: never touches the microphone. Speaks the same JSON-lines protocol.
// Behaviour comes from $PET_FAKE_STT_MODE, or the first line of the file named by $PET_FAKE_STT_MODE_FILE (re-read on
// every start, so a test can change it between listens). Modes:
//   ok         listens, emits partials "hello" then "hello there"; "stop" -> final "hello there"; "cancel" -> cancelled
//   silence    like ok, but ends by itself after ~1.5 s with reason "silence" and the final text
//   nothing    listens, then ends with "no-speech" and no text
//   mic-denied / speech-denied   error + ended(error)
//   unavailable   error code "unavailable"
//   crash      says it is listening, then dies without saying goodbye
//   not-authorized   `status` reports notDetermined for both permissions
import { readFileSync } from 'node:fs'

const modeFromFile = () => {
  try { return readFileSync(process.env.PET_FAKE_STT_MODE_FILE, 'utf8').split('\n')[0].trim() } catch { return '' }
}
const mode = process.env.PET_FAKE_STT_MODE || modeFromFile() || 'ok'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const cmd = process.argv[2]

if (cmd === 'status') {
  const a = mode === 'not-authorized' ? 'notDetermined' : mode === 'mic-denied' ? 'denied' : 'authorized'
  out({ type: 'status', mic: a, speech: mode === 'speech-denied' ? 'denied' : a, available: true, onDevice: true })
  process.exit(0)
}
if (cmd !== 'listen') process.exit(2)

let text = ''
let done = false
const timers = []
const end = (reason, final) => {
  if (done) return
  done = true
  timers.forEach(clearInterval)
  if (final && text) out({ type: 'final', text })
  out({ type: 'ended', reason })
  process.exit(0)
}

if (mode === 'mic-denied' || mode === 'speech-denied') {
  out({ type: 'error', code: mode, message: `${mode} (fake)` })
  out({ type: 'ended', reason: 'error' })
  process.exit(0)
}
if (mode === 'unavailable') {
  out({ type: 'error', code: 'unavailable', message: 'Speech recognition is not available for xx-XX.' })
  out({ type: 'ended', reason: 'error' })
  process.exit(0)
}

out({ type: 'state', state: 'listening' })
if (mode === 'crash') setTimeout(() => process.exit(9), 150)
timers.push(setInterval(() => out({ type: 'level', level: 0.2 + Math.random() * 0.5 }), 100))
if (mode === 'ok' || mode === 'silence') {
  setTimeout(() => { text = 'hello'; out({ type: 'partial', text }) }, 300)
  setTimeout(() => { text = 'hello there'; out({ type: 'partial', text }) }, 600)
}
if (mode === 'silence') setTimeout(() => end('silence', true), 1500)
if (mode === 'nothing') setTimeout(() => end('no-speech', false), 1500)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  for (const line of d.split('\n').map((l) => l.trim())) {
    if (line === 'stop') end('stopped', true)
    if (line === 'cancel') end('cancelled', false)
  }
})
process.stdin.on('end', () => end('cancelled', false)) // parent gone: close the "microphone"
process.on('SIGTERM', () => end('cancelled', false))
