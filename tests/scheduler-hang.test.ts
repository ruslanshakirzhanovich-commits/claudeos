import { describe, it, expect, vi } from 'vitest'

const recordEventSpy = vi.fn()
const warnSpy = vi.fn()

vi.mock('../src/metrics.js', () => ({
  recordEvent: (kind: string, payload?: unknown) => recordEventSpy(kind, payload),
}))

vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    debug: () => {},
  },
}))

const { nonOverlapping } = await import('../src/scheduler.js')

describe('nonOverlapping hang detection', () => {
  it('emits scheduler_hang exactly at the ladder thresholds {3, 10, 30, 100}', async () => {
    recordEventSpy.mockClear()
    // fn that never resolves — simulates a hung run
    const stuck = () => new Promise<void>(() => {})
    const tick = nonOverlapping(stuck)

    // Prime: first tick starts the stuck fn
    tick()
    await new Promise((r) => setImmediate(r))

    // Now drive 100 skipped ticks and observe when the hang event fires
    for (let i = 0; i < 100; i++) {
      tick()
    }
    await new Promise((r) => setImmediate(r))

    const hangCalls = recordEventSpy.mock.calls.filter((c) => c[0] === 'scheduler_hang')
    const consecutives = hangCalls.map((c) => (c[1] as { consecutive: number }).consecutive)
    expect(consecutives).toEqual([3, 10, 30, 100])
  })

  it('resets the consecutive-skip counter on successful completion', async () => {
    recordEventSpy.mockClear()
    warnSpy.mockClear()

    let hang = true
    let resolve: (() => void) | undefined
    const maybeHang = () =>
      new Promise<void>((r) => {
        if (hang) {
          resolve = r
        } else {
          r()
        }
      })

    const tick = nonOverlapping(maybeHang)
    tick() // start hung run
    for (let i = 0; i < 4; i++) tick() // 4 skipped → should fire at 3
    await new Promise((r) => setImmediate(r))

    const beforeResolve = recordEventSpy.mock.calls.filter((c) => c[0] === 'scheduler_hang').length
    expect(beforeResolve).toBe(1)

    // Resolve the hung run, then drive fresh ticks
    hang = false
    resolve!()
    await new Promise((r) => setTimeout(r, 10))

    // Now fresh runs complete immediately; counter must be reset
    tick()
    await new Promise((r) => setTimeout(r, 10))

    for (let i = 0; i < 2; i++) tick()
    await new Promise((r) => setImmediate(r))

    // No new hang events since the reset
    const afterReset = recordEventSpy.mock.calls.filter((c) => c[0] === 'scheduler_hang').length
    expect(afterReset).toBe(1)
  })
})
