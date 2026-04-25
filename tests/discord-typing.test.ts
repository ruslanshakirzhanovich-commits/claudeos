import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  isDiscordUserAuthorised: () => true,
  isDiscordUserAdmin: () => false,
  CLAUDE_DEFAULT_EFFORT: 'medium',
  EFFORT_TOKENS_LOW: 2048,
  EFFORT_TOKENS_MEDIUM: 8192,
  EFFORT_TOKENS_HIGH: 24576,
  EFFORT_TOKENS_XHIGH: 65536,
  RATE_LIMIT_CAPACITY: 10,
  RATE_LIMIT_REFILL_PER_MIN: 10,
  RATE_LIMIT_MAX_TRACKED: 10_000,
  MEMORY_EPISODIC_CAP_PER_CHAT: 1000,
  TYPING_REFRESH_MS: 50,
}))

const runAgentSpy = vi.fn()
vi.mock('../src/agent.js', () => ({ runAgent: (...a: unknown[]) => runAgentSpy(...a) }))
vi.mock('../src/db.js', () => ({
  getSession: () => null,
  setSession: () => {},
  getEffortLevel: () => null,
  getPreferredModel: () => null,
}))
vi.mock('../src/memory.js', () => ({
  buildMemoryContext: async () => '',
  saveConversationTurn: async () => {},
}))
vi.mock('../src/users.js', () => ({
  isOpenMode: () => false,
  addUserChat: () => ({ userId: 'u_stub', created: false }),
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

const { handleDiscordMessage } = await import('../src/discord/handler.js')
const { resetRateLimitForTest } = await import('../src/rate-limit.js')

beforeEach(() => {
  runAgentSpy.mockReset()
  resetRateLimitForTest()
})

function makeMsg() {
  return {
    userId: 'u1',
    channelId: 'chan-1',
    text: 'hi',
    isDM: true,
    messageId: 'm1',
    authorTag: 'u#1',
  }
}

describe('Discord typing indicator', () => {
  it('fires sendTyping at least once before the response goes out', async () => {
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const sendTyping = vi.fn(async () => {})
    const send = vi.fn(async () => {})

    await handleDiscordMessage(makeMsg(), send, sendTyping)

    expect(sendTyping).toHaveBeenCalled()
    expect(sendTyping.mock.calls[0]![0]).toBe('chan-1')
    // Typing must start before the reply is sent.
    const firstTypingOrder = sendTyping.mock.invocationCallOrder[0]!
    const firstSendOrder = send.mock.invocationCallOrder[0]!
    expect(firstTypingOrder).toBeLessThan(firstSendOrder)
  })

  it('keeps typing refreshed while the agent is slow', async () => {
    // Agent takes longer than TYPING_REFRESH_MS so we expect ≥2 typing pings.
    runAgentSpy.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ text: 'ok' }), 170)),
    )
    const sendTyping = vi.fn(async () => {})
    const send = vi.fn(async () => {})

    await handleDiscordMessage(makeMsg(), send, sendTyping)

    expect(sendTyping.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('works without sendTyping — parameter is optional', async () => {
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const send = vi.fn(async () => {})
    await expect(handleDiscordMessage(makeMsg(), send)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalled()
  })
})
