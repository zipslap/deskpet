/** Where a provider's API key comes from. */
export type KeyReader = (account: string) => Promise<string | null> | string | null

export interface KeyLookup {
  /** The provider id, which is also the account the key is stored under. */
  account: string
  /** The environment variable to fall back to ('' for none). */
  envName: string
  env: NodeJS.ProcessEnv
  /** The secure store (see key-store.ts). */
  store?: KeyReader
}

/**
 * Where a key comes from, in order: the encrypted key you stored with `npm run setup` (it works when the app is opened from the
 * Dock or Start menu, which has none of your shell's variables), then the named environment variable. It is never written to
 * settings.json, a log or the chat history.
 */
export async function findApiKey(l: KeyLookup): Promise<string | null> {
  const stored = l.store ? await l.store(l.account) : null
  if (stored) return stored
  const fromEnv = l.envName ? l.env[l.envName]?.trim() : ''
  return fromEnv || null
}
