import type { AiSettings } from '../memory/settings'
import { findApiKey, type KeyReader } from './api-key'
import { ClaudeCliProvider } from './claude-cli-provider'
import { CommandProvider } from './command-provider'
import { HttpProvider } from './http-provider'
import { MockProvider } from './mock-provider'
import { presetFor, type ProviderPreset } from './presets'
import { ProviderError, type ChatProvider } from './provider'

export interface ProviderInput {
  ai: AiSettings
  env: NodeJS.ProcessEnv
  /** An empty, app-owned folder for processes that need a working directory. */
  workdir: string
  /** Asked on every message, so the model can be switched while the app runs. */
  model: () => string
  effort: () => string | undefined
  systemPrompt: (info: { screen: boolean }) => string
  /** Reads a stored API key (the encrypted key store). */
  keyStore?: KeyReader
}

/** What the rest of the app needs to know about the chosen service. */
export interface ProviderInfo {
  preset: ProviderPreset
  /** Short name for messages: "OpenAI API", "Claude subscription"... */
  service: string
  defaultModel: string
  /** Models to offer before the service's own list is fetched. */
  models: string[]
  /** The Claude command accepts a reasoning-effort option; nothing else does. */
  hasEffort: boolean
  /** Can look at a screenshot. */
  hasVision: boolean
}

/** Shown for a service that is selected but cannot work (bad address, missing command): the reason, in the chat. */
class BrokenProvider implements ChatProvider {
  constructor(private readonly why: string) {}
  // eslint-disable-next-line require-yield
  async *sendMessage(): AsyncIterable<string> {
    throw new ProviderError(this.why)
  }
}

export function describeProvider(ai: AiSettings): ProviderInfo {
  const preset = presetFor(ai.provider)
  const service = preset.label.replace(/\s*\(.*$/, '')
  return {
    preset,
    service,
    defaultModel: preset.defaultModel,
    models: [...new Set([...(ai.model ? [ai.model] : preset.models), ...(ai.model ? preset.models : []), ...ai.models])],
    hasEffort: preset.kind === 'claude-cli',
    hasVision: preset.kind !== 'command' && preset.id !== 'deepseek'
  }
}

export function createProvider(i: ProviderInput): ChatProvider {
  const info = describeProvider(i.ai)
  const { preset } = info
  switch (preset.kind) {
    case 'mock':
      return new MockProvider()
    case 'claude-cli':
      return new ClaudeCliProvider({
        command: i.ai.command || 'claude',
        model: i.model,
        effort: i.effort,
        systemPrompt: i.systemPrompt,
        workdir: i.workdir,
        allowBilledApi: i.ai.allowBilledApi,
        env: i.env
      })
    case 'command':
      if (!i.ai.command) return new BrokenProvider('Set "ai.command" (and "ai.args") in settings.json to the command-line assistant you want to use. See the README.')
      return new CommandProvider({ command: i.ai.command, args: i.ai.args, model: i.model, systemPrompt: i.systemPrompt, workdir: i.workdir, env: i.env })
    case 'anthropic':
    case 'openai-compatible': {
      const baseUrl = i.ai.baseUrl || preset.baseUrl || ''
      if (!baseUrl) return new BrokenProvider(`Set "ai.baseUrl" in settings.json to the address of your ${info.service} server (for example http://localhost:8080/v1).`)
      const envName = i.ai.apiKeyEnv || preset.keyEnv || ''
      let cached: string | null = null
      return new HttpProvider({
        kind: preset.kind,
        service: info.service,
        baseUrl,
        needsKey: preset.needsKey || Boolean(i.ai.apiKeyEnv),
        getKey: async () => {
          if (cached) return cached
          cached = await findApiKey({ account: preset.id, envName, env: i.env, ...(i.keyStore ? { store: i.keyStore } : {}) })
          return cached
        },
        model: i.model,
        systemPrompt: i.systemPrompt
      })
    }
  }
}
