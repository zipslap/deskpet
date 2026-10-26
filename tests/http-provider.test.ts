import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAnthropicBody,
  buildOpenAiBody,
  classifyHttpError,
  HttpProvider,
  normaliseTurns,
  parseAnthropicEvent,
  parseOpenAiEvent,
  SseParser,
  type HttpProviderOptions
} from '../src/services/ai/http-provider'
import { ProviderError } from '../src/services/ai/provider'

describe('SseParser', () => {
  it('splits events across chunks and ignores comments', () => {
    const p = new SseParser()
    expect(p.push('data: {"a":1}\n\n: keep-al')).toEqual([{ event: 'message', data: '{"a":1}' }])
    expect(p.push('ive\n\nevent: ping\ndata: x\n\n')).toEqual([{ event: 'ping', data: 'x' }])
  })
  it('handles CRLF, even when the CR and LF arrive in different chunks', () => {
    const p = new SseParser()
    expect(p.push('data: one\r')).toEqual([])
    expect(p.push('\n\r\ndata: two\r\n\r\n')).toEqual([{ event: 'message', data: 'one' }, { event: 'message', data: 'two' }])
  })
  it('joins multi-line data', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }])
  })
})

describe('stream event decoding', () => {
  it('openai: text, done, errors, and noise', () => {
    expect(parseOpenAiEvent({ event: 'message', data: JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }) })).toEqual({ text: 'Hi' })
    expect(parseOpenAiEvent({ event: 'message', data: JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }) })).toBeNull()
    expect(parseOpenAiEvent({ event: 'message', data: JSON.stringify({ choices: [{ delta: { content: '' } }] }) })).toBeNull()
    expect(parseOpenAiEvent({ event: 'message', data: '[DONE]' })).toEqual({ done: true })
    expect(parseOpenAiEvent({ event: 'message', data: JSON.stringify({ error: { message: 'boom' } }) })).toEqual({ error: 'boom' })
    expect(parseOpenAiEvent({ event: 'message', data: 'not json' })).toBeNull()
  })
  it('anthropic: text deltas, stop and errors; thinking and tool deltas are ignored', () => {
    const ev = (o: unknown) => ({ event: 'x', data: JSON.stringify(o) })
    expect(parseAnthropicEvent(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Yo' } }))).toEqual({ text: 'Yo' })
    expect(parseAnthropicEvent(ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }))).toBeNull()
    expect(parseAnthropicEvent(ev({ type: 'message_stop' }))).toEqual({ done: true })
    expect(parseAnthropicEvent(ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))).toEqual({ error: 'Overloaded' })
    expect(parseAnthropicEvent(ev({ type: 'ping' }))).toBeNull()
  })
})

describe('request bodies', () => {
  const history = [{ role: 'user' as const, text: 'hi' }, { role: 'assistant' as const, text: 'hello' }]
  it('openai: system first, history in order, image as a data URL', () => {
    const b = buildOpenAiBody('gpt-4o', 'SYS', history, 'look', { base64: 'QUJD', mime: 'image/jpeg' }) as { messages: Array<{ role: string; content: unknown }>; stream: boolean; model: string }
    expect(b.model).toBe('gpt-4o')
    expect(b.stream).toBe(true)
    expect(b.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(b.messages[3]!.content).toEqual([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }])
  })
  it('anthropic: the system prompt is its own field, max_tokens is set, image is a base64 source', () => {
    const b = buildAnthropicBody('claude-sonnet-5-5', 'SYS', history, 'look', 1000, { base64: 'QUJD', mime: 'image/png' }) as { system: string; max_tokens: number; messages: Array<{ role: string; content: unknown }> }
    expect(b.system).toBe('SYS')
    expect(b.max_tokens).toBe(1000)
    expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(b.messages[2]!.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'look' }])
  })
  it('plain text is sent as a plain string', () => {
    const b = buildOpenAiBody('m', 's', [], 'just text') as { messages: Array<{ content: unknown }> }
    expect(b.messages[1]!.content).toBe('just text')
  })
})

