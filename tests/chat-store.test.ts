import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadHistory, loadPrefs, saveHistory, savePrefs } from '../src/services/memory/chat-store'
import { ChatSession } from '../src/services/ai/chat-session'
import type { ChatMessage } from '../src/shared/chat-types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pet-store-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('history', () => {
  const msgs: ChatMessage[] = [
    { id: 1, role: 'user', text: 'hello' },
    { id: 2, role: 'notice', text: 'Cancelled.' },
    { id: 3, role: 'assistant', text: 'hi there' },
    { id: 4, role: 'assistant', text: '  ' }
  ]
  it('keeps real turns only, privately', () => {
    const p = join(dir, 'history.json')
    saveHistory(p, msgs)
    expect(loadHistory(p).map((m) => [m.role, m.text])).toEqual([['user', 'hello'], ['assistant', 'hi there']])
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o077).toBe(0) // (Windows has no permission bits)
  })
  it('a missing, corrupt or odd file is an empty conversation', () => {
    expect(loadHistory(join(dir, 'none.json'))).toEqual([])
    writeFileSync(join(dir, 'bad.json'), '{not json')
    expect(loadHistory(join(dir, 'bad.json'))).toEqual([])
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ messages: [1, null, { role: 'system', text: 'x' }, { role: 'user', text: 5 }, { role: 'user', text: 'ok' }] }))
    expect(loadHistory(join(dir, 'odd.json')).map((m) => m.text)).toEqual(['ok'])
  })
  it('stores at most the last 600', () => {
    const many: ChatMessage[] = Array.from({ length: 700 }, (_, i) => ({ id: i, role: 'user', text: `m${i}` }))
    const p = join(dir, 'h.json')
    saveHistory(p, many)
    const back = loadHistory(p)
    expect(back).toHaveLength(600)
    expect(back[599]!.text).toBe('m699')
  })
})

describe('prefs', () => {
  it('round-trips model and effort and ignores junk', () => {
    const p = join(dir, 'prefs.json')
    savePrefs(p, { model: 'opus', effort: 'high' })
    expect(loadPrefs(p)).toEqual({ model: 'opus', effort: 'high' })
    writeFileSync(p, JSON.stringify({ model: '--bad flag', effort: 'extreme' }))
    expect(loadPrefs(p)).toEqual({})
    expect(loadPrefs(join(dir, 'none.json'))).toEqual({})
    expect(readFileSync(join(dir, 'prefs.json'), 'utf8')).toContain('model')
  })
})

describe('ChatSession persistence', () => {
  const provider = { async *sendMessage(m: string, ctx?: { history?: unknown[] }) { yield `echo ${m} (history ${ctx?.history?.length ?? 0})` } }
  it('restores earlier turns, sends them as history, and reports each finished turn for saving', async () => {
    const saved: ChatMessage[][] = []
    const s = new ChatSession(provider, {
      onChange: () => {},
      onEvent: () => {},
      maxMessages: 600,
      initialMessages: [{ id: 9, role: 'user', text: 'old q' }, { id: 9, role: 'assistant', text: 'old a' }],
      onPersist: (m) => saved.push(m.map((x) => ({ ...x })))
    })
    expect(s.snapshot().messages.map((m) => m.text)).toEqual(['old q', 'old a'])
    expect(new Set(s.snapshot().messages.map((m) => m.id)).size).toBe(2)
    s.send('new q')
    await new Promise((r) => setTimeout(r, 30))
    const last = s.snapshot().messages.at(-1)!
    expect(last.text).toBe('echo new q (history 2)')
    expect(saved.length).toBeGreaterThanOrEqual(2) // on send, and when the reply finished
    expect(saved.at(-1)!.map((m) => m.text)).toEqual(['old q', 'old a', 'new q', 'echo new q (history 2)'])
    s.clear()
    expect(saved.at(-1)).toEqual([])
  })
  it('notice() adds a local note and setAssistant() changes the header info', () => {
    const s = new ChatSession(provider, { onChange: () => {}, onEvent: () => {}, assistant: { name: 'Claude (sonnet)', offline: false } })
    s.notice('Now using opus.')
    s.setAssistant({ name: 'Claude (opus)', offline: false, model: 'opus' })
    const snap = s.snapshot()
    expect(snap.messages.at(-1)).toMatchObject({ role: 'notice', text: 'Now using opus.' })
    expect(snap.assistant?.model).toBe('opus')
  })
})

