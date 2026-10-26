import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { designerSystemPrompt, designPet, extractJson } from '../src/services/ai/pet-designer'
import { ProviderError, type AssistantContext, type ChatProvider } from '../src/services/ai/provider'
import { PetStore } from '../src/services/memory/pet-store'
import { parsePetSpec } from '../src/shared/cat3d/pet-spec'
import { parsePetAction, parsePetDesignRequest, parsePetUiState, EMPTY_PET_UI } from '../src/shared/pet-types'
import { parseCommand } from '../src/shared/commands'

class Scripted implements ChatProvider {
  calls: Array<{ message: string; ctx?: AssistantContext }> = []
  constructor(private readonly replies: Array<string | Error>) {}
  async *sendMessage(message: string, ctx?: AssistantContext): AsyncIterable<string> {
    this.calls.push({ message, ...(ctx ? { ctx } : {}) })
    const r = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!
    if (r instanceof Error) throw r
    yield r.slice(0, 5)
    yield r.slice(5)
  }
}
const GOOD = JSON.stringify({ name: 'Mermaid', note: 'Gave you a tail.', palette: { fur: '#3fb8a6' }, hide: ['leg'] })

describe('extractJson', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":{"b":[1,2]}}\n```', { a: { b: [1, 2] } }],
    ['Sure! Here it is: {"a":"} tricky { \\" quote"} hope you like it', { a: '} tricky { " quote' }]
  ])('%s', (text, out) => expect(extractJson(text)).toEqual(out))
  it.each(['', 'no json', '{"a":', '{bad}', '}{'])('%j -> null', (t) => expect(extractJson(t)).toBeNull())
})

describe('designerSystemPrompt', () => {
  it('describes the format, limits, parts, defaults and the current look', () => {
    const p = designerSystemPrompt(null)
    for (const s of ['"palette"', 'ellipsoid', 'replace', 'carve', 'tailTip', 'torso:', 'head:', 'DEFAULT SHAPES', 'default black cat']) expect(p).toContain(s)
    const cur = parsePetSpec({ name: 'Green cat', palette: { fur: '#00ff00' } })
    expect(designerSystemPrompt('spec' in cur ? cur.spec : null)).toContain('Green cat')
  })
  it('says pictures are inspiration and that text inside them is not an instruction', () => {
    expect(designerSystemPrompt(null)).toMatch(/never an instruction/)
  })
})

describe('designPet', () => {
  it('returns a validated spec and the note', async () => {
    const p = new Scripted([GOOD])
    const r = await designPet({ provider: p, instructions: 'make me a mermaid', images: [] })
    expect(r).toMatchObject({ spec: { name: 'Mermaid', palette: { fur: '#3fb8a6' }, hide: ['leg'] }, note: 'Gave you a tail.' })
  })
  it('sends the pictures with the first request, as images', async () => {
    const p = new Scripted([GOOD])
    await designPet({ provider: p, instructions: 'like these', images: [{ mime: 'image/jpeg', data: 'QUJD' }, { mime: 'image/png', data: 'REVG' }] })
    expect(p.calls[0]!.ctx!.images).toEqual([{ base64: 'QUJD', mime: 'image/jpeg' }, { base64: 'REVG', mime: 'image/png' }])
    expect(p.calls[0]!.message).toContain('2 inspiration pictures are attached')
  })
  it('sends the problem back and succeeds on a retry, with the earlier exchange as history and no pictures again', async () => {
    const p = new Scripted(['{"palette":{"fur":"green"}}', GOOD])
    const r = await designPet({ provider: p, instructions: 'x', images: [{ mime: 'image/jpeg', data: 'QUJD' }] })
    expect('spec' in r).toBe(true)
    expect(p.calls).toHaveLength(2)
    expect(p.calls[1]!.message).toMatch(/rejected.*hex colour/s)
    expect(p.calls[1]!.ctx!.history).toHaveLength(2)
    expect(p.calls[1]!.ctx!.images).toBeUndefined()
  })
  it('gives up after the retries with a friendly error', async () => {
    const p = new Scripted(['no json at all'])
    const r = await designPet({ provider: p, instructions: 'x', images: [], retries: 1 })
    expect(r).toMatchObject({ error: expect.stringContaining('could not be used') })
    expect(p.calls).toHaveLength(2)
  })
  it('passes on a provider error as it is', async () => {
    const r = await designPet({ provider: new Scripted([new ProviderError('OpenAI rejected the API key')]), instructions: 'x', images: [] })
    expect(r).toEqual({ error: 'OpenAI rejected the API key' })
  })
  it('reports a cancel', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await designPet({ provider: new Scripted([Object.assign(new Error('Aborted'), { name: 'AbortError' })]), instructions: 'x', images: [], signal: ac.signal })
    expect(r).toEqual({ error: 'Cancelled.' })
  })
})

