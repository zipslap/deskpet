/**
 * Every service DeskPet can talk to. Three mechanisms cover all of them:
 *  - "openai-compatible": the chat-completions protocol that OpenAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI,
 *    Ollama, LM Studio and many others speak;
 *  - "anthropic": Anthropic's own messages API;
 *  - "claude-cli" / "command": a command-line assistant you already signed in to (your subscription, no API key here).
 * Model names change often: the ones listed are only suggestions. `/model <any name>` (or settings.json "ai.model") uses
 * whatever the service accepts, and the panel's list is topped up from the service's own model list when it offers one.
 */
import providers from './providers.json'

export type ProviderKind = 'mock' | 'claude-cli' | 'command' | 'openai-compatible' | 'anthropic'

export interface ProviderPreset {
  id: string
  label: string
  kind: ProviderKind
  /** Chat endpoint root (openai-compatible: `<baseUrl>/chat/completions`, anthropic: `<baseUrl>/v1/messages`). */
  baseUrl?: string
  /** Environment variable the key is read from when it is not in the macOS Keychain. */
  keyEnv?: string
  /** False for local servers (Ollama, LM Studio) and for commands that sign in on their own. */
  needsKey: boolean
  defaultModel: string
  /** Shown in the model list before anything is fetched. */
  models: string[]
  /** A cheaper model for conversation summaries; the chat model when absent. */
  summaryModel?: string
  /** One line for `npm run setup` and the README. */
  hint: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = providers as ProviderPreset[]

export const PROVIDER_IDS: readonly string[] = PROVIDER_PRESETS.map((p) => p.id)

export function presetFor(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0]!
}

/** Plain http is only acceptable for a server on this computer; a key must never cross the network unencrypted. */
export function isSafeBaseUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
}
