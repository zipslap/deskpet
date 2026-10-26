import { describe, expect, it } from 'vitest'
import { SentenceSplitter } from '../src/services/voice/sentence-splitter'

describe('SentenceSplitter', () => {
  it('emits a sentence once its end is seen, keeping the remainder', () => {
    const s = new SentenceSplitter()
    expect(s.push('Hello there. How are')).toEqual(['Hello there.'])
    expect(s.push(' you? I am fine')).toEqual(['How are you?'])
    expect(s.flush()).toEqual(['I am fine'])
  })
  it('does not split on a bare period inside a number or at the very end of the buffer', () => {
    const s = new SentenceSplitter()
    expect(s.push('Pi is 3.14 roughly. Ok.')).toEqual(['Pi is 3.14 roughly.']) // "Ok." waits: the next chunk may continue it
    expect(s.flush()).toEqual(['Ok.'])
  })
  it('handles chunks that split a sentence anywhere', () => {
    const s = new SentenceSplitter()
    const out: string[] = []
    for (const ch of 'One. Two! Three? Four') out.push(...s.push(ch))
    out.push(...s.flush())
    expect(out).toEqual(['One.', 'Two!', 'Three?', 'Four'])
  })
  it('splits at newlines and ellipses', () => {
    const s = new SentenceSplitter()
    expect(s.push('line one\nline two… and more')).toEqual(['line one', 'line two…'])
  })
  it('cuts a very long run without punctuation so the voice never waits forever', () => {
    const s = new SentenceSplitter(60)
    const out = s.push('word '.repeat(40))
    expect(out.length).toBeGreaterThan(1)
    expect(out.every((x) => x.length <= 60)).toBe(true)
    expect([...out, ...s.flush()].join(' ').replace(/\s+/g, ' ').trim()).toBe('word '.repeat(40).trim())
  })
  it('reset drops buffered text; flush of nothing is empty', () => {
    const s = new SentenceSplitter()
    s.push('half a sent')
    s.reset()
    expect(s.flush()).toEqual([])
  })
})
