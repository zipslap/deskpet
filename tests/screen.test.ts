import { describe, expect, it } from 'vitest'
import { checkCapture, isExcluded, parseWindowSnapshot, type WindowSnapshot } from '../src/services/screen/rules'
import { ScreenService, type Capturer, type ScreenDeps, type ScreenImage } from '../src/services/screen/screen-service'
import { DEFAULT_SETTINGS } from '../src/services/memory/settings'
import { parseScreenState } from '../src/shared/screen-types'
import { parseSnapshot, THUMB_PREFIX } from '../src/shared/chat-types'

const DISPLAY = { x: 0, y: 0, w: 1710, h: 1112 }
const win = (owner: string, bundleId: string, x = 100, y = 100, w = 600, h = 400, pid = 100) => ({ id: 1, owner, bundleId, pid, x, y, w, h })
const snap = (windows: ReturnType<typeof win>[], front = 'Notes'): WindowSnapshot => ({
  frontmost: { name: front, bundleId: '', pid: 1 },
  windows,
  displays: [{ ...DISPLAY, main: true }]
})
const IMG: ScreenImage = { base64: 'QUJD', mime: 'image/jpeg', width: 10, height: 6, thumbDataUrl: `${THUMB_PREFIX}QUJD` }

describe('isExcluded', () => {
  const ex = ['1Password', 'com.bitwarden.desktop', 'org.keepassxc.']
  it.each([
    [{ name: '1Password', bundleId: '' }, true],
    [{ name: '1PASSWORD', bundleId: '' }, true],
    [{ name: 'x', bundleId: 'com.bitwarden.desktop' }, true],
    [{ name: 'KeePassXC', bundleId: 'org.keepassxc.app' }, true], // bundle-id prefix ending in "."
    [{ name: '1Password 7', bundleId: 'com.agilebits.onepassword7' }, false], // names match exactly, not by substring
    [{ name: 'Notes', bundleId: 'com.apple.Notes' }, false],
    [{ name: '', bundleId: '' }, false]
  ])('%j -> %s', (app, expected) => expect(isExcluded(app, ex)).toBe(expected))
  it('an empty list excludes nothing, and blank entries are ignored', () => {
    expect(isExcluded({ name: 'x', bundleId: 'y' }, [])).toBe(false)
    expect(isExcluded({ name: '', bundleId: '' }, ['  '])).toBe(false)
  })
})

describe('checkCapture', () => {
  it('is clear when no excluded app has a visible window on the display', () => {
    expect(checkCapture(snap([win('Notes', 'com.apple.Notes')]), DISPLAY, ['1Password']).blockedBy).toEqual([])
  })
  it('names an excluded app that is on the display, even behind another window', () => {
    expect(checkCapture(snap([win('Notes', 'a'), win('1Password', 'b', 50, 50)]), DISPLAY, ['1Password']).blockedBy).toEqual(['1Password'])
  })
  it('ignores an excluded app whose window is on a different display', () => {
    expect(checkCapture(snap([win('1Password', 'b', 2000, 0)]), DISPLAY, ['1Password']).blockedBy).toEqual([])
    expect(checkCapture(snap([win('1Password', 'b', 2000, 0)]), { x: 1711, y: 0, w: 1920, h: 1080 }, ['1Password']).blockedBy).toEqual(['1Password'])
  })
  it('lists each blocking app once', () => {
    const s = snap([win('1Password', 'b'), win('1Password', 'b', 300, 300), win('Bitwarden', 'c')])
    expect(checkCapture(s, DISPLAY, ['1Password', 'Bitwarden']).blockedBy.sort()).toEqual(['1Password', 'Bitwarden'])
  })
})

