import { RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_MIN, RATE_LIMIT_MAX_TRACKED } from './config.js'

interface Bucket {
  tokens: number
  lastRefillMs: number
}

// JS Map preserves insertion order, which we exploit as a cheap LRU. Deleting
// and re-setting a key moves it to the end on every access. This caps memory
// at roughly RATE_LIMIT_MAX_TRACKED entries so a long-running process with a
// high-cardinality stream of chat ids cannot grow the map unbounded.
const buckets = new Map<string, Bucket>()

export interface RateLimitDecision {
  ok: boolean
  retryAfterMs: number
}

export interface RateLimitConfig {
  capacity: number
  refillPerMs: number
  maxTracked?: number
  now?: () => number
}

function envConfig(): RateLimitConfig {
  return {
    capacity: RATE_LIMIT_CAPACITY,
    refillPerMs: RATE_LIMIT_REFILL_PER_MIN / 60_000,
    maxTracked: RATE_LIMIT_MAX_TRACKED,
  }
}

export function tryConsume(chatId: string, cfg: RateLimitConfig = envConfig()): RateLimitDecision {
  if (cfg.capacity <= 0) return { ok: true, retryAfterMs: 0 }

  const now = (cfg.now ?? Date.now)()
  let bucket = buckets.get(chatId)
  if (!bucket) {
    bucket = { tokens: cfg.capacity, lastRefillMs: now }
  } else {
    // Move-to-end: delete then re-insert so Map insertion order reflects
    // LRU recency. Mutating the existing bucket alone would leave it at
    // its original position.
    buckets.delete(chatId)
  }
  buckets.set(chatId, bucket)

  const elapsed = now - bucket.lastRefillMs
  if (elapsed > 0) {
    bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * cfg.refillPerMs)
    bucket.lastRefillMs = now
  }

  const maxTracked = cfg.maxTracked ?? 0
  if (maxTracked > 0 && buckets.size > maxTracked) {
    const oldest = buckets.keys().next().value
    if (oldest !== undefined) buckets.delete(oldest)
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

export function rateLimitBucketsForTest(): ReadonlyMap<string, Bucket> {
  return buckets
}
