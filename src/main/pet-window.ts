import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { WINDOW_SIZE } from '../shared/sprite'

/** native/window-level.node (built by tools/build-helper.sh): the one level Electron cannot set, the desktop layer. */
let levelAddon: { setDesktopLevel(handle: Buffer): boolean } | null | undefined
export function desktopLevel(win: BrowserWindow): boolean {
  if (process.platform !== 'darwin') return false
  if (levelAddon === undefined) {
    try {
      levelAddon = createRequire(import.meta.url)(join(import.meta.dirname, '../../native/window-level.node'))
    } catch (err) {
      console.warn(`desktop layer unavailable, using an ordinary window level: ${(err as Error).message}`)
      levelAddon = null
    }
  }
  try {
    return levelAddon?.setDesktopLevel(win.getNativeWindowHandle()) === true
  } catch {
    return false
  }
}

/**
 * Where the window sits in the stack. "Bring the cat with me": above other apps, on every Space, over full-screen apps.
 * Otherwise (macOS only) it lives on the desktop layer of the Space it started on: under every app window, so he only shows on
 * the bare desktop and never follows you into an app. Windows and Linux have no desktop layer a window can join, so there the pet
 * is always a small always-on-top overlay. Without the macOS addon: an ordinary-level window.
 */
export function applyLevel(win: BrowserWindow, bringWithMe: boolean): void {
  if (win.isDestroyed()) return
  if (bringWithMe || process.platform !== 'darwin') {
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
    if (process.platform !== 'win32') win.setVisibleOnAllWorkspaces(true, process.platform === 'darwin' ? { visibleOnFullScreen: true } : undefined)
  } else {
    win.setVisibleOnAllWorkspaces(false)
    win.setAlwaysOnTop(false)
    desktopLevel(win)
  }
}

/** `query` is passed to the page as its URL query (cat options, debug switches); the page validates every value itself. */
export function createPetWindow(query: Record<string, string> = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // clicking the pet never steals focus from the app you are working in
    acceptFirstMouse: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}), // NSPanel on macOS: non-activating, can float over other apps
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  // Start fully click-through; the renderer reports when the pointer is over the sprite.
  win.setIgnoreMouseEvents(true, { forward: true })

  // The renderer is a fixed local page: no navigation, no popups, no permissions.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  win.webContents.session.setPermissionCheckHandler(() => false)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}?${new URLSearchParams(query).toString()}`)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query })
  return win
}
