import { describe, expect, it } from 'vitest'
import { parseSnapshot } from '../src/shared/chat-types'
import { MAX_MESSAGE_CHARS, MODES, parseChatText, parseHover, parseStateMessage } from '../src/shared/ipc'
import { ANIM_NAMES, FRAME, GROUND_MARGIN, ROWS, SCALE, WINDOW_SIZE, animationFor } from '../src/shared/sprite'

describe('IPC validation', () => {
  it('accepts well-formed state messages', () => {
    expect(parseStateMessage({ mode: 'thinking', dir: -1, dragging: false })).toEqual({ mode: 'thinking', dir: -1, heading: 'side', dragging: false })
    expect(parseStateMessage({ mode: 'walking', dir: 1, heading: 'away', dragging: false })?.heading).toBe('away')
    expect(parseStateMessage({ mode: 'eating', dir: 1, heading: 'sideways!', dragging: false })?.heading).toBe('side') // unknown heading: sideways
    for (const mode of MODES) expect(parseStateMessage({ mode, dir: 1, dragging: true })).not.toBeNull()
  })
  it.each([
    null, undefined, 3, 'x', {}, { mode: 'fly', dir: 1, dragging: false }, { mode: 'idle', dir: 2, dragging: false },
    { mode: 'idle', dir: 1 }, { mode: 'idle', dir: 1, dragging: 'no' }, { dir: 1, dragging: false }
  ])('rejects malformed state message %j', (v) => expect(parseStateMessage(v)).toBeNull())

  it('hover must be a real boolean', () => {
    expect(parseHover(true)).toBe(true)
    expect(parseHover(false)).toBe(false)
    for (const v of [1, 0, 'true', null, undefined, {}]) expect(parseHover(v)).toBeNull()
  })

  it('chat text: non-empty, trimmed, bounded, string only', () => {
    expect(parseChatText('  hi  ')).toBe('hi')
    for (const v of ['', '   ', 5, null, undefined, {}, ['a'], 'x'.repeat(MAX_MESSAGE_CHARS + 1)]) expect(parseChatText(v)).toBeNull()
    expect(parseChatText('x'.repeat(MAX_MESSAGE_CHARS))).toHaveLength(MAX_MESSAGE_CHARS)
  })
})

describe('snapshot validation', () => {
  it('accepts a good snapshot and drops unknown fields', () => {
    const s = parseSnapshot({ status: 'streaming', messages: [{ id: 1, role: 'user', text: 'a', extra: 1 }, { id: 2, role: 'notice', text: 'b', error: true }] })
    expect(s).toEqual({ status: 'streaming', messages: [{ id: 1, role: 'user', text: 'a' }, { id: 2, role: 'notice', text: 'b', error: true }] })
  })
  it.each([
    null, 1, {}, { messages: [], status: 'busy' }, { messages: 'x', status: 'idle' },
    { messages: [{ id: '1', role: 'user', text: 'a' }], status: 'idle' },
    { messages: [{ id: 1, role: 'admin', text: 'a' }], status: 'idle' },
    { messages: [null], status: 'idle' }
  ])('rejects %j', (v) => expect(parseSnapshot(v)).toBeNull())
  it('keeps a valid assistant description, bounded, and drops a malformed one', () => {
    const base = { status: 'idle', messages: [] }
    expect(parseSnapshot({ ...base, assistant: { name: 'Claude (haiku)', offline: false } })?.assistant).toEqual({ name: 'Claude (haiku)', offline: false })
    expect(parseSnapshot({ ...base, assistant: { name: 'x'.repeat(500), offline: true } })?.assistant?.name).toHaveLength(60)
    for (const bad of [{ name: 5, offline: true }, { name: 'a' }, 'claude', null, [] as unknown])
      expect(parseSnapshot({ ...base, assistant: bad })).toEqual({ status: 'idle', messages: [] })
  })
})

describe('sprite metadata', () => {
  it('is self-consistent', () => {
    expect(WINDOW_SIZE).toBe(FRAME * SCALE)
    expect(GROUND_MARGIN).toBeGreaterThanOrEqual(0)
    expect(GROUND_MARGIN).toBeLessThan(WINDOW_SIZE / 2)
    ANIM_NAMES.forEach((n, i) => {
      expect(ROWS[n].row).toBe(i)
      expect(ROWS[n].frames).toBeGreaterThan(1)
      expect(ROWS[n].ms).toBeGreaterThan(20)
    })
  })
  it('every pet mode has an animation', () => {
    for (const mode of MODES) expect(ANIM_NAMES).toContain(animationFor(mode))
    expect(animationFor('listening')).toBe('listening')
    expect(animationFor('paused')).toBe('idle')
  })
})
