import { beforeEach, describe, it, expect } from 'vitest'
import { tryConsume, rateLimitMessage, resetRateLimitForTest } from '../src/rate-limit.js'

function clock(initial: number) {
  let t = initial
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

const CFG = (now: () => number) => ({
  capacity: 3,
  refillPerMs: 1 / 1000, // 1 token per second
  now,
})

describe('tryConsume', () => {
  beforeEach(() => resetRateLimitForTest())

  it('lets the first burst through up to capacity', () => {
    const c = clock(0)
    const cfg = CFG(c.now)
    expect(tryConsume('a', cfg).ok).toBe(true)
    expect(tryConsume('a', cfg).ok).toBe(true)
    expect(tryConsume('a', cfg).ok).toBe(true)
    const denied = tryConsume('a', cfg)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('refills at the configured rate', () => {
    const c = clock(0)
    const cfg = CFG(c.now)
    for (let i = 0; i < 3; i++) tryConsume('a', cfg)
    expect(tryConsume('a', cfg).ok).toBe(false)

    c.advance(1_000) // one second → one token
    expect(tryConsume('a', cfg).ok).toBe(true)
    expect(tryConsume('a', cfg).ok).toBe(false)
  })

  it('never accumulates tokens past capacity', () => {
    const c = clock(0)
    const cfg = CFG(c.now)
    c.advance(1_000_000) // long idle period
    for (let i = 0; i < 3; i++) expect(tryConsume('a', cfg).ok).toBe(true)
    expect(tryConsume('a', cfg).ok).toBe(false)
  })

  it('tracks chatIds independently', () => {
    const c = clock(0)
    const cfg = CFG(c.now)
    for (let i = 0; i < 3; i++) tryConsume('a', cfg)
    expect(tryConsume('a', cfg).ok).toBe(false)
    expect(tryConsume('b', cfg).ok).toBe(true)
  })

  it('capacity <= 0 disables the limiter entirely', () => {
    const cfg = { capacity: 0, refillPerMs: 0, now: () => 0 }
    for (let i = 0; i < 1000; i++) expect(tryConsume('a', cfg).ok).toBe(true)
  })

  it('retryAfterMs estimates correctly when fully drained', () => {
    const c = clock(0)
    const cfg = CFG(c.now)
    for (let i = 0; i < 3; i++) tryConsume('a', cfg)
    // Next token arrives ~1s later
    const denied = tryConsume('a', cfg)
    expect(denied.retryAfterMs).toBe(1000)
  })
})

describe('rateLimitMessage', () => {
  it('reports retry window in whole seconds (min 1)', () => {
    expect(rateLimitMessage(0)).toContain('1s')
    expect(rateLimitMessage(500)).toContain('1s')
    expect(rateLimitMessage(4200)).toContain('5s')
  })
})
