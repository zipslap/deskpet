import { describe, expect, it } from 'vitest'
import { ChatSession } from '../src/services/ai/chat-session'
import { buildSummaryRequest, cleanSummary, planCompaction, summaryTurn, MIN_KEEP_TURNS, type Summarizable } from '../src/services/memory/summary'
import { loadConversation, saveHistory } from '../src/services/memory/chat-store'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '../src/shared/chat-types'

const convo = (n: number, size: number, extra: Partial<Summarizable> = {}): Summarizable[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `m${i} ${'x'.repeat(size)}`, ...extra }) as Summarizable)

describe('planCompaction', () => {
  it('does nothing while the conversation is short enough', () => {
    expect(planCompaction(convo(20, 100))).toBeNull()
    expect(planCompaction(convo(40, 1000), 60_000, 20_000)).toBeNull()
  })
  it('does nothing for a few huge messages (nothing older to fold in)', () => {
    expect(planCompaction(convo(MIN_KEEP_TURNS + 1, 50_000))).toBeNull()
  })
  it('folds the older part when it is too long, keeping a recent tail that starts on a user message', () => {
    const m = convo(100, 1000)
    const split = planCompaction(m, 60_000, 20_000)!
    expect(split).toBeGreaterThan(0)
    expect(split).toBeLessThan(m.length)
    expect(m[split]!.role).toBe('user')
    const kept = m.slice(split).reduce((n, x) => n + x.text.length, 0)
    expect(kept).toBeLessThanOrEqual(20_000 + 2000)
    expect(m.length - split).toBeGreaterThanOrEqual(MIN_KEEP_TURNS - 1)
  })
  it('ignores notices and already-summarised messages when measuring', () => {
    const m: Summarizable[] = [...convo(100, 1000, { summarized: true }), ...convo(10, 100)]
    expect(planCompaction(m)).toBeNull()
    expect(planCompaction([{ role: 'notice', text: 'x'.repeat(100_000) }, ...convo(4, 10)])).toBeNull()
  })
})

describe('summary text helpers', () => {
  it('builds a request with the previous summary and the new turns', () => {
    const r = buildSummaryRequest('The user likes tea.', [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }])
    expect(r).toContain('The user likes tea.')
    expect(r).toContain('User: hello')
    expect(r).toContain('Assistant: hi')
    expect(buildSummaryRequest('', [])).toContain('(none)')
  })
  it('bounds a huge turn', () => {
    expect(buildSummaryRequest('', [{ role: 'user', text: 'x'.repeat(100_000) }]).length).toBeLessThan(7000)
  })
  it('the summary reaches the model as a clearly marked user turn', () => {
    expect(summaryTurn(' gist ')).toEqual({ role: 'user', text: expect.stringContaining('Summary of the earlier part of our conversation') })
    expect(summaryTurn('gist').text.endsWith('gist')).toBe(true)
  })
  it('cleanSummary trims and bounds', () => {
    expect(cleanSummary('  a  \n  b \n')).toBe('a\n  b')
    expect(cleanSummary('x'.repeat(10_000))).toHaveLength(4000)
  })
})

