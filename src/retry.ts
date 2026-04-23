import { logger, type Logger } from './logger.js'

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  label?: string
  log?: Logger
  shouldRetry?: (err: unknown) => boolean
}

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

export function isTransientError(err: unknown): boolean {
  if (!err) return false

  if ((err as Error)?.name === 'HttpError') return true

  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && TRANSIENT_NODE_CODES.has(code)) return true

  const errorCode = (err as { error_code?: unknown }).error_code
  if (typeof errorCode === 'number' && (errorCode >= 500 || errorCode === 429)) return true

  const status = (err as { status?: unknown; statusCode?: unknown }).status
    ?? (err as { statusCode?: unknown }).statusCode
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true

  const msg = (err as Error)?.message
  if (typeof msg === 'string' && /\b(429|500|502|503|504)\b/.test(msg)) return true

  return false
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const baseMs = opts.baseMs ?? 500
  const maxMs = opts.maxMs ?? 8000
  const shouldRetry = opts.shouldRetry ?? isTransientError
  const log = opts.log ?? logger

  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i === attempts - 1 || !shouldRetry(err)) throw err
      const delay = Math.min(maxMs, baseMs * 2 ** i)
      log.warn({ err, attempt: i + 1, of: attempts, delayMs: delay, label: opts.label }, 'retrying after transient failure')
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
