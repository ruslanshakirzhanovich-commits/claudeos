import { beforeEach, describe, it, expect, vi } from 'vitest'

const querySpy = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => querySpy(...args),
}))

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp/claudeos-test',
  CLAUDE_MODEL: '',
  AGENT_RETRY_ATTEMPTS: 3,
  AGENT_RETRY_BASE_MS: 1,
  AGENT_MAX_TURNS: 25,
  AGENT_STREAM_TIMEOUT_MS: 60_000,
}))

vi.mock('../src/logger.js', () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l }
  return { logger: l }
})

vi.mock('../src/inflight.js', () => ({ trackInflight: <T>(p: Promise<T>) => p }))
vi.mock('../src/chat-queue.js', () => ({
  runSerialPerChat: <T>(_: string, fn: () => Promise<T>) => fn(),
}))

const recordEventSpy = vi.fn()
vi.mock('../src/metrics.js', () => ({ recordEvent: (...a: unknown[]) => recordEventSpy(...a) }))

vi.mock('../src/effort.js', () => ({
  effortToThinkingTokens: () => 8192,
  isEffortLevel: (e: unknown) => typeof e === 'string',
}))

vi.mock('../src/usage.js', () => ({ recordUsage: () => {}, recordCompaction: () => {} }))

function okStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', result: 'ok', session_id: 'sess-1' }
    },
  }
}

function failConnectStream(err: unknown) {
  // Not an async generator — those would need `yield` somewhere to pass
  // lint. A plain AsyncIterable whose iterator rejects on first next() is
  // a cleaner model of "connection failed before any event".
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(err) }
    },
  }
}

function partialStream(err: unknown) {
  // Yields one event successfully, then throws mid-stream — this must NOT be
  // retried, because tool calls inside the stream are not idempotent.
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess-2' }
      throw err
    },
  }
}

const { runAgent } = await import('../src/agent.js')

beforeEach(() => {
  querySpy.mockReset()
  recordEventSpy.mockReset()
})

describe('runAgent retry behaviour', () => {
  it('retries a transient 529 and returns the eventual success', async () => {
    const overloaded = Object.assign(new Error('Overloaded'), { status: 529 })
    querySpy.mockReturnValueOnce(failConnectStream(overloaded))
    querySpy.mockReturnValueOnce(okStream())

    const result = await runAgent('hi', { permissionMode: 'plan' })
    expect(result.text).toBe('ok')
    expect(querySpy).toHaveBeenCalledTimes(2)
  })

  it('retries a 429 rate-limit error', async () => {
    const rate = Object.assign(new Error('Too Many Requests'), { status: 429 })
    querySpy.mockReturnValueOnce(failConnectStream(rate))
    querySpy.mockReturnValueOnce(okStream())

    const result = await runAgent('hi', { permissionMode: 'plan' })
    expect(result.text).toBe('ok')
    expect(querySpy).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a non-transient 400 error', async () => {
    const bad = Object.assign(new Error('Bad Request'), { status: 400 })
    querySpy.mockReturnValueOnce(failConnectStream(bad))

    await expect(runAgent('hi', { permissionMode: 'plan' })).rejects.toThrow('Bad Request')
    expect(querySpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry if the stream already started (mid-stream failure is non-idempotent)', async () => {
    const midway = Object.assign(new Error('network dropped'), { code: 'ECONNRESET' })
    querySpy.mockReturnValueOnce(partialStream(midway))

    await expect(runAgent('hi', { permissionMode: 'plan' })).rejects.toThrow('network dropped')
    expect(querySpy).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured attempts on persistent transient failure', async () => {
    const boom = Object.assign(new Error('still down'), { status: 503 })
    querySpy.mockReturnValue(failConnectStream(boom))

    await expect(runAgent('hi', { permissionMode: 'plan' })).rejects.toThrow('still down')
    // AGENT_RETRY_ATTEMPTS = 3 in the mocked config
    expect(querySpy).toHaveBeenCalledTimes(3)
  })
})
