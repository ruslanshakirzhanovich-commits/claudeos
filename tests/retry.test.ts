import { describe, it, expect } from 'vitest'
import { withRetry, isTransientError } from '../src/retry.js'

describe('isTransientError', () => {
  it('flags node network error codes', () => {
    expect(isTransientError(Object.assign(new Error(), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientError(Object.assign(new Error(), { code: 'ETIMEDOUT' }))).toBe(true)
  })

  it('flags 5xx and 429 on error_code (grammy)', () => {
    expect(isTransientError({ error_code: 429 })).toBe(true)
    expect(isTransientError({ error_code: 502 })).toBe(true)
    expect(isTransientError({ error_code: 400 })).toBe(false)
    expect(isTransientError({ error_code: 403 })).toBe(false)
  })

  it('flags 5xx via status field', () => {
    expect(isTransientError({ status: 503 })).toBe(true)
    expect(isTransientError({ statusCode: 504 })).toBe(true)
    expect(isTransientError({ status: 404 })).toBe(false)
  })

  it('flags grammy HttpError by name', () => {
    const e = new Error('boom')
    e.name = 'HttpError'
    expect(isTransientError(e)).toBe(true)
  })

  it('flags 429/5xx in message text', () => {
    expect(isTransientError(new Error('Meta send 502: gateway'))).toBe(true)
    expect(isTransientError(new Error('Groq STT 429: rate limit'))).toBe(true)
    expect(isTransientError(new Error('some unrelated 200 OK'))).toBe(false)
  })

  it('does not flag ordinary errors', () => {
    expect(isTransientError(new Error('invalid input'))).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError(undefined)).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns on first try if no error', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries transient errors up to attempts', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' })
        return 'ok'
      },
      { baseMs: 1, attempts: 3 },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('throws immediately on non-transient errors', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('bad input')
        },
        { baseMs: 1, attempts: 3 },
      ),
    ).rejects.toThrow('bad input')
    expect(calls).toBe(1)
  })

  it('throws after exhausting attempts on persistent transient error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw Object.assign(new Error('gone'), { code: 'ETIMEDOUT' })
        },
        { baseMs: 1, attempts: 3 },
      ),
    ).rejects.toThrow('gone')
    expect(calls).toBe(3)
  })

  it('honors custom shouldRetry predicate', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 2) throw new Error('custom-retryable')
        return 'done'
      },
      { baseMs: 1, shouldRetry: (err) => (err as Error).message === 'custom-retryable' },
    )
    expect(result).toBe('done')
    expect(calls).toBe(2)
  })
})
