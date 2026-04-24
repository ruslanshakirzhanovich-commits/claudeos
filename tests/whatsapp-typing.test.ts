import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  isWhatsAppAuthorised: () => true,
  isWhatsAppNumberAdmin: () => false,
  MAX_MESSAGE_LENGTH: 4096,
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
vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

const { handleWhatsAppMessage } = await import('../src/whatsapp/handler.js')
const { resetRateLimitForTest } = await import('../src/rate-limit.js')

const JID = '15551234567@s.whatsapp.net'

beforeEach(() => {
  runAgentSpy.mockReset()
  resetRateLimitForTest()
})

function makeMsg() {
  return { jid: JID, text: 'hi', isGroup: false, messageId: 'm1', timestamp: 0 }
}

describe('WhatsApp typing indicator', () => {
  it('fires sendTyping at least once before the response', async () => {
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const sendTyping = vi.fn(async () => {})
    const send = vi.fn(async () => {})

    await handleWhatsAppMessage(makeMsg(), send, sendTyping)

    expect(sendTyping).toHaveBeenCalled()
    expect(sendTyping.mock.calls[0]![0]).toBe(JID)
    const firstTypingOrder = sendTyping.mock.invocationCallOrder[0]!
    const firstSendOrder = send.mock.invocationCallOrder[0]!
    expect(firstTypingOrder).toBeLessThan(firstSendOrder)
  })

  it('refreshes typing during a slow agent call', async () => {
    runAgentSpy.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ text: 'ok' }), 170)),
    )
    const sendTyping = vi.fn(async () => {})
    const send = vi.fn(async () => {})

    await handleWhatsAppMessage(makeMsg(), send, sendTyping)

    expect(sendTyping.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('stays a no-op when sendTyping is not provided', async () => {
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const send = vi.fn(async () => {})
    await expect(handleWhatsAppMessage(makeMsg(), send)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalled()
  })
})
