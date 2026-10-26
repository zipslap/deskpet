#!/usr/bin/env node
// Stand-in for /usr/bin/say used by tests: makes no sound. Reads the text from stdin like `say -f -`, appends one
// JSON line {args, text} to $PET_FAKE_SAY_LOG, then "speaks" for a time proportional to the text (PET_FAKE_SAY_MS_PER_CHAR,
// default 25 ms/char, max 6 s). If $PET_FAKE_SAY_FAIL is "1" it exits with an error instead.
import { appendFileSync } from 'node:fs'

let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (text += d))
process.stdin.on('end', () => {
  if (process.env.PET_FAKE_SAY_LOG) appendFileSync(process.env.PET_FAKE_SAY_LOG, JSON.stringify({ t: Date.now(), args: process.argv.slice(2), text }) + '\n')
  if (process.env.PET_FAKE_SAY_FAIL === '1') {
    console.error('say: Voice not found')
    process.exit(3)
  }
  const ms = Math.min(6000, 50 + text.length * Number(process.env.PET_FAKE_SAY_MS_PER_CHAR ?? 25))
  setTimeout(() => process.exit(0), ms)
})
