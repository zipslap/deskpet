#!/usr/bin/env node
// Stand-in for the `claude` command used by tests: speaks the same stream-json dialect, makes no network request.
// The scenario is read from ./fake-claude.json in the working directory (the provider strips the environment, so
// env vars cannot carry it): {"mode": "...", "reply": "...", "delayMs": 30, "auth": {...}}
// Every call is appended to ./fake-claude-calls.jsonl as {argv, envKeys, cwd, stdin, pid}.
import { appendFileSync, readFileSync } from 'node:fs'

let cfg = { mode: 'ok', reply: 'Meow! Nice to meet you.', delayMs: 5 }
try { cfg = { ...cfg, ...JSON.parse(readFileSync('fake-claude.json', 'utf8')) } } catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const argv = process.argv.slice(2)
const call = { argv, envKeys: Object.keys(process.env).sort(), cwd: process.cwd(), pid: process.pid, stdin: '' }

if (argv[0] === 'auth' && argv[1] === 'status') {
  appendFileSync('fake-claude-calls.jsonl', JSON.stringify(call) + '\n')
  out(cfg.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })
  process.exit(0)
}

let stdin = ''
process.stdin.setEncoding('utf8')
for await (const d of process.stdin) stdin += d
call.stdin = stdin
appendFileSync('fake-claude-calls.jsonl', JSON.stringify(call) + '\n')

const init = (extra = {}) => out({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], skills: [], slash_commands: [], apiKeySource: 'none', model: 'claude-haiku-5-5', ...extra })
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const result = (text, isError = false) => out({ type: 'result', subtype: 'success', is_error: isError, result: text })
const words = (s) => s.split(/(?<= )/)

switch (cfg.mode) {
  case 'tools': init({ tools: ['Bash', 'Read'] }); delta('should never be shown'); result('x'); break
  case 'connectors': init({ mcp_servers: [{ name: 'gmail' }] }); delta('should never be shown'); result('x'); break
  case 'skills': init({ skills: ['review'] }); delta('should never be shown'); result('x'); break
  case 'apikey': init({ apiKeySource: 'ANTHROPIC_API_KEY' }); delta('should never be shown'); result('x'); break
  case 'noinit': delta('sneaky'); result('sneaky'); break
  case 'autherr': init(); result('Not logged in · Please run /login', true); break
  case 'limit': init(); result("You've hit your limit · resets 3pm", true); break
  case 'network': init(); result('API Error: fetch failed ENOTFOUND api.anthropic.com', true); break
  case 'overloaded': init(); result('API Error: 529 overloaded_error', true); break
  case 'weird': init(); result('Something \u0007odd\nhappened', true); break
  case 'crash-start': process.stderr.write('boom: something broke\n'); process.exit(2); break
  case 'crash-start-auth': process.stderr.write('Error: Not logged in\n'); process.exit(1); break
  case 'crash-mid': init(); delta('Half a sen'); await sleep(20); process.exit(1); break
  case 'silent-ok': init(); process.exit(0); break
  case 'empty': init(); result(''); break
  case 'nodeltas': init(); out({ type: 'assistant', message: { content: [{ type: 'text', text: 'All at once.' }] } }); result('All at once.'); break
  case 'garbage': init(); process.stdout.write('not json\n'); delta('Hello '); process.stdout.write('{"type":"unknown"}\n[1,2]\n'); delta('there.'); result('Hello there.'); break
  case 'hang': init(); delta('Start '); setInterval(() => {}, 1000); process.on('SIGTERM', () => { if (cfg.ignoreTerm) return; process.exit(143) }); break
  case 'big': init(); for (let i = 0; i < 100; i++) delta('x'.repeat(1000)); result('x'); break
  case 'bigline': init(); process.stdout.write('x'.repeat(3 * 1024 * 1024) + '\n'); await sleep(2000); break
  default: { // ok
    init()
    for (const w of words(cfg.reply)) { await sleep(cfg.delayMs); delta(w) }
    result(cfg.reply)
  }
}
