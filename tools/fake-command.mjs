#!/usr/bin/env node
// A stand-in "command-line assistant" for tests: reads the prompt (stdin, or the argument after --prompt), prints a reply.
// Behaviour comes from FAKE_CMD_MODE: echo (default) | fail | silent | slow | long
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const pi = args.indexOf('--prompt')
const prompt = pi >= 0 ? args[pi + 1] : readFileSync(0, 'utf8')
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : ''
const mode = process.env.FAKE_CMD_MODE ?? 'echo'
if (mode === 'fail') {
  console.error('quota exceeded for this account')
  process.exit(3)
}
if (mode === 'silent') process.exit(0)
if (mode === 'long') {
  process.stdout.write('x'.repeat(5000))
  process.exit(0)
}
process.stdout.write(`model=${model};`)
process.stdout.write(`chars=${prompt.length};`)
process.stdout.write(`has-system=${prompt.includes('DeskPet')};`)
process.stdout.write(`last=${prompt.trim().split('\n').pop()}`)
if (mode === 'slow') setInterval(() => process.stdout.write('.'), 50)