describe('screenshots in the conversation', () => {
  const provider = { async *sendMessage(m: string, ctx?: { history?: Array<{ text: string }>; screenshotBase64?: string }) { yield `got ${ctx?.screenshotBase64 ? 'image' : 'no image'}; ${m}; history: ${(ctx?.history ?? []).map((h) => h.text).join(' | ')}` } }
  it('hands the image to the provider once, shows a preview, keeps no image in saved history, and tells later turns a screenshot was shared', async () => {
    const saved: ChatMessage[][] = []
    const s = new ChatSession(provider, { onChange: () => {}, onEvent: () => {}, onPersist: (m) => saved.push(m.map((x) => ({ ...x }))) })
    s.send('what is this?', { screenshotBase64: 'QUJD', screenshotMime: 'image/jpeg', thumbDataUrl: 'data:image/jpeg;base64,QUJD' })
    await new Promise((r) => setTimeout(r, 30))
    const msgs = s.snapshot().messages
    expect(msgs[0]).toMatchObject({ role: 'user', screen: true, image: 'data:image/jpeg;base64,QUJD' })
    expect(msgs[1]!.text).toContain('got image')
    const p = join(dir, 'h.json')
    saveHistory(p, saved.at(-1)!)
    const onDisk = readFileSync(p, 'utf8')
    expect(onDisk).not.toContain('QUJD')
    expect(onDisk).not.toContain('data:image')
    expect(loadHistory(p)[0]).toMatchObject({ role: 'user', screen: true })
    s.send('and now?')
    await new Promise((r) => setTimeout(r, 30))
    expect(s.snapshot().messages.at(-1)!.text).toContain('[Screenshot of my screen attached] what is this?')
    expect(s.snapshot().messages.at(-1)!.text).toContain('got no image')
  })
})

describe('prefs: where the cat lives and the panel size', () => {
  it('round-trips and bounds the size', () => {
    const p = join(dir, 'p.json')
    savePrefs(p, { model: 'opus', bringWithMe: true, roam: 'dock', chatSize: { w: 500, h: 520 } })
    expect(loadPrefs(p)).toEqual({ model: 'opus', bringWithMe: true, roam: 'dock', chatSize: { w: 500, h: 520 } })
    writeFileSync(p, JSON.stringify({ chatSize: { w: 5, h: 99999 }, bringWithMe: 'yes', roam: 'sky' }))
    expect(loadPrefs(p)).toEqual({ chatSize: { w: 340, h: 1400 } })
    writeFileSync(p, JSON.stringify({ chatSize: { w: 'a', h: 1 } }))
    expect(loadPrefs(p)).toEqual({})
  })
})

describe('prefs: resting', () => {
  it('round-trips rest and home; a bad home is ignored', () => {
    const p = join(dir, 'r.json')
    savePrefs(p, { rest: false, home: { x: 640, y: 480 } })
    expect(loadPrefs(p)).toEqual({ rest: false, home: { x: 640, y: 480 } })
    writeFileSync(p, JSON.stringify({ rest: 'yes', home: { x: 'a', y: 2 } }))
    expect(loadPrefs(p)).toEqual({})
    writeFileSync(p, JSON.stringify({ home: { x: 1e9, y: 0 } }))
    expect(loadPrefs(p)).toEqual({})
    writeFileSync(p, JSON.stringify({ home: { x: 10.6, y: 20.2 } }))
    expect(loadPrefs(p).home).toEqual({ x: 11, y: 20 })
  })
})
