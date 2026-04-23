import { describe, it, expect, beforeEach } from 'vitest'
import { runSerialPerChat, chatQueueDepth, resetChatQueuesForTest } from '../src/chat-queue.js'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runSerialPerChat', () => {
  beforeEach(() => resetChatQueuesForTest())

  it('serializes concurrent calls for the same chatId', async () => {
    const log: string[] = []
    const first = deferred<void>()
    const second = deferred<void>()

    const p1 = runSerialPerChat('chat-a', async () => {
      log.push('1:start')
      await first.promise
      log.push('1:end')
      return 'one'
    })
    const p2 = runSerialPerChat('chat-a', async () => {
      log.push('2:start')
      await second.promise
      log.push('2:end')
      return 'two'
    })

    // Second task must not start while the first is still pending.
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['1:start'])

    first.resolve()
    await new Promise((r) => setImmediate(r))
    expect(log).toEqual(['1:start', '1:end', '2:start'])

    second.resolve()
    expect(await p1).toBe('one')
    expect(await p2).toBe('two')
  })

  it('runs different chatIds in parallel', async () => {
    const gate = deferred<void>()
    const logA: string[] = []
    const logB: string[] = []

    const pa = runSerialPerChat('chat-a', async () => {
      logA.push('start')
      await gate.promise
      logA.push('end')
    })
    const pb = runSerialPerChat('chat-b', async () => {
      logB.push('start')
      await gate.promise
      logB.push('end')
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(logA).toEqual(['start'])
    expect(logB).toEqual(['start'])

    gate.resolve()
    await Promise.all([pa, pb])
    expect(logA).toEqual(['start', 'end'])
    expect(logB).toEqual(['start', 'end'])
  })

  it('does not block subsequent callers when a prior call rejects', async () => {
    const p1 = runSerialPerChat('chat-a', async () => {
      throw new Error('boom')
    })
    const p2 = runSerialPerChat('chat-a', async () => 'ok')

    await expect(p1).rejects.toThrow('boom')
    expect(await p2).toBe('ok')
  })

  it('propagates the real rejection, not the tail swallower', async () => {
    const err = new Error('specific failure')
    await expect(
      runSerialPerChat('chat-a', async () => {
        throw err
      }),
    ).rejects.toBe(err)
  })

  it('cleans up the tails map once the chat goes idle', async () => {
    await runSerialPerChat('chat-a', async () => 'done')
    // The cleanup attaches via tail.then, so let the microtask queue drain.
    await new Promise((r) => setImmediate(r))
    expect(chatQueueDepth()).toBe(0)
  })
})
