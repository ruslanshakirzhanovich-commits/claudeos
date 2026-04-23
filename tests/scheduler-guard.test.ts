import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { nonOverlapping } = await import('../src/scheduler.js')

describe('nonOverlapping', () => {
  it('skips new calls while previous is still running', async () => {
    let started = 0
    let resolve: (() => void) | undefined
    const slow = () => new Promise<void>((r) => {
      started++
      resolve = r
    })

    let skipped = 0
    const tick = nonOverlapping(slow, () => { skipped++ })

    tick()
    tick()
    tick()

    expect(started).toBe(1)
    expect(skipped).toBe(2)

    resolve!()
    await new Promise((r) => setTimeout(r, 10))

    tick()
    expect(started).toBe(2)
    expect(skipped).toBe(2)
  })

  it('releases the guard even if the task rejects', async () => {
    let calls = 0
    const fails = async () => {
      calls++
      throw new Error('boom')
    }
    const tick = nonOverlapping(fails)

    tick()
    await new Promise((r) => setTimeout(r, 10))

    tick()
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(2)
  })
})
