import { join } from 'node:path'
import { BrowserWindow, screen, type Rectangle, type WebContents } from 'electron'
import { Channels } from '../shared/ipc'
import type { ChatSnapshot } from '../shared/chat-types'
import type { VoiceUiState } from '../shared/voice-types'
import type { Theme } from '../shared/theme'
import type { ScreenUiState } from '../shared/screen-types'

// The window is a little bigger than the grass patch it shows: a transparent margin holds the pixel drop shadow.
export const DEFAULT_SIZE = { w: 460, h: 600 }
/** Height of the panel when minimised to its title bar (10 px margins, the plate's 24 px insets, the header with its round buttons). */
export const COLLAPSED_H = 108
const MIN = { w: 340, h: 280 }
const MAX = { w: 1200, h: 1400 }
const clampN = (v: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, v)))

export interface ChatWindowHooks {
  onOpen: () => void
  /** Fires once per close, whether the user closed the panel or the OS did. */
  onClose: () => void
  /** The user finished changing the panel's size (drag of the corner grip). Not called for the minimised height. */
  onResized?: (size: { w: number; h: number }) => void
  /** Where the window sits in the stack: above other apps and on every Space ("bring the cat with me"), or an ordinary window. */
  bringWithMe?: () => boolean
  /** The size to open at (the user's last choice). */
  size?: () => { w: number; h: number }
}

/**
 * The compact chat panel. Created when opened and destroyed when closed, so a closed panel costs no renderer
 * process (the conversation itself lives in the ChatSession in the main process and survives closing).
 */
export class ChatWindow {
  private win: BrowserWindow | null = null
  private collapsed = false
  private expandedH = DEFAULT_SIZE.h
  private lastPet: Rectangle | null = null
  private resizing: { w: number; h: number } | null = null

