import { describe, expect, it } from 'vitest'
import { parseModelChoice } from '../src/shared/chat-types'
import { parseCommand } from '../src/shared/commands'

const MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'gpt-4o', 'gemini-2.5-flash', 'openai/gpt-4o']

describe('parseCommand', () => {
  it.each(['/model opus', '/Model OPUS', 'switch to opus', 'Switch to the opus model.', 'use sonnet', 'please use the fable model', 'go to haiku', 'Change to opus!', 'switch to gpt-4o', 'use gemini-2.5-flash', 'switch to openai/gpt-4o'])('%j picks a model', (t) => {
    expect(parseCommand(t, MODELS)).toMatchObject({ kind: 'model' })
  })
  it('matches a known model name regardless of case, and keeps the service\'s own spelling', () => {
    expect(parseCommand('switch to Opus', MODELS)).toEqual({ kind: 'model', model: 'opus' })
    expect(parseCommand('/model GPT-4O', MODELS)).toEqual({ kind: 'model', model: 'gpt-4o' })
  })
  it('does not know any model names unless it is told them', () => {
    expect(parseCommand('switch to opus')).toBeNull()
    expect(parseCommand('use sonnet')).toBeNull()
  })
  it('accepts any well-formed model name after /model, case preserved', () => {
    expect(parseCommand('/model claude-opus-5-5')).toEqual({ kind: 'model', model: 'claude-opus-5-5' })
    expect(parseCommand('/model Llama3.2:Latest')).toEqual({ kind: 'model', model: 'Llama3.2:Latest' })
    expect(parseCommand('/model mistralai/Mistral-7B')).toEqual({ kind: 'model', model: 'mistralai/Mistral-7B' })
  })
  it.each(['/model', '/model --dangerously-skip-permissions', '/model a b c;d', '/model $(id)', '/effort', '/effort extreme'])('%j is a bad command', (t) => {
    expect(parseCommand(t)).toMatchObject({ kind: 'bad' })
  })
  it('effort', () => expect(parseCommand('/effort high')).toEqual({ kind: 'effort', effort: 'high' }))
  it.each(['/new', '/clear'])('%j starts a new chat', (t) => expect(parseCommand(t)).toEqual({ kind: 'new' }))
  it('/help', () => expect(parseCommand('/help')).toEqual({ kind: 'help' }))
  it.each([
    'switch to opus and explain how vaccines work',
    'can you switch to opus?',
    'I use sonnet at work, what do you think of it',
    'hello',
    '/slow',
    '/fail now',
    'what does /model do'
  ])('%j goes to the assistant as a normal message', (t) => expect(parseCommand(t, MODELS)).toBeNull())
})

describe('parseModelChoice', () => {
  it('accepts model and/or effort', () => {
    expect(parseModelChoice({ model: 'opus' })).toEqual({ model: 'opus' })
    expect(parseModelChoice({ effort: 'high' })).toEqual({ effort: 'high' })
    expect(parseModelChoice({ model: 'sonnet', effort: 'auto' })).toEqual({ model: 'sonnet', effort: 'auto' })
  })
  it.each([null, 'opus', {}, { model: '' }, { model: '--x y' }, { model: 5 }, { effort: 'extreme' }, { model: 'opus', effort: 'x' }, [] as unknown])('rejects %j', (bad) => {
    expect(parseModelChoice(bad)).toBeNull()
  })
})

describe('parseCommand: look at the screen', () => {
  it.each(['/screen', '/screen what is this error?', 'look at my screen', 'Please look at my screen.', 'can you look at my screen and tell me what is wrong', 'check the screen now', 'Hey, take a look at my screen!', 'read this screen for me'])('%j asks for a screenshot', (t) => {
    expect(parseCommand(t)).toMatchObject({ kind: 'look' })
  })
  it('/screen without a question uses a default one, with one it passes the question on', () => {
    expect(parseCommand('/screen')).toMatchObject({ kind: 'look', question: expect.stringContaining('on my screen') })
    expect(parseCommand('/screen why is this red?')).toEqual({ kind: 'look', question: 'why is this red?' })
  })
  it('a spoken request keeps the whole sentence as the question', () => {
    expect(parseCommand('look at my screen and tell me what is wrong')).toEqual({ kind: 'look', question: 'look at my screen and tell me what is wrong' })
  })
  it.each(['check the screen saver settings', 'I look at my screen all day', 'see my screenshots folder', 'what is a screen reader', 'look at my screenplay', 'read the screen resolution docs'])('%j is a normal message', (t) => {
    expect(parseCommand(t)).toBeNull()
  })
})
