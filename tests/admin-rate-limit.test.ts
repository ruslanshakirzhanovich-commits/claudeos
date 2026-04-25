import { describe, it, expect, beforeEach } from 'vitest'
import {
  tryConsumeAdmin,
  resetRateLimitForTest,
  rateLimitBucketsForTest,
} from '../src/rate-limit.js'

const buckets = rateLimitBucketsForTest()

beforeEach(() => {
  resetRateLimitForTest()
})

describe('tryConsumeAdmin', () => {
  it('grants the first five tokens to a single admin chat', () => {
    for (let i = 0; i < 5; i++) {
      const r = tryConsumeAdmin('admin-A')
      expect(r.ok).toBe(true)
    }
  })

  it('rejects the sixth call within the burst', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('admin-A')
    const r = tryConsumeAdmin('admin-A')
    expect(r.ok).toBe(false)
    expect(r.retryAfterMs).toBeGreaterThan(0)
  })

  it('uses a separate bucket per chatId', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('admin-A')
    const r = tryConsumeAdmin('admin-B')
    expect(r.ok).toBe(true)
  })

  it('admin bucket is independent of the user-message bucket for the same chatId', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('shared-chat')
    expect(buckets.has('admin:shared-chat')).toBe(true)
    expect(buckets.has('shared-chat')).toBe(false)
  })
})