describe('ChatSession compaction', () => {
  const provider = (log: string[][]) => ({
    async *sendMessage(_m: string, ctx?: { history?: Array<{ text: string }> }) {
      log.push((ctx?.history ?? []).map((h) => h.text.slice(0, 40)))
      yield 'ok'
    }
  })
  const bigInitial = (): ChatMessage[] => Array.from({ length: 80 }, (_, i) => ({ id: i + 1, role: i % 2 ? 'assistant' : 'user', text: `old${i} ${'y'.repeat(1000)}` }))

  it('after a reply, folds the older part into a summary, flags those messages, saves, and then sends summary + recent turns', async () => {
    const histories: string[][] = []
    const asked: Array<{ previous: string; n: number }> = []
    const saved: Array<{ n: number; summary: string; flagged: number }> = []
    const s = new ChatSession(provider(histories), {
      onChange: () => {},
      onEvent: () => {},
      maxMessages: 600,
      initialMessages: bigInitial(),
      summarizer: async (previous, turns) => (asked.push({ previous, n: turns.length }), 'GIST: the user discussed old things.'),
      onPersist: (m, sum) => saved.push({ n: m.length, summary: sum, flagged: m.filter((x) => x.summarized).length })
    })
    s.send('new question')
    await new Promise((r) => setTimeout(r, 60))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.previous).toBe('')
    expect(asked[0]!.n).toBeGreaterThan(20)
    expect(s.summaryText).toContain('GIST')
    const snap = s.snapshot().messages
    expect(snap.filter((m) => m.summarized).length).toBe(asked[0]!.n)
    expect(snap.some((m) => m.role === 'notice' && /summarised/.test(m.text))).toBe(true)
    expect(saved.at(-1)!.summary).toContain('GIST')
    expect(saved.at(-1)!.flagged).toBeGreaterThan(20)
    // the next message sends the summary and only the unsummarised turns
    s.send('another')
    await new Promise((r) => setTimeout(r, 60))
    const h = histories.at(-1)!
    expect(h[0]).toContain('Summary of the earlier part')
    expect(h.some((t) => t.startsWith('old0'))).toBe(false)
    expect(h.length).toBeLessThan(40)
    expect(h.some((t) => t.startsWith('new question'))).toBe(true)
  })

  it('a second compaction carries the previous summary forward', async () => {
    const asked: string[] = []
    const s = new ChatSession(provider([]), {
      onChange: () => {},
      onEvent: () => {},
      maxMessages: 600,
      initialMessages: bigInitial(),
      initialSummary: 'EARLIER GIST',
      summarizer: async (previous) => (asked.push(previous), 'NEW GIST'),
    })
    s.send('q')
    await new Promise((r) => setTimeout(r, 60))
    expect(asked).toEqual(['EARLIER GIST'])
    expect(s.summaryText).toBe('NEW GIST')
  })

  it('a failing summarizer changes nothing and does not disturb the chat', async () => {
    const s = new ChatSession(provider([]), {
      onChange: () => {},
      onEvent: () => {},
      maxMessages: 600,
      initialMessages: bigInitial(),
      summarizer: async () => {
        throw new Error('offline')
      }
    })
    s.send('q')
    await new Promise((r) => setTimeout(r, 60))
    expect(s.summaryText).toBe('')
    expect(s.snapshot().messages.some((m) => m.summarized)).toBe(false)
    expect(s.snapshot().messages.at(-1)!.text).toBe('ok')
  })

  it('never summarises without a summarizer, and short chats are left alone', async () => {
    const s1 = new ChatSession(provider([]), { onChange: () => {}, onEvent: () => {}, maxMessages: 600, initialMessages: bigInitial() })
    s1.send('q')
    await new Promise((r) => setTimeout(r, 40))
    expect(s1.summaryText).toBe('')
    let called = false
    const s2 = new ChatSession(provider([]), { onChange: () => {}, onEvent: () => {}, summarizer: async () => ((called = true), 'x') })
    s2.send('hi')
    await new Promise((r) => setTimeout(r, 40))
    expect(called).toBe(false)
  })

  it('clearSummary forgets the summary but keeps the dimmed messages on screen; clear() removes everything', async () => {
    const saved: string[] = []
    const s = new ChatSession(provider([]), {
      onChange: () => {},
      onEvent: () => {},
      maxMessages: 600,
      initialMessages: bigInitial(),
      summarizer: async () => 'GIST',
      onPersist: (_m, sum) => saved.push(sum)
    })
    s.send('q')
    await new Promise((r) => setTimeout(r, 60))
    s.clearSummary()
    expect(s.summaryText).toBe('')
    expect(saved.at(-1)).toBe('')
    expect(s.snapshot().messages.some((m) => m.summarized)).toBe(true)
    s.send('after')
    await new Promise((r) => setTimeout(r, 40))
    s.clear()
    expect(s.snapshot().messages).toEqual([])
  })
})

describe('the summary on disk', () => {
  it('round-trips messages, the summarised flags and the summary text, privately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-sum-'))
    try {
      const p = join(dir, 'h.json')
      saveHistory(p, [{ id: 1, role: 'user', text: 'a', summarized: true }, { id: 2, role: 'assistant', text: 'b' }], 'The gist.')
      const c = loadConversation(p)
      expect(c.summary).toBe('The gist.')
      expect(c.messages.map((m) => [m.text, m.summarized ?? false])).toEqual([['a', true], ['b', false]])
      writeFileSync(join(dir, 'old.json'), JSON.stringify({ messages: [{ role: 'user', text: 'x' }] }))
      expect(loadConversation(join(dir, 'old.json'))).toEqual({ messages: [{ id: 1, role: 'user', text: 'x' }], summary: '' })
      writeFileSync(join(dir, 'bad.json'), '{')
      expect(loadConversation(join(dir, 'bad.json'))).toEqual({ messages: [], summary: '' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