describe('parseWindowSnapshot', () => {
  it('accepts the helper output and drops malformed entries', () => {
    const r = parseWindowSnapshot({
      frontmost: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 5 },
      windows: [{ id: 1, owner: 'Notes', bundleId: 'x', pid: 5, x: 0, y: 0, w: 10, h: 10 }, { id: 'bad' }, null, 7],
      displays: [{ x: 0, y: 0, w: 100, h: 100, main: true }, { x: 'no' }]
    })
    expect(r?.windows).toHaveLength(1)
    expect(r?.displays).toHaveLength(1)
    expect(r?.frontmost?.name).toBe('Notes')
  })
  it.each([null, 'x', {}, { windows: [], displays: 3 }, []])('rejects %j', (bad) => expect(parseWindowSnapshot(bad)).toBeNull())
  it('handles no frontmost app', () => expect(parseWindowSnapshot({ frontmost: null, windows: [], displays: [] })?.frontmost).toBeNull())
})

describe('ScreenService', () => {
  function make(over: Omit<Partial<ScreenDeps>, 'settings'> & { settings?: Partial<typeof DEFAULT_SETTINGS.screen>; snapshot?: WindowSnapshot | null; cap?: ScreenImage | 'denied' | 'empty' } = {}) {
    const log: string[] = []
    const { settings: settingsOver, snapshot: snapOver, cap: capOver, ...depOver } = over
    const capturer: Capturer = {
      capture: async () => {
        log.push('capture')
        return capOver ?? IMG
      }
    }
    const svc = new ScreenService({
      settings: () => ({ ...DEFAULT_SETTINGS.screen, ...settingsOver }),
      windows: { snapshot: async () => (snapOver === undefined ? snap([win('Notes', 'a')]) : snapOver), screenCaptureGranted: async () => true },
      capturer,
      displayBounds: () => DISPLAY,
      hideOwnWindows: async () => {
        log.push('hide')
        return () => log.push('restore')
      },
      permission: () => 'granted',
      ...depOver
    })
    return { svc, log }
  }

  it('captures with the pet hidden and then restored, and describes what it did', async () => {
    const { svc, log } = make()
    const r = await svc.captureForRequest()
    expect(r).toMatchObject({ ok: true, image: IMG })
    expect(log).toEqual(['hide', 'capture', 'restore'])
    expect(r.ok && r.description).toMatch(/Notes/)
  })
  it('does nothing at all when screen access is switched off', async () => {
    const { svc, log } = make({ settings: { enabled: false } })
    const r = await svc.captureForRequest()
    expect(r).toMatchObject({ ok: false, fix: null })
    expect(log).toEqual([])
  })
  it('refuses before reading a single pixel when an excluded app is visible, naming it', async () => {
    const { svc, log } = make({ snapshot: snap([win('1Password', 'com.1password.1password')]) })
    const r = await svc.captureForRequest()
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.message).toMatch(/1Password/)
    expect(log).toEqual([]) // not even hidden-and-captured
  })
  it('refuses when it cannot tell what is on screen and there is an exclusion list', async () => {
    const { svc, log } = make({ snapshot: null })
    const r = await svc.captureForRequest()
    expect(r.ok).toBe(false)
    expect(log).toEqual([])
  })
  it('captures without the window check only when the exclusion list is empty', async () => {
    const { svc } = make({ snapshot: null, settings: { excludeApps: [] } })
    expect((await svc.captureForRequest()).ok).toBe(true)
  })
  it('explains denied permission and points at the right Settings pane, without capturing', async () => {
    const { svc, log } = make({ permission: () => 'denied' })
    const r = await svc.captureForRequest()
    expect(r).toMatchObject({ ok: false, fix: 'screen' })
    expect(log).toEqual([])
  })
  it.each(['denied', 'empty'] as const)('a capture that comes back %s is an error with a fix, and the windows are restored', async (cap) => {
    const { svc, log } = make({ cap })
    const r = await svc.captureForRequest()
    expect(r).toMatchObject({ ok: false, fix: 'screen' })
    expect(log).toEqual(['hide', 'capture', 'restore'])
  })
  it('restores the windows even if the capture throws', async () => {
    const log: string[] = []
    const svc = new ScreenService({
      settings: () => DEFAULT_SETTINGS.screen,
      windows: { snapshot: async () => snap([]), screenCaptureGranted: async () => true },
      capturer: { capture: async () => { throw new Error('boom') } },
      displayBounds: () => DISPLAY,
      hideOwnWindows: async () => () => log.push('restore'),
      permission: () => 'granted'
    })
    await expect(svc.captureForRequest()).rejects.toThrow('boom')
    expect(log).toEqual(['restore'])
  })
  it('one capture at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const svc = new ScreenService({
      settings: () => DEFAULT_SETTINGS.screen,
      windows: { snapshot: async () => snap([]), screenCaptureGranted: async () => true },
      capturer: { capture: async () => (await gate, IMG) },
      displayBounds: () => DISPLAY,
      hideOwnWindows: async () => () => {},
      permission: () => 'granted'
    })
    const first = svc.captureForRequest()
    await new Promise((r) => setTimeout(r, 10))
    expect(await svc.captureForRequest()).toMatchObject({ ok: false })
    release()
    expect((await first).ok).toBe(true)
    expect((await svc.captureForRequest()).ok).toBe(true)
  })
})

