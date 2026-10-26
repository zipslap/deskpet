import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, PLAYFUL_PERSONA } from '../src/services/ai/prompt'

describe('buildSystemPrompt is provider-neutral', () => {
  const now = new Date('2026-03-04T12:00:00Z')
  it('never names a particular model or vendor', () => {
    for (const p of [buildSystemPrompt({ now }), buildSystemPrompt({ now, persona: 'playful', spoken: true, screen: true, memory: 'm', memoryWrite: true })]) {
      expect(p).not.toMatch(/claude|anthropic|openai|gemini|chatgpt/i)
    }
  })
  it('the playful persona is named DeskPet, adds fun but keeps the model honest', () => {
    expect(PLAYFUL_PERSONA).toContain('DeskPet')
    expect(PLAYFUL_PERSONA).toMatch(/accurate, honest/)
    expect(buildSystemPrompt({ now, persona: 'playful' })).toContain(PLAYFUL_PERSONA)
    expect(buildSystemPrompt({ now, persona: 'plain' })).not.toContain(PLAYFUL_PERSONA)
    expect(buildSystemPrompt({ now })).not.toContain(PLAYFUL_PERSONA)
  })
  it('puts the memory in <memory> tags only when there is some', () => {
    expect(buildSystemPrompt({ now })).not.toContain('<memory>')
    expect(buildSystemPrompt({ now, memory: '### MEMORY.md\n- x' })).toContain('<memory>\n### MEMORY.md\n- x\n</memory>')
  })
})
