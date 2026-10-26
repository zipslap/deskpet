import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findApiKey } from '../src/services/ai/api-key'
import { KeyStore, type Cipher } from '../src/services/ai/key-store'

describe('findApiKey', () => {
  it('prefers the stored key for this provider', async () => {
    const asked: string[] = []
    const key = await findApiKey({ account: 'openai', envName: 'OPENAI_API_KEY', env: { OPENAI_API_KEY: 'from-env' }, store: (a) => (asked.push(a), 'from-store') })
    expect(key).toBe('from-store')
    expect(asked).toEqual(['openai'])
  })
  it('falls back to the environment variable', async () => {
    expect(await findApiKey({ account: 'openai', envName: 'OPENAI_API_KEY', env: { OPENAI_API_KEY: ' sk-x \n' }, store: () => null })).toBe('sk-x')
  })
  it('is null when there is neither, or no variable name', async () => {
    expect(await findApiKey({ account: 'a', envName: 'NOPE', env: {}, store: () => null })).toBeNull()
    expect(await findApiKey({ account: 'a', envName: '', env: { X: 'y' } })).toBeNull()
    expect(await findApiKey({ account: 'a', envName: 'K', env: { K: '   ' } })).toBeNull()
  })
})

// a stand-in for the OS's secure storage: reversible but not plain text
const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from([...s].reverse().join('') + '#enc'),
  decrypt: (b) => {
    const t = b.toString()
    if (!t.endsWith('#enc')) throw new Error('bad data')
    return [...t.slice(0, -4)].reverse().join('')
  }
})

describe('KeyStore', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deskpet-keys-'))
    path = join(dir, 'keys.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stores a key encrypted, reads it back, and keeps the plain key out of the file', () => {
    const s = new KeyStore(path, fakeCipher())
    s.set('openai', ' sk-secret-123 ')
    expect(s.get('openai')).toBe('sk-secret-123')
    expect(s.has('openai')).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('sk-secret-123')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
  })
  it('keeps one key per provider and can delete one', () => {
    const s = new KeyStore(path, fakeCipher())
    s.set('openai', 'a-key')
    s.set('gemini', 'b-key')
    expect(s.get('gemini')).toBe('b-key')
    s.delete('openai')
    expect(s.get('openai')).toBeNull()
    expect(s.get('gemini')).toBe('b-key')
  })
  it.each(['', '   ', 'has space', 'tab\there', 'new\nline', 'x'.repeat(601)])('refuses %j as a key', (bad) => {
    expect(() => new KeyStore(path, fakeCipher()).set('openai', bad)).toThrow(/API key/)
  })
  it.each(['../x', 'UPPER', 'a b', '', 'x'.repeat(31)])('refuses %j as a provider name', (bad) => {
    const s = new KeyStore(path, fakeCipher())
    expect(() => s.set(bad, 'k')).toThrow()
    expect(s.get(bad)).toBeNull()
    expect(s.has(bad)).toBe(false)
  })
  it('without secure storage it refuses to store and cannot read', () => {
    const s = new KeyStore(path, fakeCipher(false))
    expect(() => s.set('openai', 'k')).toThrow(/secure storage/)
    writeFileSync(path, JSON.stringify({ openai: Buffer.from('k#enc').toString('base64') }))
    expect(s.get('openai')).toBeNull()
  })
  it('a corrupt file or undecryptable entry is simply "no key"', () => {
    writeFileSync(path, 'not json')
    expect(new KeyStore(path, fakeCipher()).get('openai')).toBeNull()
    writeFileSync(path, JSON.stringify({ openai: Buffer.from('garbage').toString('base64'), bad: 5, '../x': 'y' }))
    const s = new KeyStore(path, fakeCipher())
    expect(s.get('openai')).toBeNull()
    expect(s.has('bad')).toBe(false)
  })
})
