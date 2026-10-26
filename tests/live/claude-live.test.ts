// Opt-in: talks to the REAL `claude` command signed in on this Mac (a few short Haiku requests on your subscription).
//   PET_LIVE=1 npx vitest run tests/live
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../../src/services/ai/claude-cli-provider'

const live = process.env['PET_LIVE'] === '1'
const dir = live ? mkdtempSync(join(tmpdir(), 'pet-live-')) : ''
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }))

const mk = (env: NodeJS.ProcessEnv = process.env): ClaudeCliProvider => new ClaudeCliProvider({ command: 'claude', model: 'haiku', workdir: dir, env })
async function ask(p: ClaudeCliProvider, message: string, history: Array<{ role: 'user' | 'assistant'; text: string }> = [], signal?: AbortSignal) {
  const chunks: string[] = []
  const t0 = Date.now()
  let first = -1
  for await (const c of p.sendMessage(message, { history }, signal)) {
    if (first < 0) first = Date.now() - t0
    chunks.push(c)
  }
  return { chunks, text: chunks.join(''), firstMs: first, totalMs: Date.now() - t0 }
}

describe.skipIf(!live)('real claude command', () => {
  it('streams a reply, and a second message sees the first (history)', async () => {
    const p = mk()
    const a = await ask(p, 'My name is Sam. Reply with just: Nice to meet you, Sam.')
    console.log(`[live] first reply: ${JSON.stringify(a.text)} chunks=${a.chunks.length} firstChunk=${a.firstMs}ms total=${a.totalMs}ms`)
    expect(a.text.length).toBeGreaterThan(0)
    expect(a.chunks.length).toBeGreaterThan(0)
    const b = await ask(p, 'What is my name? Answer in one word.', [{ role: 'user', text: 'My name is Sam. Reply with just: Nice to meet you, Sam.' }, { role: 'assistant', text: a.text }])
    console.log(`[live] second reply: ${JSON.stringify(b.text)} firstChunk=${b.firstMs}ms total=${b.totalMs}ms`)
    expect(b.text).toMatch(/sam/i)
  }, 60_000)

  it('is not affected by an API key or cloud switch in the app environment (and uses the subscription)', async () => {
    const p = mk({ ...process.env, ANTHROPIC_API_KEY: 'sk-ant-live-test-not-real', CLAUDE_CODE_USE_BEDROCK: '1' })
    const r = await ask(p, 'Reply with the single word: ok')
    expect(r.text.length).toBeGreaterThan(0) // would fail with an auth error if the fake key had reached the child
  }, 60_000)

  it('cannot see tools, connectors or the user\'s files', async () => {
    const r = await ask(mk(), 'Without guessing: list any tools, connectors, or files you can access here. If none, say exactly NONE.')
    console.log(`[live] isolation reply: ${JSON.stringify(r.text)}`)
    expect(r.text).toMatch(/none/i)
    expect(r.text).not.toMatch(/gmail|calendar|drive|notion|bash/i)
  }, 60_000)

  it('aborting mid-reply stops the real process', async () => {
    const p = mk()
    const ac = new AbortController()
    let sawChunk = false
    let err: unknown = null
    try {
      for await (const _ of p.sendMessage('Count slowly from 1 to 200, one number per line.', {}, ac.signal)) {
        if (!sawChunk) {
          sawChunk = true
          ac.abort()
        }
      }
    } catch (e) {
      err = e
    }
    expect(sawChunk).toBe(true)
    expect((err as Error)?.name).toBe('AbortError')
  }, 60_000)
})
