import { RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_MIN } from './config.js'

interface Bucket {
  tokens: number
  lastRefillMs: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitDecision {
  ok: boolean
  retryAfterMs: number
}

export interface RateLimitConfig {
  capacity: number
  refillPerMs: number
  now?: () => number
}

function envConfig(): RateLimitConfig {
  return {
    capacity: RATE_LIMIT_CAPACITY,
    refillPerMs: RATE_LIMIT_REFILL_PER_MIN / 60_000,
  }
}

export function tryConsume(
  chatId: string,
  cfg: RateLimitConfig = envConfig(),
): RateLimitDecision {
  if (cfg.capacity <= 0) return { ok: true, retryAfterMs: 0 }

  const now = (cfg.now ?? Date.now)()
  let bucket = buckets.get(chatId)
  if (!bucket) {
    bucket = { tokens: cfg.capacity, lastRefillMs: now }
    buckets.set(chatId, bucket)
  }
  const elapsed = now - bucket.lastRefillMs
  if (elapsed > 0) {
    bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * cfg.refillPerMs)
    bucket.lastRefillMs = now
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, retryAfterMs: 0 }
  }
  const deficit = 1 - bucket.tokens
  const retryAfterMs = Math.ceil(deficit / cfg.refillPerMs)
  return { ok: false, retryAfterMs }
}

export function rateLimitMessage(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return `Rate limit — slow down, try again in ${seconds}s.`
}

export function resetRateLimitForTest(): void {
  buckets.clear()
}