describe('normaliseTurns', () => {
  it('merges neighbours with the same role, drops empties and a leading assistant turn', () => {
    expect(
      normaliseTurns([
        { role: 'assistant', text: 'orphan' },
        { role: 'user', text: 'a' },
        { role: 'user', text: '  ' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' }
      ])
    ).toEqual([{ role: 'user', text: 'a\n\nb' }, { role: 'assistant', text: 'c' }])
  })
  it('keeps the newest turns when over the size limit', () => {
    const t = normaliseTurns([{ role: 'user', text: 'x'.repeat(50) }, { role: 'assistant', text: 'y'.repeat(50) }, { role: 'user', text: 'z'.repeat(10) }], 70)
    expect(t.map((x) => x.text[0])).toEqual(['z'])
  })
})

describe('classifyHttpError', () => {
  it.each([
    [401, /rejected the API key/],
    [403, /rejected the API key/],
    [404, /model/],
    [429, /rate limit/],
    [503, /busy/],
    [400, /refused/]
  ])('HTTP %i', (status, re) => {
    expect(classifyHttpError('Acme', status, '')).toMatch(re)
  })
  it("quotes the service's own message, trimmed to one line", () => {
    expect(classifyHttpError('Acme', 400, JSON.stringify({ error: { message: 'bad\nthing' } }))).toContain('(Acme says: bad thing)')
  })
  it('never echoes a long body', () => {
    expect(classifyHttpError('Acme', 500, 'x'.repeat(5000)).length).toBeLessThan(400)
  })
})

// ---- against a real local server (loopback http is allowed) ----
let server: Server
let base = ''
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(req, res, body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

const sse = (res: ServerResponse, lines: string[]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const l of lines) res.write(l)
  res.end()
}
const opts = (over: Partial<HttpProviderOptions> = {}): HttpProviderOptions => ({
  kind: 'openai-compatible',
  service: 'Acme',
  baseUrl: base + '/v1',
  getKey: async () => 'sk-test',
  needsKey: true,
  model: () => 'm1',
  systemPrompt: () => 'SYSTEM',
  ...over
})
const collect = async (p: HttpProvider, msg = 'hi', ctx?: Parameters<HttpProvider['sendMessage']>[1], signal?: AbortSignal): Promise<string> => {
  let out = ''
  for await (const c of p.sendMessage(msg, ctx, signal)) out += c
  return out
}
const chunk = (t: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`

describe('HttpProvider (openai-compatible)', () => {
  it('streams the reply and sends the key, model, system prompt and history', async () => {
    let seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {}
    handler = (req, res, body) => {
      seen = { url: req.url, auth: req.headers['authorization'] as string, body: JSON.parse(body) }
      sse(res, [chunk('Hel'), chunk('lo'), 'data: [DONE]\n\n'])
    }
    const out = await collect(new HttpProvider(opts()), 'hi', { history: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'yes' }] })
    expect(out).toBe('Hello')
    expect(seen.url).toBe('/v1/chat/completions')
    expect(seen.auth).toBe('Bearer sk-test')
    const msgs = (seen.body as { messages: Array<{ role: string; content: string }>; model: string }).messages
    expect((seen.body as { model: string }).model).toBe('m1')
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs[0]!.content).toBe('SYSTEM')
  })
  it('sends a screenshot as an image part and tells the prompt builder a screen is attached', async () => {
    let body: { messages: Array<{ content: unknown }> } | undefined
    let screenFlag: boolean | undefined
    handler = (_req, res, b) => {
      body = JSON.parse(b)
      sse(res, [chunk('ok'), 'data: [DONE]\n\n'])
    }
    await collect(new HttpProvider(opts({ systemPrompt: (i) => ((screenFlag = i.screen), 'S') })), 'what is this', { screenshotBase64: 'QUJD', screenshotMime: 'image/jpeg' })
    expect(screenFlag).toBe(true)
    expect(JSON.stringify(body!.messages.at(-1)!.content)).toContain('data:image/jpeg;base64,QUJD')
  })
  it('needs no key for a local server', async () => {
    let auth: string | undefined = 'unset'
    handler = (req, res) => {
      auth = req.headers['authorization'] as string | undefined
      sse(res, [chunk('ok'), 'data: [DONE]\n\n'])
    }
    expect(await collect(new HttpProvider(opts({ needsKey: false, getKey: async () => null })))).toBe('ok')
    expect(auth).toBeUndefined()
  })
  it('explains a missing key without making a request', async () => {
    let hit = false
    handler = (_q, res) => ((hit = true), res.end())
    await expect(collect(new HttpProvider(opts({ getKey: async () => null })))).rejects.toThrow(/No API key.*npm run setup/)
    expect(hit).toBe(false)
  })
  it('refuses to send over plain http to anything but this computer', async () => {
    await expect(collect(new HttpProvider(opts({ baseUrl: 'http://api.example.com/v1' })))).rejects.toThrow(/https/)
  })
  it('asks for a model when none is set', async () => {
    await expect(collect(new HttpProvider(opts({ model: () => ' ' })))).rejects.toThrow(/No model is set/)
  })
  it.each([[401, /rejected the API key/], [429, /rate limit/], [500, /busy/]])('HTTP %i becomes a ProviderError', async (status, re) => {
    handler = (_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'nope' } }))
    }
    const err = await collect(new HttpProvider(opts())).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).toMatch(re)
    expect(err.message).not.toContain('sk-test')
  })
  it('an error event inside the stream is reported', async () => {
    handler = (_q, res) => sse(res, [chunk('par'), `data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`])
    await expect(collect(new HttpProvider(opts()))).rejects.toThrow(/overloaded/)
  })
  it('an empty answer is an error, not silence', async () => {
    handler = (_q, res) => sse(res, ['data: [DONE]\n\n'])
    await expect(collect(new HttpProvider(opts()))).rejects.toThrow(/without replying/)
  })
  it('a connection that cannot be made says so', async () => {
    await expect(collect(new HttpProvider(opts({ baseUrl: 'http://127.0.0.1:1/v1' })))).rejects.toThrow(/Couldn't reach Acme/)
  })
  it('stops when aborted, with an AbortError (not a ProviderError)', async () => {
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('start'))
      // never ends
    }
    const ac = new AbortController()
    const p = new HttpProvider(opts())
    const got: string[] = []
    const run = (async () => {
      for await (const c of p.sendMessage('hi', undefined, ac.signal)) {
        got.push(c)
        ac.abort()
      }
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(got).toEqual(['start'])
  })
  it('cuts off a runaway reply', async () => {
    handler = (_q, res) => sse(res, [chunk('x'.repeat(50)), chunk('y'.repeat(50))])
    await expect(collect(new HttpProvider(opts({ maxReplyChars: 60 })))).rejects.toThrow(/too long/)
  })
})

describe('HttpProvider (anthropic)', () => {
  const ev = (o: unknown): string => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`
  it('uses x-api-key, the version header and /v1/messages, and streams text deltas', async () => {
    let seen: { url?: string; key?: string; ver?: string; auth?: string; body?: { system: string; max_tokens: number } } = {}
    handler = (req, res, body) => {
      seen = { url: req.url, key: req.headers['x-api-key'] as string, ver: req.headers['anthropic-version'] as string, auth: req.headers['authorization'] as string, body: JSON.parse(body) }
      sse(res, [
        ev({ type: 'message_start', message: {} }),
        ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } }),
        ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } }),
        ev({ type: 'message_stop' })
      ])
    }
    expect(await collect(new HttpProvider(opts({ kind: 'anthropic', baseUrl: base })))).toBe('Hi there')
    expect(seen.url).toBe('/v1/messages')
    expect(seen.key).toBe('sk-test')
    expect(seen.ver).toBe('2023-06-01')
    expect(seen.auth).toBeUndefined()
    expect(seen.body!.system).toBe('SYSTEM')
    expect(seen.body!.max_tokens).toBeGreaterThan(0)
  })
})

describe('listModels', () => {
  it('reads the ids, drops the "models/" prefix, sorts, and survives garbage', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/v1/models')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'models/b-model' }, { id: 'a-model' }, { id: 'bad name with spaces' }, { nope: 1 }] }))
    }
    expect(await new HttpProvider(opts()).listModels()).toEqual(['a-model', 'b-model'])
  })
  it('is empty on an error status or when unreachable', async () => {
    handler = (_q, res) => ((res.statusCode = 401), res.end())
    expect(await new HttpProvider(opts()).listModels()).toEqual([])
    expect(await new HttpProvider(opts({ baseUrl: 'http://127.0.0.1:1/v1' })).listModels()).toEqual([])
  })
})