  constructor(
    private readonly anchor: () => Rectangle,
    private readonly latest: () => ChatSnapshot,
    private readonly latestVoice: () => VoiceUiState,
    private readonly latestTheme: () => Theme,
    private readonly latestScreen: () => ScreenUiState,
    private readonly hooks: ChatWindowHooks
  ) {}

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }
  get browserWindow(): BrowserWindow | null {
    return this.isOpen ? this.win! : null
  }
  get webContents(): WebContents | null {
    return this.isOpen ? this.win!.webContents : null
  }

  open(): void {
    if (this.isOpen) {
      this.reposition()
      this.win!.show()
      this.win!.focus()
      return
    }
    const size = this.hooks.size?.() ?? DEFAULT_SIZE
    this.collapsed = false
    this.expandedH = size.h
    const win = new BrowserWindow({
      width: size.w,
      height: size.h,
      minWidth: MIN.w,
      minHeight: MIN.h,
      maxWidth: MAX.w,
      maxHeight: MAX.h,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false, // the panel draws its own shadow inside the transparent margin
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/chat.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    this.win = win
    this.applyLevel()
    this.reposition()

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    win.webContents.session.setPermissionCheckHandler(() => false)

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    })
    let resizedTimer: NodeJS.Timeout | undefined
    win.on('resize', () => {
      // a settled size (not the minimised bar, not a drag in progress) is the user's new preferred size
      if (this.collapsed || win.isDestroyed()) return
      clearTimeout(resizedTimer)
      resizedTimer = setTimeout(() => {
        if (!win.isDestroyed() && !this.collapsed) {
          const [w, h] = win.getSize()
          this.expandedH = h!
          this.hooks.onResized?.({ w: w!, h: h! })
        }
      }, 300)
    })
    win.on('closed', () => {
      clearTimeout(resizedTimer)
      if (this.win === win) {
        this.win = null
        this.hooks.onClose()
      }
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void win.loadURL(`${devUrl}/chat.html`)
    else void win.loadFile(join(import.meta.dirname, '../renderer/chat.html'))
    this.hooks.onOpen()
  }

  close(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.close() // triggers 'closed' -> hooks.onClose
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  /** Above or below the cat's current level: ordinary window normally, floating over everything when the cat comes with you. */
  applyLevel(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const bring = this.hooks.bringWithMe?.() === true
    win.setVisibleOnAllWorkspaces(bring, bring ? { visibleOnFullScreen: true } : undefined)
    win.setAlwaysOnTop(bring, bring ? 'floating' : 'normal')
  }

  /**
   * Place the panel just above the cat (or below it if there is no room), kept inside the display's work area.
   * Done when it opens; after that the panel stays where the user puts it (header drag) and only moves along when the cat is dragged.
   */
  reposition(): void {
    if (!this.isOpen) return
    const pet = this.anchor()
    const [w, h] = this.win!.getSize() as [number, number]
    const wa = screen.getDisplayMatching(pet).workArea
    const x = Math.round(Math.min(Math.max(pet.x + pet.width / 2 - w / 2, wa.x), wa.x + wa.width - w))
    // just clear of him: the panel window (transparent margin included) must not overlap his window, or it would catch the
    // clicks meant for him (he lives under every window)
    let y = pet.y - h
    if (y < wa.y) y = pet.y + pet.height // no room above: below the cat instead
    y = Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - h))
    this.win!.setBounds({ x, y, width: w, height: h })
    this.lastPet = { ...pet }
  }

  /** The cat moved (it was dragged): carry the panel along by the same amount, wherever the user had put it. */
  follow(pet: Rectangle): void {
    const prev = this.lastPet
    this.lastPet = { ...pet }
    if (!this.isOpen || !prev) return
    const dx = pet.x - prev.x
    const dy = pet.y - prev.y
    if (dx === 0 && dy === 0) return
    const b = this.win!.getBounds()
    const wa = screen.getDisplayMatching(pet).workArea
    const x = Math.round(Math.min(Math.max(b.x + dx, wa.x - b.width + 80), wa.x + wa.width - 80))
    const y = Math.round(Math.min(Math.max(b.y + dy, wa.y), wa.y + wa.height - 60))
    this.win!.setPosition(x, y)
  }

  // ---------- resizing and minimising by hand ----------
  beginResize(): void {
    if (!this.isOpen || this.collapsed) return
    const [w, h] = this.win!.getSize() as [number, number]
    this.resizing = { w, h }
  }
  /** `dx`/`dy`: how far the grip has been dragged since beginResize. The top-left corner stays put. */
  resizeBy(dx: number, dy: number): void {
    if (!this.isOpen || !this.resizing || !Number.isFinite(dx) || !Number.isFinite(dy)) return
    const b = this.win!.getBounds()
    const wa = screen.getDisplayMatching(b).workArea
    const w = clampN(this.resizing.w + dx, MIN.w, Math.min(MAX.w, wa.x + wa.width - b.x + 40))
    const h = clampN(this.resizing.h + dy, MIN.h, Math.min(MAX.h, wa.y + wa.height - b.y + 40))
    this.win!.setBounds({ x: b.x, y: b.y, width: w, height: h })
  }
  endResize(): void {
    this.resizing = null
  }

  get isCollapsed(): boolean {
    return this.collapsed
  }
  /** Minimise to the title bar / restore. The edge nearest the cat stays where it is. */
  toggleCollapsed(): void {
    if (!this.isOpen) return
    const win = this.win!
    const b = win.getBounds()
    const pet = this.anchor()
    const aboveCat = b.y + b.height <= pet.y + pet.height
    if (!this.collapsed) {
      this.expandedH = b.height
      this.collapsed = true
      win.setMinimumSize(MIN.w, COLLAPSED_H)
      win.setBounds({ x: b.x, y: aboveCat ? b.y + b.height - COLLAPSED_H : b.y, width: b.width, height: COLLAPSED_H })
    } else {
      this.collapsed = false
      win.setMinimumSize(MIN.w, MIN.h)
      const h = this.expandedH
      const wa = screen.getDisplayMatching(b).workArea
      const y = Math.round(Math.min(Math.max(aboveCat ? b.y + b.height - h : b.y, wa.y), wa.y + wa.height - h))
      win.setBounds({ x: b.x, y, width: b.width, height: h })
    }
    this.pushLayout()
  }

  pushLayout(): void {
    this.send(Channels.chatLayout, { collapsed: this.collapsed })
  }

  push(snapshot: ChatSnapshot): void {
    if (this.isOpen && !this.win!.webContents.isLoading()) this.win!.webContents.send(Channels.chatSnapshot, snapshot)
  }

  pushVoice(state: VoiceUiState): void {
    if (this.isOpen && !this.win!.webContents.isLoading()) this.win!.webContents.send(Channels.chatVoice, state)
  }

  /** Send an arbitrary (already validated-on-receipt) message to the open panel. */
  send(channel: string, payload: unknown): void {
    if (this.isOpen && !this.win!.webContents.isLoading()) this.win!.webContents.send(channel, payload)
  }

  pushScreen(state: ScreenUiState): void {
    if (this.isOpen && !this.win!.webContents.isLoading()) this.win!.webContents.send(Channels.chatScreen, state)
  }

  /** Put text back in the message box (a message that was not sent after all). */
  restoreText(text: string): void {
    if (this.isOpen && !this.win!.webContents.isLoading()) this.win!.webContents.send(Channels.chatRestore, text)
  }

  /** The renderer asked for the current state (on load). */
  sendLatest(): void {
    if (!this.isOpen) return
    this.win!.webContents.send(Channels.chatSnapshot, this.latest())
    this.win!.webContents.send(Channels.chatVoice, this.latestVoice())
    this.win!.webContents.send(Channels.chatTheme, this.latestTheme())
    this.win!.webContents.send(Channels.chatScreen, this.latestScreen())
    this.win!.webContents.send(Channels.chatLayout, { collapsed: this.collapsed })
  }
}
