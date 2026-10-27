import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { imagesOf, ProviderError, type AssistantContext, type ChatProvider } from './provider'
import { renderPrompt } from './prompt'
import { launch, resolveCommand, stopProcess } from './launch'

/**
 * Runs any command-line assistant you are already signed in to (a Gemini or Codex CLI, `ollama run`, a script of your own...).
 * The whole prompt (instructions, then the conversation) is written to the command's stdin and its stdout is the reply,
 * streamed as it arrives. If one of the arguments contains `{prompt}` the prompt is put there instead and stdin is left empty.
 * `{model}` in an argument is replaced by the current model name. No shell is involved (only a Windows .cmd launcher goes through cmd.exe, with strict quoting).
 * The command runs in an empty app-owned folder with your normal environment, so its own sign-in keeps working.
 */

export interface CommandProviderOptions {
  command: string
  args: string[]
  model: () => string
  systemPrompt: (info: { screen: boolean }) => string
  workdir: string
  env?: NodeJS.ProcessEnv
  maxPromptChars?: number
  maxReplyChars?: number
  timeoutMs?: number
  killGraceMs?: number
}

const MAX_STDERR_CHARS = 8 * 1024
const oneLine = (s: string, max = 160): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' })

export function fillArgs(args: string[], model: string, prompt: string): { args: string[]; promptInArgs: boolean } {
  let promptInArgs = false
  const out = args.map((a) => {
    if (a.includes('{prompt}')) promptInArgs = true
    return a.split('{model}').join(model).split('{prompt}').join(prompt)
  })
  return { args: out, promptInArgs }
}

export class CommandProvider implements ChatProvider {
  private readonly live = new Set<ChildProcess>()

  constructor(private readonly opts: CommandProviderOptions) {}

  dispose(): void {
    for (const p of this.live) this.kill(p)
  }

  async *sendMessage(message: string, context?: AssistantContext, signal?: AbortSignal): AsyncIterable<string> {
    const o = this.opts
    if (signal?.aborted) throw abortError()
    if (imagesOf(context).length > 0) throw new ProviderError("This command-line assistant can't look at pictures. Use an API provider (see the README) to share your screen or images.")
    const env = o.env ?? process.env
    const bin = resolveCommand(o.command, env)
    if (!bin) throw new ProviderError(`Couldn't find the "${o.command}" command. Set "ai.command" in settings.json to its full path.`)
    try {
      mkdirSync(o.workdir, { recursive: true, mode: 0o700 })
    } catch (e) {
      throw new ProviderError(`Couldn't create the working folder (${oneLine((e as Error).message, 100)}).`)
    }

    const prompt = `${o.systemPrompt({ screen: false })}\n\n---\n\n${renderPrompt(context?.history ?? [], message, o.maxPromptChars)}`
    const { args, promptInArgs } = fillArgs(o.args, o.model(), prompt)
    let proc: ChildProcess
    try {
      proc = launch(bin, args, { cwd: o.workdir, env, stdio: [promptInArgs ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      throw new ProviderError(`Couldn't start "${o.command}" (${oneLine((e as Error).message, 100)}).`)
    }
    this.live.add(proc)
    const exited = new Promise<{ error: Error } | { code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.once('error', (error) => resolve({ error }))
      proc.once('close', (code, sig) => resolve({ code, signal: sig }))
    })
    let stderr = ''
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (d: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d
    })
    if (!promptInArgs) {
      proc.stdin!.on('error', () => {})
      proc.stdin!.end(prompt)
    }
    const onAbort = (): void => this.kill(proc)
    signal?.addEventListener('abort', onAbort, { once: true })

    let streamed = 0
    const maxReply = o.maxReplyChars ?? 100_000
    try {
      const decoder = new StringDecoder('utf8')
      for await (const chunk of proc.stdout!) {
        const text = decoder.write(chunk as Buffer)
        if (!text) continue
        streamed += text.length
        if (streamed > maxReply) {
          this.kill(proc)
          throw new ProviderError('The reply was too long and was cut off.')
        }
        yield text
      }
      const rest = decoder.end()
      if (rest) yield rest
      if (signal?.aborted) throw abortError()
      const exit = await exited
      if ('error' in exit) {
        throw new ProviderError(
          (exit.error as NodeJS.ErrnoException).code === 'ENOENT' ? `Couldn't find the "${o.command}" command.` : `Couldn't start "${o.command}" (${oneLine(exit.error.message, 100)}).`
        )
      }
      if (exit.code !== 0) {
        const why = oneLine(stderr, 160)
        throw new ProviderError(`"${o.command}" failed (exit ${exit.code ?? exit.signal})${why ? `: ${why}` : '.'}`)
      }
      if (streamed === 0) throw new ProviderError(`"${o.command}" ended without replying.`)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.kill(proc)
      void exited.then(() => this.live.delete(proc))
    }
  }

  private kill(proc: ChildProcess): void {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    stopProcess(proc, 'SIGTERM')
    const t = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) stopProcess(proc, 'SIGKILL')
    }, this.opts.killGraceMs ?? 2000)
    t.unref()
    proc.once('close', () => clearTimeout(t))
  }
}
