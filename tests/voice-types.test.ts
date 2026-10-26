import { describe, expect, it } from 'vitest'
import { IDLE_VOICE_STATE, parseVoiceState } from '../src/shared/voice-types'

describe('parseVoiceState', () => {
  it('accepts the idle state and a full state', () => {
    expect(parseVoiceState(IDLE_VOICE_STATE)).toEqual(IDLE_VOICE_STATE)
    const full = { ...IDLE_VOICE_STATE, phase: 'listening', level: 0.4, text: 'hi', error: { message: 'm', fix: 'microphone' }, notice: 'n', speaking: true, canListen: true }
    expect(parseVoiceState(full)).toEqual(full)
  })
  it('clamps the level', () => {
    expect(parseVoiceState({ ...IDLE_VOICE_STATE, level: 7 })?.level).toBe(1)
    expect(parseVoiceState({ ...IDLE_VOICE_STATE, level: -3 })?.level).toBe(0)
  })
  it.each([
    null, 1, 'x', {}, { ...IDLE_VOICE_STATE, phase: 'recording' }, { ...IDLE_VOICE_STATE, level: NaN }, { ...IDLE_VOICE_STATE, text: 5 },
    { ...IDLE_VOICE_STATE, final: 'yes' }, { ...IDLE_VOICE_STATE, muted: 1 }, { ...IDLE_VOICE_STATE, error: 'bad' },
    { ...IDLE_VOICE_STATE, error: { message: 1, fix: null } }, { ...IDLE_VOICE_STATE, error: { message: 'm', fix: 'camera' } },
    { ...IDLE_VOICE_STATE, notice: 3 }
  ])('rejects %j', (v) => expect(parseVoiceState(v)).toBeNull())
})