describe('validation of what crosses to the panel', () => {
  it('screen state', () => {
    const base = { enabled: true, armed: false, busy: false, error: null, watch: { available: true, on: true, phase: 'watching', app: 'Mail', checks: 3, samples: 0, fired: 1, sent: 0 }, nudge: null }
    expect(parseScreenState(base)).toEqual(base)
    expect(parseScreenState({ ...base, error: { message: 'm', fix: 'screen' } })?.error).toEqual({ message: 'm', fix: 'screen' })
    expect(parseScreenState({ ...base, nudge: { app: 'Mail', prompt: 'p' } })?.nudge).toEqual({ app: 'Mail', prompt: 'p' })
    const bad: unknown[] = [
      null, 'x', { ...base, enabled: 1 }, { ...base, error: { message: 1, fix: null } }, { ...base, error: { message: 'm', fix: 'rm -rf' } },
      { ...base, watch: undefined }, { ...base, watch: { ...base.watch, phase: 'recording' } }, { ...base, watch: { ...base.watch, checks: -1 } },
      { ...base, watch: { ...base.watch, sent: 1.5 } }, { ...base, nudge: { app: 1, prompt: 'p' } }
    ]
    for (const b of bad) expect(parseScreenState(b)).toBeNull()
  })
  it('over-long app names and prompts are clipped, not trusted', () => {
    const r = parseScreenState({ enabled: true, armed: false, busy: false, error: null, watch: { available: true, on: true, phase: 'watching', app: 'x'.repeat(500), checks: 0, samples: 0, fired: 0, sent: 0 }, nudge: { app: 'y'.repeat(500), prompt: 'z'.repeat(5000) } })
    expect(r?.watch.app).toHaveLength(80)
    expect(r?.nudge?.app).toHaveLength(80)
    expect(r?.nudge?.prompt).toHaveLength(500)
  })
  it('a transcript image must be a small jpeg data URL, anything else is dropped', () => {
    const ok = (image: unknown) => parseSnapshot({ status: 'idle', messages: [{ id: 1, role: 'user', text: 'hi', screen: true, image }] })?.messages[0]
    expect(ok(`${THUMB_PREFIX}QUJD`)?.image).toBe(`${THUMB_PREFIX}QUJD`)
    for (const bad of ['http://evil/x.png', 'data:text/html;base64,PGI+', `${THUMB_PREFIX}<script>`, `${THUMB_PREFIX}${'A'.repeat(200_000)}`, 5]) expect(ok(bad)?.image).toBeUndefined()
    expect(ok('javascript:alert(1)')?.screen).toBe(true)
  })
})
