import { beforeEach, describe, it, expect, vi } from 'vitest'

// Mocks must come before importing the handler so vi.mock applies.

vi.mock('../src/config.js', () => ({
  // Empty allowlist = open mode (matches WhatsApp pattern). The
  // explicit-allowlist case is exercised inside its own test below.
  isDiscordUserAuthorised: (userId: string) => allowlist === null || allowlist.includes(userId),
  // By default no Discord admins, to match the default config behavior.
  // Specific tests that want bypassPermissions set this to true.
  isDiscordUserAdmin: (userId: string) => adminSet !== null && adminSet.includes(userId),
  // src/effort.ts pulls these at module load — must be present even though
  // the discord handler itself does not read them directly.
  CLAUDE_DEFAULT_EFFORT: 'medium',
  EFFORT_TOKENS_LOW: 2048,
  EFFORT_TOKENS_MEDIUM: 8192,
  EFFORT_TOKENS_HIGH: 24576,
  EFFORT_TOKENS_XHIGH: 65536,
  // Rate limit constants pulled by src/rate-limit.ts.
  RATE_LIMIT_CAPACITY: 10,
  RATE_LIMIT_REFILL_PER_MIN: 10,
  RATE_LIMIT_MAX_TRACKED: 10_000,
  MEMORY_EPISODIC_CAP_PER_CHAT: 1000,
}))

let allowlist: string[] | null = null
function setAllowlist(ids: string[] | null): void {
  allowlist = ids
}
let adminSet: string[] | null = null
function setAdminList(ids: string[] | null): void {
  adminSet = ids
}

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

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: async () => '',
  saveConversationTurn: async () => {},
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

const { handleDiscordMessage, chatIdForDiscordUser, chunkForDiscord } =
  await import('../src/discord/handler.js')

function makeMsg(over: Partial<Parameters<typeof handleDiscordMessage>[0]> = {}) {
  return {
    userId: '110440505',
    channelId: 'chan-1',
    text: 'hello',
    isDM: true,
    messageId: 'msg-1',
    authorTag: 'ruslan#0001',
    ...over,
  }
}

const { resetRateLimitForTest } = await import('../src/rate-limit.js')

beforeEach(() => {
  runAgentSpy.mockReset()
  setSessionSpy.mockReset()
  setAllowlist(null) // open mode by default
  setAdminList(null) // no admins by default
  resetRateLimitForTest()
})

describe('chatIdForDiscordUser', () => {
  it('namespaces with discord: so it cannot collide with Telegram numeric ids', () => {
    expect(chatIdForDiscordUser('110440505')).toBe('discord:110440505')
  })
})

describe('chunkForDiscord', () => {
  it('passes short text through unchanged', () => {
    expect(chunkForDiscord('hello world')).toEqual(['hello world'])
  })

  it('respects the 2000-char Discord limit', () => {
    const long = 'a'.repeat(5001)
    const chunks = chunkForDiscord(long)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
    expect(chunks.join('')).toBe(long)
  })

  it('prefers newline boundaries over hard cuts', () => {
    const block = 'x'.repeat(1500) + '\n' + 'y'.repeat(1500) + '\n' + 'z'.repeat(100)
    const chunks = chunkForDiscord(block, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    // first chunk should end at the newline boundary, not mid-block
    expect(chunks[0]?.endsWith('x'.repeat(1500))).toBe(true)
  })
})

describe('handleDiscordMessage', () => {
  it('skips guild (non-DM) messages — v1 is DM-only', async () => {
    const send = vi.fn()
    await handleDiscordMessage(makeMsg({ isDM: false }), send)
    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects unauthorised users when allowlist is non-empty', async () => {
    setAllowlist(['otherUser'])
    const send = vi.fn()
    await handleDiscordMessage(makeMsg({ userId: '999' }), send)
    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('routes authorised DMs through runAgent with namespaced chatId and plan mode', async () => {
    runAgentSpy.mockResolvedValue({ text: 'reply text' })
    const sends: Array<[string, string]> = []
    const send = async (channelId: string, text: string) => {
      sends.push([channelId, text])
    }

    await handleDiscordMessage(makeMsg(), send)

    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    const [agentInput, opts] = runAgentSpy.mock.calls[0]!
    expect(opts).toMatchObject({
      permissionMode: 'plan',
      chatId: 'discord:110440505',
    })
    // Untrusted-input wrapping must be present so prompt-injection defense
    // matches what Telegram and WhatsApp already do.
    expect(String(agentInput)).toContain('<untrusted_user_input')
    expect(String(agentInput)).toContain('hello')

    expect(sends).toEqual([['chan-1', 'reply text']])
  })

  it('upgrades to bypassPermissions when the user is in the discord admin list', async () => {
    setAdminList(['110440505'])
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const send = vi.fn(async () => {})
    await handleDiscordMessage(makeMsg(), send)
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    expect(runAgentSpy.mock.calls[0]![1]).toMatchObject({ permissionMode: 'bypassPermissions' })
  })

  it('stays in plan mode for users not on the admin list', async () => {
    setAdminList(['some-other-user'])
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const send = vi.fn(async () => {})
    await handleDiscordMessage(makeMsg(), send)
    expect(runAgentSpy.mock.calls[0]![1]).toMatchObject({ permissionMode: 'plan' })
  })

  it('chunks long replies into multiple sends so we do not exceed 2000 chars', async () => {
    const long = 'a'.repeat(4500)
    runAgentSpy.mockResolvedValue({ text: long })
    const sends: Array<[string, string]> = []
    const send = async (channelId: string, text: string) => {
      sends.push([channelId, text])
    }

    await handleDiscordMessage(makeMsg(), send)

    expect(sends.length).toBeGreaterThan(1)
    for (const [, text] of sends) expect(text.length).toBeLessThanOrEqual(2000)
    expect(sends.map(([, t]) => t).join('')).toBe(long)
  })

  it('reports a short error string back to the channel when the agent throws', async () => {
    runAgentSpy.mockRejectedValue(new Error('claude unavailable'))
    const sends: Array<[string, string]> = []
    const send = async (channelId: string, text: string) => {
      sends.push([channelId, text])
    }

    await handleDiscordMessage(makeMsg(), send)

    expect(sends).toHaveLength(1)
    expect(sends[0]?.[1]).toMatch(/Error: claude unavailable/)
  })
})
