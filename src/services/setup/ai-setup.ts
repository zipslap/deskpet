import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SetupRequest } from '../../shared/setup-types'
import { resolveCommand } from '../ai/launch'
import { isSafeBaseUrl, PROVIDER_PRESETS, type ProviderPreset } from '../ai/presets'

/**
 * The in-app version of `npm run setup`: validate a choice of AI, test the connection, and save it. Only the "ai" section of
 * settings.json is touched (everything else in the file is kept), the file is written atomically, and a file that cannot be
 * parsed is never overwritten. A key goes to the encrypted key store, never into settings.json.
 */

export interface KeyWriter {
  readonly secure: boolean
  set(account: string, key: string): void
}

export type ConnectionState = 'ok' | 'key-rejected' | 'unreachable' | 'not-found' | 'http-error'
export interface ConnectionResult {
  state: ConnectionState
  message: string
}

/** Arguments for the `command` provider, split on spaces (the same rule `npm run setup` uses). */
export const splitArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean)

/** Why a request cannot be used, or null when it can. `haveKey` = a key is already stored or in the environment. */
export function problemWith(req: SetupRequest, haveKey: boolean, presets: readonly ProviderPreset[] = PROVIDER_PRESETS): string | null {
  const preset = presets.find((p) => p.id === req.provider)
  if (!preset) return 'That is not one of the services DeskPet knows.'
  if (preset.id === 'custom') {
    if (!req.baseUrl) return 'Type the address of your server, for example http://localhost:8080/v1.'
    if (!isSafeBaseUrl(req.baseUrl)) return 'The address must start with https:// (plain http:// is only accepted for a server on this computer).'
  }
  if (preset.kind === 'command' && !req.command) return 'Type the command to run (its name or full path).'
  if (preset.needsKey && !req.key && !haveKey) return `Paste your ${preset.label.replace(/\s*\(.*$/, '')} key.`
  return null
}

function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`settings.json cannot be read (${(e as Error).message}). Fix or delete it first; it was not changed.`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('settings.json is not a JSON object. Fix or delete it first; it was not changed.')
  return json as Record<string, unknown>
}

/**
 * Store the key (if one was typed) and write the new "ai" section. Throws a message fit to show the person.
 * Fields that belong to another service are cleared, so a key for one service can never be sent to a leftover address of another.
 */
export function saveChoice(settingsPath: string, req: SetupRequest, keys: KeyWriter, presets: readonly ProviderPreset[] = PROVIDER_PRESETS): void {
  const preset = presets.find((p) => p.id === req.provider)
  if (!preset) throw new Error('That is not one of the services DeskPet knows.')
  const file = readSettingsFile(settingsPath) // read first: a broken file must stop us before the key is stored
  if (req.key) {
    if (!preset.needsKey && preset.id !== 'custom') throw new Error(`${preset.label} does not use a key.`)
    keys.set(preset.id, req.key)
  }
  const old = typeof file['ai'] === 'object' && file['ai'] !== null && !Array.isArray(file['ai']) ? { ...(file['ai'] as Record<string, unknown>) } : {}
  const ai: Record<string, unknown> = { ...old, provider: preset.id, model: req.model }
  for (const k of ['baseUrl', 'command', 'args', 'apiKeyEnv']) delete ai[k]
  if (preset.id === 'custom') {
    ai['baseUrl'] = req.baseUrl
    if (typeof old['apiKeyEnv'] === 'string' && old['apiKeyEnv']) ai['apiKeyEnv'] = old['apiKeyEnv']
  }
  if (preset.kind === 'command') {
    ai['command'] = req.command
    ai['args'] = splitArgs(req.args)
  } else if (preset.kind === 'claude-cli' && typeof old['command'] === 'string' && old['command']) ai['command'] = old['command'] // a custom path to `claude`
  file['ai'] = ai
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(`${settingsPath}.tmp`, JSON.stringify(file, null, 2) + '\n')
  renameSync(`${settingsPath}.tmp`, settingsPath)
}

export interface TestInput {
  req: SetupRequest
  /** The key to try: the one typed, else the stored or environment one. */
  key: string | null
  env: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
  presets?: readonly ProviderPreset[]
}

/** Ask the service for its model list (it needs the key and costs nothing), or look for the command. */
export async function testConnection(i: TestInput): Promise<ConnectionResult> {
  const preset = (i.presets ?? PROVIDER_PRESETS).find((p) => p.id === i.req.provider)
  if (!preset) return { state: 'not-found', message: 'That is not one of the services DeskPet knows.' }
  if (preset.kind === 'mock') return { state: 'ok', message: 'The offline demo needs nothing.' }
  if (preset.kind === 'claude-cli' || preset.kind === 'command') {
    const name = preset.kind === 'claude-cli' ? 'claude' : i.req.command
    if (!name) return { state: 'not-found', message: 'Type the command to run first.' }
    const found = resolveCommand(name, i.env)
    if (found) return { state: 'ok', message: `Found ${name} at ${found}.${preset.kind === 'claude-cli' ? ' Make sure it is signed in (run: claude auth login).' : ''}` }
    return {
      state: 'not-found',
      message: preset.kind === 'claude-cli' ? 'The `claude` command was not found. Install Claude Code (https://docs.claude.com/en/docs/claude-code), run `claude auth login`, then test again.' : `The command "${name}" was not found.`
    }
  }
  const base = (preset.id === 'custom' ? i.req.baseUrl : preset.baseUrl ?? '').replace(/\/+$/, '')
  if (!base || !isSafeBaseUrl(base)) return { state: 'unreachable', message: 'The address is missing or not allowed (https://, or http:// for this computer only).' }
  const anthropic = preset.kind === 'anthropic'
  const headers: Record<string, string> = anthropic ? { 'anthropic-version': '2023-06-01', ...(i.key ? { 'x-api-key': i.key } : {}) } : i.key ? { authorization: `Bearer ${i.key}` } : {}
  try {
    const res = await (i.fetchFn ?? fetch)(base + (anthropic ? '/v1/models?limit=1' : '/models'), { headers, signal: AbortSignal.timeout(10_000) })
    if (res.ok) return { state: 'ok', message: 'Connected: the service accepted the key.' }
    if (res.status === 401 || res.status === 403) return { state: 'key-rejected', message: 'The service rejected that key. Check it and try again.' }
    return { state: 'http-error', message: `The service answered with an error (HTTP ${res.status}). You can still save and try it in the chat.` }
  } catch {
    return { state: 'unreachable', message: preset.needsKey ? 'Could not reach the service. Check your internet connection.' : 'Nothing answered at that address. Start the server first, then test again.' }
  }
}
