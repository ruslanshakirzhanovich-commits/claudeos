import { describe, it, expect } from 'vitest'
import { trackInflight, inflightCount, waitForInflight } from '../src/inflight.js'

describe('inflight tracker', () => {
  it('counts a running promise and clears on resolve', async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 20))
    trackInflight(p)
    expect(inflightCount()).toBe(1)
    await p
    await new Promise((r) => setTimeout(r, 10))
    expect(inflightCount()).toBe(0)
  })

  it('waitForInflight returns 0 when all drain in time', async () => {
    trackInflight(new Promise((r) => setTimeout(r, 20)))
    trackInflight(new Promise((r) => setTimeout(r, 30)))
    const remaining = await waitForInflight(200)
    expect(remaining).toBe(0)
  })

  it('waitForInflight reports remaining on timeout', async () => {
    const p = new Promise<void>((r) => setTimeout(r, 200))
    trackInflight(p)
    const remaining = await waitForInflight(30)
    expect(remaining).toBeGreaterThan(0)
    await p
    await new Promise((r) => setTimeout(r, 10))
  })

  it('returns 0 immediately when nothing is inflight', async () => {
    const remaining = await waitForInflight(100)
    expect(remaining).toBe(0)
  })
})
