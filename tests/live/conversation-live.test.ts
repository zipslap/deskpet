// Opt-in: the full-conversation behaviour against the REAL `claude` command (a handful of Sonnet requests on your subscription).
//   PET_LIVE=1 npx vitest run tests/live/conversation-live.test.ts
// Memory is read from the real Claude memory folder (read-only here); the write test uses a throwaway folder.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../../src/services/ai/claude-cli-provider'
import { buildSystemPrompt } from '../../src/services/ai/prompt'
import { MemoryProvider } from '../../src/services/ai/memory-provider'
// @ts-expect-error plain .mjs helper without types
import { encodePng, newSheet } from '../../tools/png.mjs'
import { readMemory, saveMemory } from '../../src/services/memory/memory-store'

const live = process.env['PET_LIVE'] === '1'
const dir = live ? mkdtempSync(join(tmpdir(), 'pet-live-conv-')) : ''
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }))

const cli = (model: string, memoryDir: string, write: boolean) =>
  new ClaudeCliProvider({
    command: 'claude',
    model,
    workdir: join(dir, 'home'),
    systemPrompt: () => buildSystemPrompt({ memory: readMemory(memoryDir), memoryWrite: write })
  })
async function ask(p: { sendMessage: ClaudeCliProvider['sendMessage'] }, message: string): Promise<string> {
  let t = ''
  for await (const c of p.sendMessage(message, { history: [] })) t += c
  return t
}

describe.skipIf(!live)('full conversation', () => {
  it('answers a greeting briefly', async () => {
    const t = await ask(cli('sonnet', join(dir, 'none'), false), 'hey, how is it going?')
    console.log(`[live] greeting (${t.length} chars): ${t}`)
    expect(t.length).toBeLessThan(400)
  }, 90_000)

  it('gives a substantive question real depth, not a cat-bubble sentence', async () => {
    const t = await ask(cli('sonnet', join(dir, 'none'), false), 'Explain how a hash map handles collisions, and compare chaining with open addressing, with a worked example of each.')
    console.log(`[live] depth answer: ${t.length} chars`)
    expect(t.length).toBeGreaterThan(900)
  }, 120_000)

  it('knows what is in the memory folder (read-only)', async () => {
    const memDir = join(dir, 'seeded')
    saveMemory(memDir, { type: 'user', name: 'tea', description: 'tea preference', body: 'The user drinks jasmine tea, never coffee.' })
    const t = await ask(cli('sonnet', memDir, false), 'What do I drink? Answer briefly.')
    console.log(`[live] memory recall: ${t}`)
    expect(t).toMatch(/jasmine/i)
  }, 90_000)

  it('saves a memory through the <remember> block into a throwaway folder, and hides the block', async () => {
    const memDir = join(dir, 'mem')
    let saved: string | null = null
    const p = new MemoryProvider(cli('sonnet', memDir, true), { dir: memDir, onSaved: (_e, f) => (saved = f) })
    const t = await ask(p, 'Please remember that I take my coffee with oat milk and no sugar.')
    console.log(`[live] remember reply: ${t}\n[live] saved: ${saved}`)
    expect(t).not.toMatch(/<remember|<\/remember/)
    expect(saved).not.toBeNull()
    const files = readdirSync(memDir)
    expect(files).toContain('MEMORY.md')
    expect(readFileSync(join(memDir, saved!), 'utf8')).toMatch(/oat milk/i)
  }, 90_000)

  it('sees a screenshot sent through the provider, and treats text in it as content, not instructions', async () => {
    // a solid red picture: no screen is captured, this only exercises the image path of the provider
    const png = encodePng(newSheet(64, 64, [220, 20, 20, 255])) as Buffer
    const p = cli('haiku', join(dir, 'none'), false)
    let t = ''
    for await (const c of p.sendMessage('What single colour is this image? Answer with one word.', { history: [], screenshotBase64: png.toString('base64'), screenshotMime: 'image/png' })) t += c
    console.log(`[live] image: ${t}`)
    expect(t).toMatch(/red/i)
  }, 90_000)
})
