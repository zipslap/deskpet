import type { ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { imagesOf, ProviderError, type ChatTurn, type AssistantContext, type ChatProvider } from './provider'
import { buildSystemPrompt, renderPrompt } from './prompt'
import { launch, launchPlan, resolveCommand, stopProcess } from './launch'

export { resolveCommand }

/**
 * Talks to Claude by running the user's own, unmodified `claude` command (Claude Code) once per message in print mode.
 *
 * Why this route: Anthropic's terms say apps must not offer Claude.ai login or route requests through someone's
 * subscription credentials themselves, but an end user may sign in to the unmodified Claude Code binary with their own
 * subscription. So this app never sees, stores or forwards a credential: the `claude` command is already signed in (or
 * not) on its own and does its own authentication. Nothing here reads its credential store.
 *
 * Every run is locked down: no tools, no MCP servers/connectors, no user or project settings, no skills or slash
 * commands, no saved session, an app-owned empty working directory, and a minimal environment (so a stray
 * ANTHROPIC_API_KEY or cloud-provider variable can never silently switch the request to separately billed usage).
 * The first event of the stream is checked against those expectations and the run is stopped if they do not hold.
 */

const MAX_LINE_CHARS = 2 * 1024 * 1024
const MAX_STDERR_CHARS = 8 * 1024

export interface ClaudeCliOptions {
  /** Bare command name (searched on PATH and common install folders) or absolute path. */
  command: string
  /** Passed to `--model`; a function is asked on every message, so the model can be switched while the app runs. */
  model: string | (() => string)
  /** Passed to `--effort` when set (low, medium, high, xhigh, max). */
  effort?: () => string | undefined
  /** The system prompt for the next message (re-read every time, so memory changes are picked up). */
  systemPrompt?: (info: { screen: boolean }) => string
  /** Empty, app-owned directory the CLI runs in, so no project files, CLAUDE.md or project memory are picked up. */
  workdir: string
  /** Allow a CLI that is signed in with a (separately billed) API key or cloud provider instead of a subscription. */
  allowBilledApi?: boolean
  /** Environment to derive the child's from. Default: process.env. */
  env?: NodeJS.ProcessEnv
  /** Conversation text sent along is trimmed (oldest first) to this many characters. */
  maxPromptChars?: number
  /** A reply longer than this is cut off with an error. */
  maxReplyChars?: number
  /** Time between SIGTERM and SIGKILL when stopping a run. */
  killGraceMs?: number
}

// ---------- pure helpers (exported for tests) ----------

/** Variables a child may inherit. Everything else — notably ANTHROPIC_*, AWS_*, CLAUDE_CODE_* — is dropped. */
const ENV_ALLOW = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
])

export function buildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOW) if (typeof source[key] === 'string') out[key] = source[key]
  return out
}

/** `streamInput`: the message goes in as one stream-json line (needed to carry an image) instead of plain text on stdin. */
/** `mcpConfig`: a file holding the empty server list, for launchers that cannot carry a quote character in an argument (Windows .cmd). */
export function buildArgs(model: string, promptFile: string, effort?: string, streamInput = false, mcpConfig = '{"mcpServers":{}}'): string[] {
  return [
    '-p',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt-file', promptFile,
    ...(streamInput ? ['--input-format', 'stream-json'] : []),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages'
  ]
}

