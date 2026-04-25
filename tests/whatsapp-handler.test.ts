import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  isWhatsAppAuthorised: () => true,
  isWhatsAppNumberAdmin: (number: string) => adminSet !== null && adminSet.includes(number),
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
}))

let adminSet: string[] | null = null
function setAdminList(ids: string[] | null): void {
  adminSet = ids
}

const runAgentSpy = vi.fn()
vi.mock('../src/agent.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}))

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

const { handleWhatsAppMessage } = await import('../src/whatsapp/handler.js')
const { resetRateLimitForTest } = await import('../src/rate-limit.js')

const JID = '15551234567@s.whatsapp.net'

beforeEach(() => {
  runAgentSpy.mockReset()
  resetRateLimitForTest()
  setAdminList(null)
})

describe('handleWhatsAppMessage', () => {
  it('splits long replies so no single send exceeds MAX_MESSAGE_LENGTH', async () => {
    const long = 'a'.repeat(10_000)
    runAgentSpy.mockResolvedValue({ text: long })
    const sends: Array<[string, string]> = []
    const send = async (jid: string, text: string) => {
      sends.push([jid, text])
    }

    await handleWhatsAppMessage({ jid: JID, text: 'hi', isGroup: false }, send)

    expect(sends.length).toBeGreaterThan(1)
    for (const [, body] of sends) expect(body.length).toBeLessThanOrEqual(4096)
    expect(sends.every(([j]) => j === JID)).toBe(true)
  })

  it('delivers a short reply as a single send (no premature splitting)', async () => {
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const sends: Array<[string, string]> = []
    const send = async (jid: string, text: string) => {
      sends.push([jid, text])
    }

    await handleWhatsAppMessage({ jid: JID, text: 'hi', isGroup: false }, send)

    expect(sends).toEqual([[JID, 'ok']])
  })

  it('skips group messages — v1 is private only', async () => {
    const send = vi.fn()
    await handleWhatsAppMessage({ jid: '120363000@g.us', text: 'hi', isGroup: true }, send)
    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('defaults to plan mode for non-admin numbers', async () => {
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    await handleWhatsAppMessage({ jid: JID, text: 'hi', isGroup: false }, async () => {})
    expect(runAgentSpy.mock.calls[0]![1]).toMatchObject({ permissionMode: 'plan' })
  })

  it('upgrades to bypassPermissions when the number is on the admin list', async () => {
    setAdminList(['15551234567'])
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    await handleWhatsAppMessage({ jid: JID, text: 'hi', isGroup: false }, async () => {})
    expect(runAgentSpy.mock.calls[0]![1]).toMatchObject({ permissionMode: 'bypassPermissions' })
  })
})
