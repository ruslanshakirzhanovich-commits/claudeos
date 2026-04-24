import { beforeEach, describe, it, expect } from 'vitest'
import {
  tryConsume,
  resetRateLimitForTest,
  rateLimitBucketsForTest,
  type RateLimitConfig,
} from '../src/rate-limit.js'

const cfg = (maxTracked: number): RateLimitConfig => ({
  capacity: 10,
  refillPerMs: 1 / 1000,
  maxTracked,
  now: () => 1_000_000,
})

describe('rate-limit LRU eviction', () => {
  beforeEach(resetRateLimitForTest)

  it('drops the oldest bucket once maxTracked is exceeded', () => {
    const c = cfg(3)
    tryConsume('a', c)
    tryConsume('b', c)
    tryConsume('c', c)
    expect(rateLimitBucketsForTest().size).toBe(3)

    tryConsume('d', c)
    expect(rateLimitBucketsForTest().size).toBe(3)
    // "a" was the oldest and must be evicted; b/c/d remain.
    expect(rateLimitBucketsForTest().has('a')).toBe(false)
    expect(rateLimitBucketsForTest().has('b')).toBe(true)
    expect(rateLimitBucketsForTest().has('c')).toBe(true)
    expect(rateLimitBucketsForTest().has('d')).toBe(true)
  })

  it('touches a bucket on access so recently-used chats are not evicted', () => {
    const c = cfg(3)
    tryConsume('a', c)
    tryConsume('b', c)
    tryConsume('c', c)
    // Refresh "a" — it should now be the most recent.
    tryConsume('a', c)
    tryConsume('d', c)

    // "b" should be evicted (it became the oldest after a was refreshed).
    expect(rateLimitBucketsForTest().has('a')).toBe(true)
    expect(rateLimitBucketsForTest().has('b')).toBe(false)
    expect(rateLimitBucketsForTest().has('c')).toBe(true)
    expect(rateLimitBucketsForTest().has('d')).toBe(true)
  })

  it('does not evict when size is below maxTracked', () => {
    const c = cfg(1000)
    for (let i = 0; i < 50; i++) tryConsume(`chat-${i}`, c)
    expect(rateLimitBucketsForTest().size).toBe(50)
  })

  it('an evicted chat gets a fresh full bucket on the next request (no penalty)', () => {
    const c = cfg(2)
    // Burn "a" down to 8 tokens (10 capacity - 2 consumes).
    tryConsume('a', c)
    tryConsume('a', c)
    tryConsume('b', c)
    tryConsume('c', c) // this evicts "a"

    // "a" should be re-created with full capacity on its return.
    const decision = tryConsume('a', c)
    expect(decision.ok).toBe(true)
    const aBucket = rateLimitBucketsForTest().get('a')
    // After one consume from a fresh 10-token bucket, 9 tokens remain.
    expect(aBucket?.tokens).toBe(9)
  })
})
