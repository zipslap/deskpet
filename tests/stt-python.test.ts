import { existsSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HelperStt } from '../src/services/voice/helper-stt'
import type { SttEndReason } from '../src/services/voice/types'

// Runs the real offline recogniser (native/stt/stt_server.py) against a recording that ships inside the speech model, with a fake microphone.
// Skipped unless `npm run voices -- setup` and `npm run speech -- install stt-en` have been run on this machine.
const data =
  process.env['DESKPET_DATA_DIR'] ||
  (platform() === 'darwin' ? join(homedir(), 'Library/Application Support/DeskPet') : platform() === 'win32' ? join(process.env['APPDATA'] ?? homedir(), 'DeskPet') : join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'DeskPet'))
const python = join(data, 'voices', platform() === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python')
const model = join(data, 'speech/models/stt-en')
const wavDir = join(model, 'test_wavs')
const ready = existsSync(python) && existsSync(join(model, 'tokens.txt')) && existsSync(wavDir)
const wav = ready ? join(wavDir, readdirSync(wavDir).find((f) => f.endsWith('.wav')) ?? 'none.wav') : ''

describe.skipIf(!ready)('offline speech recognition (python helper)', () => {
  const stt = (): HelperStt => new HelperStt({ helperPath: python, helperArgs: [resolve(__dirname, '../native/stt/stt_server.py'), '--model', model], ready: () => true })

  it('reports itself installed', async () => {
    expect((await stt().status('en-US')).installed).toBe(true)
  })
  it('turns a recording into a final transcript and ends on the pause after it', async () => {
    const partials: string[] = []
    let final = ''
    let listening = false
    const reason = await new Promise<SttEndReason>((done) => {
      process.env['DESKPET_STT_FAKE_WAV'] = wav
      stt().start(
        { locale: 'en-US', allowServerRecognition: false, maxSeconds: 40, silenceMs: 1200 },
        { onListening: () => (listening = true), onLevel: () => {}, onPartial: (t) => partials.push(t), onFinal: (t) => (final = t), onError: () => {}, onEnded: done }
      )
    })
    delete process.env['DESKPET_STT_FAKE_WAV']
    expect(listening).toBe(true)
    expect(reason).toBe('silence')
    expect(partials.length).toBeGreaterThan(2)
    expect(final.length).toBeGreaterThan(10)
    expect(final[0]).toBe(final[0]!.toUpperCase()) // tidied into a sentence
  }, 60_000)
  it('stop delivers what was heard so far; cancel discards it', async () => {
    const run = (cmd: 'stop' | 'cancel'): Promise<{ reason: SttEndReason; final: string }> =>
      new Promise((done) => {
        process.env['DESKPET_STT_FAKE_WAV'] = wav
        let final = ''
        const s = stt().start(
          { locale: 'en-US', allowServerRecognition: false, maxSeconds: 40, silenceMs: 1200 },
          { onListening: () => setTimeout(() => s[cmd](), 2500), onLevel: () => {}, onPartial: () => {}, onFinal: (t) => (final = t), onError: () => {}, onEnded: (reason) => done({ reason, final }) }
        )
      })
    const stopped = await run('stop')
    expect(stopped.reason).toBe('stopped')
    expect(stopped.final.length).toBeGreaterThan(0)
    const cancelled = await run('cancel')
    delete process.env['DESKPET_STT_FAKE_WAV']
    expect(cancelled.reason).toBe('cancelled')
    expect(cancelled.final).toBe('')
  }, 60_000)
  it('says plainly when no model is installed', async () => {
    const errors: string[] = []
    const reason = await new Promise<SttEndReason>((done) => {
      new HelperStt({ helperPath: python, helperArgs: [resolve(__dirname, '../native/stt/stt_server.py'), '--model', '/no/such/model'], ready: () => true }).start(
        { locale: 'en-US', allowServerRecognition: false, maxSeconds: 5, silenceMs: 1200 },
        { onListening: () => {}, onLevel: () => {}, onPartial: () => {}, onFinal: () => {}, onError: (e) => errors.push(e.code), onEnded: done }
      )
    })
    expect(errors).toContain('not-installed')
    expect(reason).toBe('error')
  }, 30_000)
})
