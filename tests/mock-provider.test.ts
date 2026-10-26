import { describe, expect, it } from 'vitest'
import { MockProvider, sleep } from '../src/services/ai/mock-provider'
import { ProviderError } from '../src/services/ai/provider'

const fast = new MockProvider({ thinkMs: 1, wordMs: 1 })
async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const c of it) out += c
  return out
}

describe('MockProvider', () => {
  it('streams a canned reply that quotes the message', async () => {
    const out = await collect(fast.sendMessage('hello there'))
    expect(out).toContain('hello there')
    expect(out.endsWith(' ')).toBe(true)
  })
  it('/fail throws a ProviderError', async () => {
    await expect(collect(fast.sendMessage('/fail'))).rejects.toBeInstanceOf(ProviderError)
  })
  it('/midfail yields text and then fails', async () => {
    const got: string[] = []
    await expect(
      (async () => {
        for await (const c of fast.sendMessage('/midfail')) got.push(c)
      })()
    ).rejects.toBeInstanceOf(ProviderError)
    expect(got.length).toBeGreaterThan(3)
  })
  it('/long produces a long reply', async () => {
    expect((await collect(fast.sendMessage('/long'))).split(' ').length).toBeGreaterThan(100)
  })
  it('/hang never answers but stops promptly on abort', async () => {
    const ac = new AbortController()
    const p = collect(fast.sendMessage('/hang', undefined, ac.signal))
    setTimeout(() => ac.abort(), 10)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('aborting mid-stream stops the stream', async () => {
    const slow = new MockProvider({ thinkMs: 1, wordMs: 20 })
    const ac = new AbortController()
    let n = 0
    await expect(
      (async () => {
        for await (const _ of slow.sendMessage('/long', undefined, ac.signal)) if (++n === 3) ac.abort()
      })()
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(n).toBe(3)
  })
  it('sleep() rejects immediately for an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(sleep(1000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
