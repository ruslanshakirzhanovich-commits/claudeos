import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { REDACT_PATHS } from '../src/logger.js'

// Build an isolated logger with the same redact config as the real one,
// but pointed at a buffer so we can assert on exactly what lands on disk.
function makeBufferedLogger(): { log: pino.Logger; lines: string[] } {
  const lines: string[] = []
  const stream = {
    write(chunk: string) {
      lines.push(chunk)
    },
  }
  const log = pino(
    {
      level: 'debug',
      redact: {
        paths: [...REDACT_PATHS],
        censor: '[redacted]',
      },
    },
    stream,
  )
  return { log, lines }
}

describe('logger redact', () => {
  it('redacts a bare token field', () => {
    const { log, lines } = makeBufferedLogger()
    log.info({ token: 'bot:SECRET123' }, 'sending')
    const joined = lines.join('')
    expect(joined).not.toContain('SECRET123')
    expect(joined).toContain('[redacted]')
  })

  it('redacts Authorization headers nested in a request config', () => {
    const { log, lines } = makeBufferedLogger()
    log.error(
      {
        err: {
          message: 'request failed',
          config: { headers: { Authorization: 'Bearer SECRET_TOKEN' } },
        },
      },
      'agent call failed',
    )
    const joined = lines.join('')
    expect(joined).not.toContain('SECRET_TOKEN')
    expect(joined).toContain('[redacted]')
  })

  it('redacts the Telegram webhook secret header', () => {
    const { log, lines } = makeBufferedLogger()
    log.warn(
      {
        req: {
          headers: {
            'x-telegram-bot-api-secret-token': 'HOOK_SECRET',
            'content-type': 'application/json',
          },
        },
      },
      'webhook',
    )
    const joined = lines.join('')
    expect(joined).not.toContain('HOOK_SECRET')
    expect(joined).toContain('application/json')
  })

  it('redacts an apiKey field without affecting sibling diagnostic data', () => {
    const { log, lines } = makeBufferedLogger()
    log.info({ apiKey: 'GROQ-XYZ', model: 'whisper-large-v3', latencyMs: 412 }, 'transcription')
    const joined = lines.join('')
    expect(joined).not.toContain('GROQ-XYZ')
    expect(joined).toContain('whisper-large-v3')
    expect(joined).toContain('412')
  })

  it('leaves non-secret payloads alone', () => {
    const { log, lines } = makeBufferedLogger()
    log.info({ chatId: '123', preview: 'hi' }, 'message received')
    const joined = lines.join('')
    expect(joined).toContain('"chatId":"123"')
    expect(joined).toContain('"preview":"hi"')
    expect(joined).not.toContain('[redacted]')
  })
})
