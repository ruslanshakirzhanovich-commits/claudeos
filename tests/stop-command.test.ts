import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({
  isAuthorised: (chatId: string) => chatId === 'allowed-chat',
}))

// We test the logic directly without a real bot, by calling the handler
// that registerStop would register.
async function simulateStop(
  chatId: string,
  activeAgents: Map<string, AbortController>,
): Promise<string> {
  let reply = ''
  const ctx = {
    chat: { id: chatId },
    reply: (text: string) => { reply = text; return Promise.resolve() },
  }
  // Import and invoke directly
  const { handleStopCommand } = await import('../src/commands/stop.js')
  await handleStopCommand(ctx as any, activeAgents)
  return reply
}

beforeEach(() => vi.resetModules())

describe('handleStopCommand', () => {
  it('replies "Ничего не запущено" when no active agent', async () => {
    const reply = await simulateStop('allowed-chat', new Map())
    expect(reply).toBe('Ничего не запущено.')
  })

  it('calls abort and replies 🛑 when agent is active', async () => {
    const ctrl = new AbortController()
    const abortSpy = vi.spyOn(ctrl, 'abort')
    const map = new Map([['allowed-chat', ctrl]])
    const reply = await simulateStop('allowed-chat', map)
    expect(abortSpy).toHaveBeenCalled()
    expect(reply).toContain('🛑')
  })

  it('does nothing for unauthorised chat', async () => {
    const ctrl = new AbortController()
    const abortSpy = vi.spyOn(ctrl, 'abort')
    const map = new Map([['banned-chat', ctrl]])
    const reply = await simulateStop('banned-chat', map)
    expect(abortSpy).not.toHaveBeenCalled()
    expect(reply).toBe('')
  })
})
