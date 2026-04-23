import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  CLAUDE_DEFAULT_EFFORT: 'medium',
  EFFORT_TOKENS_LOW: 2048,
  EFFORT_TOKENS_MEDIUM: 8192,
  EFFORT_TOKENS_HIGH: 24576,
  EFFORT_TOKENS_XHIGH: 65536,
  RATE_LIMIT_CAPACITY: 2,
  RATE_LIMIT_REFILL_PER_MIN: 1,
}))

const runAgentSpy = vi.fn()
vi.mock('../src/agent.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}))

const setSessionSpy = vi.fn()
vi.mock('../src/db.js', () => ({
  getSession: () => null,
  setSession: (...args: unknown[]) => setSessionSpy(...args),
  getEffortLevel: () => null,
  getPreferredModel: () => null,
}))

const buildMemorySpy = vi.fn(async () => '')
const saveTurnSpy = vi.fn(async () => {})
vi.mock('../src/memory.js', () => ({
  buildMemoryContext: (...args: unknown[]) => buildMemorySpy(...args),
  saveConversationTurn: (...args: unknown[]) => saveTurnSpy(...args),
}))

const noop = () => {}
const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log } as never

const { runChatPipeline } = await import('../src/chat-pipeline.js')
const { resetRateLimitForTest } = await import('../src/rate-limit.js')

beforeEach(() => {
  runAgentSpy.mockReset()
  setSessionSpy.mockReset()
  buildMemorySpy.mockClear()
  saveTurnSpy.mockClear()
  resetRateLimitForTest()
})

describe('runChatPipeline', () => {
  it('returns rate-limited when the bucket is empty', async () => {
    // Capacity is 2 in the mocked config; third call should fail.
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: '<u>hi</u>', permissionMode: 'plan', log })
    await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: '<u>hi</u>', permissionMode: 'plan', log })
    const result = await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: '<u>hi</u>', permissionMode: 'plan', log })
    expect(result.kind).toBe('rate-limited')
    if (result.kind === 'rate-limited') {
      expect(result.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('prepends memory context to the wrapped user message', async () => {
    buildMemorySpy.mockResolvedValueOnce('<memory_context>known fact</memory_context>')
    runAgentSpy.mockResolvedValue({ text: 'ack' })

    await runChatPipeline({
      chatId: 'a',
      userMessage: 'hi',
      wrappedUserMessage: '<wrapped>hi</wrapped>',
      permissionMode: 'plan',
      log,
    })

    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    const [prompt] = runAgentSpy.mock.calls[0]!
    expect(String(prompt)).toContain('<memory_context>known fact</memory_context>')
    expect(String(prompt)).toContain('<wrapped>hi</wrapped>')
  })

  it('sends the wrapped message directly when no memory context is available', async () => {
    buildMemorySpy.mockResolvedValueOnce('')
    runAgentSpy.mockResolvedValue({ text: 'ack' })

    await runChatPipeline({
      chatId: 'a',
      userMessage: 'hi',
      wrappedUserMessage: '<wrapped>hi</wrapped>',
      permissionMode: 'plan',
      log,
    })

    const [prompt] = runAgentSpy.mock.calls[0]!
    expect(String(prompt)).toBe('<wrapped>hi</wrapped>')
  })

  it('persists a new session id only when the agent returns one', async () => {
    runAgentSpy.mockResolvedValueOnce({ text: 'ok', newSessionId: 'sess-123' })
    await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: 'hi', permissionMode: 'plan', log })
    expect(setSessionSpy).toHaveBeenCalledWith('a', 'sess-123')

    setSessionSpy.mockReset()
    runAgentSpy.mockResolvedValueOnce({ text: 'ok' })
    await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: 'hi', permissionMode: 'plan', log })
    expect(setSessionSpy).not.toHaveBeenCalled()
  })

  it('saves a conversation turn only when the agent returned text', async () => {
    runAgentSpy.mockResolvedValueOnce({ text: 'reply' })
    await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: 'hi', permissionMode: 'plan', log })
    expect(saveTurnSpy).toHaveBeenCalledWith('a', 'hi', 'reply')

    saveTurnSpy.mockClear()
    runAgentSpy.mockResolvedValueOnce({ text: null })
    await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: 'hi', permissionMode: 'plan', log })
    expect(saveTurnSpy).not.toHaveBeenCalled()
  })

  it('returns an error result (not throw) when the agent fails', async () => {
    const err = new Error('claude down')
    runAgentSpy.mockRejectedValueOnce(err)
    const result = await runChatPipeline({ chatId: 'a', userMessage: 'hi', wrappedUserMessage: 'hi', permissionMode: 'plan', log })
    expect(result).toEqual({ kind: 'error', error: err })
  })
})
