import { describe, it, expect, beforeEach } from 'vitest'
import {
  shouldNotifyCrash,
  crashSignature,
  resetCrashDedupForTest,
} from '../src/crash-dedup.js'

beforeEach(() => {
  resetCrashDedupForTest()
})

function err(msg: string, stack?: string): Error {
  const e = new Error(msg)
  if (stack) e.stack = stack
  return e
}

describe('crashSignature', () => {
  it('combines kind with the first 200 chars of stack', () => {
    const e = err('boom', 'Error: boom\n    at f1\n    at f2')
    const sig = crashSignature('uncaughtException', e)
    expect(sig.startsWith('uncaughtException::')).toBe(true)
    expect(sig).toContain('Error: boom')
    expect(sig.length).toBeLessThanOrEqual('uncaughtException::'.length + 200)
  })

  it('falls back to String(err) when no stack is present', () => {
    const sig = crashSignature('init', 'plain string error')
    expect(sig).toBe('init::plain string error')
  })
})

describe('shouldNotifyCrash', () => {
  it('returns true for the first occurrence of a signature', () => {
    expect(shouldNotifyCrash('uncaughtException', err('boom'))).toBe(true)
  })

  it('returns false for the same signature within the dedup window', () => {
    const e = err('boom')
    const t0 = 1_000_000
    expect(shouldNotifyCrash('uncaughtException', e, t0)).toBe(true)
    expect(shouldNotifyCrash('uncaughtException', e, t0 + 60_000)).toBe(false)
    expect(shouldNotifyCrash('uncaughtException', e, t0 + 4 * 60_000)).toBe(false)
  })

  it('returns true again once the window has passed', () => {
    const e = err('boom')
    const t0 = 1_000_000
    shouldNotifyCrash('uncaughtException', e, t0)
    expect(shouldNotifyCrash('uncaughtException', e, t0 + 5 * 60_000 + 1)).toBe(true)
  })

  it('different kinds with the same stack are not deduped together', () => {
    const e = err('boom')
    expect(shouldNotifyCrash('uncaughtException', e)).toBe(true)
    expect(shouldNotifyCrash('unhandledRejection', e)).toBe(true)
  })

  it('caps the dedup map at 100 entries (FIFO eviction)', () => {
    for (let i = 0; i < 105; i++) {
      shouldNotifyCrash('kind', err(`unique error ${i}`))
    }
    expect(shouldNotifyCrash('kind', err('unique error 0'))).toBe(true)
  })
})
