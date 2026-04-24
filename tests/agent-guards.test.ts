import { beforeEach, describe, it, expect, vi } from 'vitest'

const querySpy = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => querySpy(...args),
}))

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp/claudeos-test',
  CLAUDE_MODEL: '',
  AGENT_RETRY_ATTEMPTS: 1,
  AGENT_RETRY_BASE_MS: 1,
  AGENT_MAX_TURNS: 25,
  AGENT_STREAM_TIMEOUT_MS: 50,
}))

vi.mock('../src/logger.js', () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l }
  return { logger: l }
})

vi.mock('../src/inflight.js', () => ({ trackInflight: <T>(p: Promise<T>) => p }))
vi.mock('../src/chat-queue.js', () => ({
  runSerialPerChat: <T>(_: string, fn: () => Promise<T>) => fn(),
}))
vi.mock('../src/metrics.js', () => ({ recordEvent: () => {} }))
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

function hangingStream(signal: AbortSignal | undefined) {
  // Simulates an SDK stream that connected but never emits events. The
  // first next() resolves only when the signal fires; without a signal it
  // would hang forever (the test for that path supplies one).
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<{ value: unknown; done: boolean }>((resolve, reject) => {
            if (!signal) return
            if (signal.aborted) return reject(new Error('aborted'))
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      }
    },
  }
}

const { runAgent } = await import('../src/agent.js')

beforeEach(() => {
  querySpy.mockReset()
})

describe('runAgent SDK guards', () => {
  it('passes maxTurns to the SDK', async () => {
    querySpy.mockReturnValue(okStream())
    await runAgent('hi', { permissionMode: 'plan' })
    const call = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(call.options['maxTurns']).toBe(25)
  })

  it('passes an AbortController so callers can cancel the stream', async () => {
    querySpy.mockReturnValue(okStream())
    await runAgent('hi', { permissionMode: 'plan' })
    const call = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(call.options['abortController']).toBeInstanceOf(AbortController)
  })

  it('aborts a hanging stream after AGENT_STREAM_TIMEOUT_MS and throws', async () => {
    let capturedSignal: AbortSignal | undefined
    querySpy.mockImplementation((arg: { options: { abortController?: AbortController } }) => {
      capturedSignal = arg.options.abortController?.signal
      return hangingStream(capturedSignal)
    })

    await expect(runAgent('hi', { permissionMode: 'plan' })).rejects.toThrow()
    expect(capturedSignal?.aborted).toBe(true)
  })
})
