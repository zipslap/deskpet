import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * API keys, encrypted with the operating system's own secure storage (Electron's safeStorage: the macOS Keychain, Windows DPAPI,
 * or the Linux keyring) and kept in `keys.json` in the app's data folder. Only the ciphertext is on disk, and it can only be read
 * back by this user on this computer. The file never holds a plain key, and a key is never written to settings.json, logs or history.
 */
export interface Cipher {
  /** True when the OS can really protect the data (on Linux without a keyring Electron falls back to a weak scheme: that counts as no). */
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export const ACCOUNT = /^[a-z0-9-]{1,30}$/
const MAX_KEY_CHARS = 600

export class KeyStore {
  constructor(
    private readonly path: string,
    private readonly cipher: Cipher
  ) {}

  get secure(): boolean {
    return this.cipher.available()
  }

  private read(): Record<string, string> {
    try {
      const j: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof j !== 'object' || j === null || Array.isArray(j)) return {}
      return Object.fromEntries(Object.entries(j).filter(([k, v]) => ACCOUNT.test(k) && typeof v === 'string'))
    } catch {
      return {}
    }
  }

  has(account: string): boolean {
    return ACCOUNT.test(account) && account in this.read()
  }

  /** The key stored for `account` (a provider id), or null if there is none or it cannot be decrypted. */
  get(account: string): string | null {
    if (!ACCOUNT.test(account) || !this.secure) return null
    const b64 = this.read()[account]
    if (!b64) return null
    try {
      return this.cipher.decrypt(Buffer.from(b64, 'base64')) || null
    } catch {
      return null
    }
  }

  /** Throws if the OS has no secure storage (the caller says so) or the key is not a plausible key. */
  set(account: string, key: string): void {
    if (!ACCOUNT.test(account)) throw new Error('not a provider name')
    const k = key.trim()
    if (!k || k.length > MAX_KEY_CHARS || /[\u0000-\u001f\u007f\s]/.test(k)) throw new Error('that does not look like an API key')
    if (!this.secure) throw new Error('this system has no secure storage for secrets (on Linux install a keyring such as gnome-keyring or KWallet), so the key was not stored')
    const all = this.read()
    all[account] = this.cipher.encrypt(k).toString('base64')
    this.write(all)
  }

  delete(account: string): void {
    const all = this.read()
    delete all[account]
    this.write(all)
  }

  private write(all: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      /* not supported on every file system */
    }
  }
}
