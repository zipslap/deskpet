import { join } from 'node:path'
import { PROVIDER_PRESETS } from '../services/ai/presets'
import { problemWith, saveChoice, testConnection, type KeyWriter } from '../services/setup/ai-setup'
import { countInstalled, VoicePackRunner } from '../services/setup/voice-pack'
import { EMPTY_SETUP_UI, type SetupRequest, type SetupUiState, type VoicePack } from '../shared/setup-types'

/** The key store as the setup needs it. */
export interface SetupKeys extends KeyWriter {
  has(account: string): boolean
  get(account: string): string | null
}

export interface SetupDeps {
  /** The app's data folder (settings.json, keys.json, voices/ and speech/ live in it). */
  dataDir: string
  /** Where tools/voices.mjs and tools/speech.mjs are. */
  toolsDir: string
  /** The app's own executable, which runs those tools as Node. */
  execPath: string
  keys: () => SetupKeys | null
  env: NodeJS.ProcessEnv
  /** Read the saved "ai" section: what the drawer starts from. */
  currentAi: () => { provider: string; model: string; baseUrl: string; command: string; args: string[] }
  push: (state: SetupUiState) => void
  /** Restart the app so the new choice takes effect. Not called in tests of the app itself. */
  restart: () => void
  /** Wait before restarting, so the person can read the message. */
  restartDelayMs?: number
  fetchFn?: typeof fetch
}

/**
 * The state behind the "Set up" drawer: testing and saving the AI choice, and the offline voice download. The renderer only
 * sends validated requests; every effect (key store, settings.json, child processes, restart) happens here.
 */
export class SetupController {
  private message = { text: '', error: false }
  private busy = false
  private readonly runner = new VoicePackRunner()
  private voiceLog: string[] = []
  private voiceError = false
  private voiceDone = false

  constructor(private readonly d: SetupDeps) {}

  private get settingsPath(): string {
    return join(this.d.dataDir, 'settings.json')
  }

  private haveKey(id: string): boolean {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)
    return this.d.keys()?.has(id) === true || Boolean(preset?.keyEnv && this.d.env[preset.keyEnv])
  }

  state(): SetupUiState {
    const cur = this.d.currentAi()
    const keys = this.d.keys()
    return {
      ...EMPTY_SETUP_UI,
      providers: PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint, kind: p.kind, needsKey: p.needsKey, hasKey: this.haveKey(p.id), defaultModel: p.defaultModel, models: p.models })),
      current: { provider: cur.provider, model: cur.model, baseUrl: cur.baseUrl, command: cur.command, args: cur.args.join(' ') },
      secureKeys: keys?.secure !== false,
      message: this.message.text,
      error: this.message.error,
      busy: this.busy,
      voice: {
        voices: countInstalled(join(this.d.dataDir, 'voices', 'models')),
        speech: countInstalled(join(this.d.dataDir, 'speech', 'models')),
        busy: this.runner.running,
        log: this.voiceLog,
        error: this.voiceError,
        done: this.voiceDone
      }
    }
  }

  private set(text: string, error = false, busy = this.busy): void {
    this.message = { text, error }
    this.busy = busy
    this.d.push(this.state())
  }

  /** The drawer opened, or something changed: send the current state. */
  refresh(): void {
    this.d.push(this.state())
  }

  async test(req: SetupRequest): Promise<void> {
    if (this.busy) return
    const problem = problemWith(req, this.haveKey(req.provider))
    if (problem) return this.set(problem, true)
    this.set('Testing…', false, true)
    const envName = PROVIDER_PRESETS.find((p) => p.id === req.provider)?.keyEnv
    const key = req.key || this.d.keys()?.get(req.provider) || (envName ? this.d.env[envName] ?? null : null)
    const r = await testConnection({ req, key, env: this.d.env, ...(this.d.fetchFn ? { fetchFn: this.d.fetchFn } : {}) })
    this.set(r.message, r.state !== 'ok', false)
  }

  /** Store the key, write the choice, and restart so the app starts with it. */
  save(req: SetupRequest): void {
    if (this.busy) return
    const keys = this.d.keys()
    const problem = problemWith(req, this.haveKey(req.provider))
    if (problem) return this.set(problem, true)
    if (req.key && !keys) return this.set('The secure key storage is not ready yet. Try again in a moment.', true)
    try {
      saveChoice(this.settingsPath, req, keys ?? { secure: false, set: () => undefined })
    } catch (e) {
      return this.set((e as Error).message, true)
    }
    this.set('Saved. Restarting DeskPet to connect…', false, true)
    this.restartSoon()
  }

  async installVoices(pack: VoicePack): Promise<void> {
    if (this.runner.running) return
    this.voiceLog = ['Starting…']
    this.voiceError = false
    this.voiceDone = false
    this.d.push(this.state())
    const r = await this.runner.run(pack, {
      toolsDir: this.d.toolsDir,
      execPath: this.d.execPath,
      dataDir: this.d.dataDir,
      onLog: (lines) => {
        this.voiceLog = lines
        this.d.push(this.state())
      }
    })
    if (r.ok) {
      this.voiceDone = true
      this.voiceLog = ['Installed. Restarting DeskPet to use them…']
      this.d.push(this.state())
      this.restartSoon()
    } else {
      this.voiceError = r.reason !== 'Cancelled.'
      this.voiceLog = [...this.voiceLog.slice(-6), r.reason]
      this.d.push(this.state())
    }
  }

  cancelVoices(): void {
    this.runner.cancel()
  }

  dispose(): void {
    this.runner.cancel()
  }

  private restartSoon(): void {
    setTimeout(() => this.d.restart(), this.d.restartDelayMs ?? 1200)
  }
}