export type StreamEvent =
  | { kind: 'init'; tools: unknown; mcpServers: unknown; skills: unknown; slashCommands: unknown; apiKeySource: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'result'; isError: boolean; text: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One line of `--output-format stream-json`. Anything unrecognised (or not JSON) is ignored. */
export function parseStreamLine(line: string): StreamEvent | null {
  let e: unknown
  try {
    e = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(e)) return null
  if (e['type'] === 'system' && e['subtype'] === 'init') {
    return { kind: 'init', tools: e['tools'], mcpServers: e['mcp_servers'], skills: e['skills'], slashCommands: e['slash_commands'], apiKeySource: e['apiKeySource'] }
  }
  if (e['type'] === 'stream_event' && isObj(e['event'])) {
    const ev = e['event']
    const d = ev['delta']
    if (ev['type'] === 'content_block_delta' && isObj(d) && d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text'] !== '') {
      return { kind: 'text', text: d['text'] }
    }
    return null
  }
  if (e['type'] === 'result') return { kind: 'result', isError: e['is_error'] === true, text: typeof e['result'] === 'string' ? e['result'] : '' }
  return null
}

/** Why a run is unsafe to continue, from its init event; null when it is the locked-down, subscription-only run we asked for. */
export function initProblem(e: Extract<StreamEvent, { kind: 'init' }>, allowBilledApi: boolean): string | null {
  const empty = (v: unknown): boolean => Array.isArray(v) && v.length === 0
  if (!empty(e.tools) || !empty(e.mcpServers)) {
    return 'Safety check failed: Claude started with tools or connectors enabled, so the request was stopped before anything was sent.'
  }
  // skills/slash commands are only checked when reported (older versions omit them)
  if ((e.skills !== undefined && !empty(e.skills)) || (e.slashCommands !== undefined && !empty(e.slashCommands))) {
    return 'Safety check failed: Claude started with skills or commands enabled, so the request was stopped before anything was sent.'
  }
  if (e.apiKeySource !== 'none' && !allowBilledApi) {
    return 'This run would use an API key, which is billed separately from your Claude subscription, so it was stopped. Sign in with your Claude account (Terminal: claude auth login) or set "claude.allowBilledApi": true in settings.json if you really want that.'
  }
  return null
}

const NOT_SIGNED_IN = "Claude isn't signed in (or the sign-in expired). Open Terminal and run: claude auth login"

const oneLine = (s: string, max = 160): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

/** A user-presentable message for an error text from the CLI (result error or stderr). */
export function classifyError(raw: string): string {
  const t = oneLine(raw, 400)
  if (/not logged in|\/login|log ?in|sign ?in|unauthori[sz]ed|\b401\b|invalid (x-)?api[ -]?key|authentication|oauth|token.*(expired|revoked)/i.test(t)) return NOT_SIGNED_IN
  if (/usage limit|hit your limit|limit reached|rate.?limit|\b429\b|too many requests|quota/i.test(t)) {
    return `Claude's usage limit or rate limit was hit. Try again later.${t ? ` (Claude says: ${oneLine(t, 120)})` : ''}`
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|unable to connect|network|offline|getaddrinfo|socket hang up|certificate/i.test(t)) {
    return "Couldn't reach Claude. Check your internet connection and try again."
  }
  if (/overloaded|\b529\b|\b50[0-4]\b|internal server error|service unavailable/i.test(t)) return "Claude's service is busy or having problems. Try again in a moment."
  return t ? `Claude returned an error: ${oneLine(t, 140)}` : 'Claude returned an error. You can try again.'
}

const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' })

// ---------- the provider ----------

type Exit = { error: Error } | { code: number | null; signal: NodeJS.Signals | null }

export class ClaudeCliProvider implements ChatProvider {
  private readonly live = new Set<ChildProcess>()
  private loginOk = false
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly opts: ClaudeCliOptions) {
    this.env = buildEnv(opts.env ?? process.env)
  }

  /** Stop every run still going (app quit). */
  dispose(): void {
    for (const p of this.live) this.kill(p)
  }

  async *sendMessage(message: string, context?: AssistantContext, signal?: AbortSignal): AsyncIterable<string> {
    if (signal?.aborted) throw abortError()
    const bin = resolveCommand(this.opts.command, this.env)
    if (!bin) {
      throw new ProviderError(
        `Couldn't find the "${this.opts.command}" command. Install Claude Code and sign in (Terminal: claude auth login), or set "claude.command" in settings.json to its full path.`
      )
    }
    try {
      mkdirSync(this.opts.workdir, { recursive: true, mode: 0o700 })
    } catch (e) {
      throw new ProviderError(`Couldn't create the working folder (${oneLine((e as Error).message, 100)}).`)
    }
    await this.ensureSignedIn(bin, signal)
    if (signal?.aborted) throw abortError()

    const prompt = renderPrompt(context?.history ?? [], message, this.opts.maxPromptChars)
    // The system prompt (which includes the user's memory) goes through a private file, not the process list.
    const promptFile = join(this.opts.workdir, 'system-prompt.txt')
    try {
      const hasScreen = Boolean(context?.screenshotBase64)
      writeFileSync(promptFile, this.opts.systemPrompt?.({ screen: hasScreen }) ?? buildSystemPrompt({ screen: hasScreen }), { mode: 0o600 })
    } catch (e) {
      throw new ProviderError(`Couldn't write the system prompt (${oneLine((e as Error).message, 100)}).`)
    }
    const model = typeof this.opts.model === 'function' ? this.opts.model() : this.opts.model
    const images = imagesOf(context)
    const image = images.length > 0
    let mcpConfig: string | undefined
    if (launchPlan(bin, [], this.env).verbatim) {
      mcpConfig = join(this.opts.workdir, 'no-mcp.json')
      try {
        writeFileSync(mcpConfig, '{"mcpServers":{}}', { mode: 0o600 })
      } catch (e) {
        throw new ProviderError(`Couldn't write the settings file (${oneLine((e as Error).message, 100)}).`)
      }
    }
    let proc: ChildProcess
    try {
      proc = launch(bin, buildArgs(model, promptFile, this.opts.effort?.(), Boolean(image), mcpConfig), { cwd: this.opts.workdir, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      throw new ProviderError(`Couldn't start the claude command (${oneLine((e as Error).message, 100)}).`)
    }
    this.live.add(proc)
    const exited = new Promise<Exit>((resolve) => {
      proc.once('error', (error) => resolve({ error }))
      proc.once('close', (code, sig) => resolve({ code, signal: sig }))
    })
    let stderr = ''
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (d: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d
    })
    proc.stdin!.on('error', () => {}) // the child may exit before reading the prompt
    // An image travels as one stream-json user message on stdin (in memory only: nothing is written to disk).
    proc.stdin!.end(
      image
        ? JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } })), { type: 'text', text: prompt }] }
          }) + '\n'
        : prompt
    )
    const onAbort = (): void => this.kill(proc)
    signal?.addEventListener('abort', onAbort, { once: true })

    let sawInit = false
    let sawResult = false
    let streamed = 0
    const maxReply = this.opts.maxReplyChars ?? 100_000
    try {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      for await (const chunk of proc.stdout!) {
        pending += decoder.write(chunk as Buffer)
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl)
          pending = pending.slice(nl + 1)
          const ev = parseStreamLine(line)
          if (!ev) continue
          if (ev.kind === 'init') {
            sawInit = true
            const problem = initProblem(ev, this.opts.allowBilledApi === true)
            if (problem) {
              this.kill(proc)
              throw new ProviderError(problem)
            }
          } else if (!sawInit) {
            // Never trust output from a run that did not first prove it is the locked-down one.
            this.kill(proc)
            throw new ProviderError('Unexpected output from the claude command (is it up to date?). The request was stopped.')
          } else if (ev.kind === 'text') {
            streamed += ev.text.length
            if (streamed > maxReply) {
              this.kill(proc)
              throw new ProviderError('The reply was too long and was cut off.')
            }
            yield ev.text
          } else {
            sawResult = true
            if (ev.isError) throw new ProviderError(classifyError(ev.text))
            if (streamed === 0 && ev.text.trim()) {
              streamed += ev.text.length
              yield ev.text // streaming deltas were not delivered; the final text still counts
            }
          }
        }
        if (pending.length > MAX_LINE_CHARS) {
          this.kill(proc)
          throw new ProviderError('Claude sent an unexpectedly large response.')
        }
      }
      if (signal?.aborted) throw abortError()
      const exit = await exited
      if ('error' in exit) {
        throw new ProviderError(
          (exit.error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Couldn't find the "${this.opts.command}" command.`
            : `Couldn't start the claude command (${oneLine(exit.error.message, 100)}).`
        )
      }
      if (!sawResult) {
        if (streamed > 0) throw new ProviderError('Claude stopped unexpectedly in the middle of the reply.')
        if (exit.code !== 0 && stderr.trim()) throw new ProviderError(classifyError(stderr))
        throw new ProviderError(exit.code === 0 ? 'Claude ended without replying.' : `The claude command failed (exit ${exit.code ?? exit.signal}).`)
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.kill(proc) // no-op once it has exited; stops it if the consumer walked away early
      void exited.then(() => this.live.delete(proc))
    }
  }

  /** SIGTERM now, SIGKILL if it has not gone after the grace period. */
  private kill(proc: ChildProcess): void {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    stopProcess(proc, 'SIGTERM')
    const t = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) stopProcess(proc, 'SIGKILL')
    }, this.opts.killGraceMs ?? 2000)
    t.unref()
    proc.once('close', () => clearTimeout(t))
  }

  /**
   * Before the first request: ask the CLI (locally, no model call) how it is signed in. Refuses an API-key or
   * cloud-provider login unless allowed, so the app can never quietly spend separately billed credits.
   * If the status cannot be read the per-run init check still applies.
   */
  private async ensureSignedIn(bin: string, signal?: AbortSignal): Promise<void> {
    if (this.loginOk) return
    const out = await this.run(bin, ['auth', 'status'], 10_000, signal)
    let status: unknown
    try {
      status = JSON.parse(out)
    } catch {
      return
    }
    if (!isObj(status)) return
    if (status['loggedIn'] === false) throw new ProviderError(NOT_SIGNED_IN)
    const method = status['authMethod']
    const provider = status['apiProvider']
    if (!this.opts.allowBilledApi && ((typeof method === 'string' && method !== 'claude.ai') || (typeof provider === 'string' && provider !== 'firstParty'))) {
      throw new ProviderError(
        `The claude command is signed in with ${typeof method === 'string' ? method : 'something other than a Claude account'}, which may be billed separately. ` +
          'Sign in with your Claude account (Terminal: claude auth login), or set "claude.allowBilledApi": true in settings.json to allow it.'
      )
    }
    this.loginOk = true
  }

  /** Run a short helper command and return its stdout (empty on failure or timeout). */
  private run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      let out = ''
      let proc: ChildProcess
      try {
        proc = launch(bin, args, { cwd: this.opts.workdir, env: this.env, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve('')
      }
      this.live.add(proc)
      const finish = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        this.live.delete(proc)
        resolve(out)
      }
      const stop = (): void => this.kill(proc)
      const timer = setTimeout(stop, timeoutMs)
      signal?.addEventListener('abort', stop, { once: true })
      proc.stdout!.setEncoding('utf8')
      proc.stdout!.on('data', (d: string) => {
        if (out.length < 16_384) out += d
      })
      proc.once('error', finish)
      proc.once('close', finish)
    })
  }
}