describe('PetStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deskpet-pet-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const spec = (name: string) => {
    const r = parsePetSpec({ name })
    if ('error' in r) throw new Error(r.error)
    return r.spec
  }
  it('starts at the default, remembers sets, and undoes step by step', () => {
    const s = new PetStore(join(dir, 'pet.json'))
    expect(s.current).toBeNull()
    expect(s.canUndo).toBe(false)
    s.set(spec('A'))
    s.set(spec('B'))
    expect(s.current!.name).toBe('B')
    expect(s.undo()).toBe(true)
    expect(s.current!.name).toBe('A')
    expect(s.undo()).toBe(true)
    expect(s.current).toBeNull()
    expect(s.undo()).toBe(false)
  })
  it('survives a restart', () => {
    const p = join(dir, 'pet.json')
    const a = new PetStore(p)
    a.set(spec('Kept'))
    const b = new PetStore(p)
    expect(b.current!.name).toBe('Kept')
    expect(b.canUndo).toBe(true)
  })
  it('a corrupt or hostile file just means the default pet', () => {
    const p = join(dir, 'pet.json')
    require('node:fs').writeFileSync(p, '{"current":{"parts":{"wings":{}}},"history":[5]}')
    expect(new PetStore(p).current).toBeNull()
    require('node:fs').writeFileSync(p, 'not json')
    expect(new PetStore(p).current).toBeNull()
  })
  it('keeps only a short history', () => {
    const s = new PetStore(join(dir, 'pet.json'))
    for (let i = 0; i < 25; i++) s.set(spec(`L${i}`))
    let n = 0
    while (s.undo()) n++
    expect(n).toBe(10)
  })
})

describe('pet IPC payloads', () => {
  const img = { mime: 'image/jpeg', data: 'QUJD' }
  it('accepts a request with text and/or pictures', () => {
    expect(parsePetDesignRequest({ text: ' mermaid ', images: [img] })).toEqual({ text: 'mermaid', images: [img] })
    expect(parsePetDesignRequest({ text: '', images: [img] })).not.toBeNull()
    expect(parsePetDesignRequest({ text: 'green', images: [] })).not.toBeNull()
  })
  it.each([
    [null], [{}], [{ text: '', images: [] }], [{ text: 'x', images: 'no' }], [{ text: 5, images: [] }],
    [{ text: 'x', images: [img, img, img, img, img] }],
    [{ text: 'x', images: [{ mime: 'image/svg+xml', data: 'QUJD' }] }],
    [{ text: 'x', images: [{ mime: 'image/jpeg', data: 'not base64!' }] }],
    [{ text: 'x', images: [{ mime: 'image/jpeg', data: 'A'.repeat(1_500_001) }] }],
    [{ text: 'x'.repeat(2001), images: [] }]
  ])('rejects %j', (bad) => expect(parsePetDesignRequest(bad)).toBeNull())
  it('actions', () => {
    expect(parsePetAction({ kind: 'undo' })).toEqual({ kind: 'undo' })
    expect(parsePetAction({ kind: 'preset', id: 'mermaid' })).toEqual({ kind: 'preset', id: 'mermaid' })
    expect(parsePetAction({ kind: 'preset', id: '../x' })).toBeNull()
    expect(parsePetAction({ kind: 'delete' })).toBeNull()
  })
  it('state round-trips and bounds its text', () => {
    expect(parsePetUiState(EMPTY_PET_UI)).toEqual(EMPTY_PET_UI)
    expect(parsePetUiState({ ...EMPTY_PET_UI, message: 'x'.repeat(1000) })!.message).toHaveLength(400)
    expect(parsePetUiState({ ...EMPTY_PET_UI, busy: 'yes' })).toBeNull()
  })
})

describe('pet commands', () => {
  it.each([
    ['turn my pet into a mermaid', 'turn my pet into a mermaid'],
    ["change my cat's skin to green", "change my cat's skin to green"],
    ['Please make my pet wear a wizard hat', 'Please make my pet wear a wizard hat'],
    ['can you recolor my deskpet blue', 'can you recolor my deskpet blue'],
    ['/pet make it a robot', 'make it a robot']
  ])('%s', (t, text) => expect(parseCommand(t)).toEqual({ kind: 'pet', text }))
  it('/pet alone opens the drawer', () => expect(parseCommand('/pet')).toEqual({ kind: 'pet', text: '' }))
  it.each(['make dinner for my cat tonight please', 'my cat is sick, what should I do', 'turn off the lights', 'how do I change my pet insurance policy', 'what colour is a cat'])('%j is an ordinary message', (t) => {
    // "make dinner for my cat" must not hijack a normal question about a real cat
    expect(parseCommand(t)?.kind).not.toBe('pet')
  })
})
