import { beforeEach, describe, it, expect, vi } from 'vitest'

// Race scenario: initDiscord is called, client.login() hangs (network, slow
// Discord response, whatever), and SIGTERM arrives. The fix keeps
// stopDiscord() able to find the wrapper even while start() is still
// pending, so it can call destroy() on the in-flight client.

let resolveLogin: (() => void) | null = null
let destroyCalled = 0

class MockDiscordClient {
  static instances: MockDiscordClient[] = []
  constructor(_opts: unknown) {
    MockDiscordClient.instances.push(this)
  }
  on() {
    return this
  }
  once() {
    return this
  }
  login(): Promise<void> {
    return new Promise<void>((resolve) => {
      resolveLogin = resolve
    })
  }
  destroy(): Promise<void> {
    destroyCalled += 1
    // Let the pending login resolve so nothing leaks.
    resolveLogin?.()
    return Promise.resolve()
  }
  channels = { fetch: async () => null }
}

vi.mock('discord.js', () => ({
  Client: MockDiscordClient,
  Events: {
    MessageCreate: 'messageCreate',
    ClientReady: 'clientReady',
    Error: 'error',
  },
  GatewayIntentBits: { DirectMessages: 1, MessageContent: 2 },
  Partials: { Channel: 'c', Message: 'm' },
  ChannelType: { DM: 1 },
}))

vi.mock('../src/config.js', () => ({
  DISCORD_ENABLED: true,
  DISCORD_BOT_TOKEN: 'mock-token',
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

// handler.ts transitively loads db.ts/memory.ts/agent.ts which we do not want
// to pull into this test. Stub it out.
vi.mock('../src/discord/handler.js', () => ({
  handleDiscordMessage: async () => {},
}))

const { initDiscord, stopDiscord } = await import('../src/discord/index.js')

beforeEach(() => {
  resolveLogin = null
  destroyCalled = 0
  MockDiscordClient.instances.length = 0
})

describe('Discord shutdown race', () => {
  it('stopDiscord during in-flight login still destroys the client', async () => {
    // Fire initDiscord but do NOT await — login() hangs forever.
    const startP = initDiscord()

    // Yield so initDiscord reaches `await client.start()` and login is pending.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(MockDiscordClient.instances.length).toBe(1)
    expect(destroyCalled).toBe(0)

    // Arrive-of-SIGTERM equivalent: shutdown fires while login still hangs.
    await stopDiscord()

    expect(destroyCalled).toBe(1)

    // startP eventually resolves or rejects — either is fine, we just
    // don't want an unhandled-rejection warning in the test runner.
    await startP.catch(() => {})
  })

  it('clears the active singleton when start() throws so a retry is clean', async () => {
    // Make login reject synchronously on the next start() call.
    const origLogin = MockDiscordClient.prototype.login
    MockDiscordClient.prototype.login = function () {
      return Promise.reject(new Error('bad token'))
    }
    try {
      await expect(initDiscord()).rejects.toThrow(/bad token/)
      // stopDiscord should be a no-op now — active was cleared on the throw.
      await stopDiscord()
      expect(destroyCalled).toBe(0)
    } finally {
      MockDiscordClient.prototype.login = origLogin
    }
  })
})
