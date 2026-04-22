import { describe, it, expect } from 'vitest'
import { validateCron, computeNextRun } from '../src/scheduler.js'

describe('validateCron', () => {
  it('accepts standard 5-field expressions', () => {
    expect(validateCron('0 9 * * *')).toBe(true)
    expect(validateCron('*/5 * * * *')).toBe(true)
    expect(validateCron('0 9 * * 1-5')).toBe(true)
  })

  it('rejects garbage', () => {
    expect(validateCron('not a cron')).toBe(false)
    expect(validateCron('99 99 * * *')).toBe(false)
    expect(validateCron('abc')).toBe(false)
  })
})

describe('computeNextRun', () => {
  it('returns a future timestamp for a valid cron', () => {
    const now = Date.now()
    const next = computeNextRun('*/1 * * * *')
    expect(next).toBeGreaterThan(now)
    expect(next - now).toBeLessThanOrEqual(60_000 + 1000)
  })

  it('schedules daily 9am in the future', () => {
    const now = Date.now()
    const next = computeNextRun('0 9 * * *')
    expect(next).toBeGreaterThan(now)
  })
})
