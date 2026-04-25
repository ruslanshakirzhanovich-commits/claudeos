import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

vi.mock('../src/config.js', () => ({
  TYPING_REFRESH_MS: 4000,
  MAX_MESSAGE_LENGTH: 4096,
  isDiscordUserAuthorised: () => true,
  isDiscordUserAdmin: () => false,
  isWhatsAppAuthorised: () => true,
  isWhatsAppNumberAdmin: () => false,
}))

let pipelineResolve: (() => void) | undefined
const pipelineMock = vi.fn(async () => {
  await new Promise<void>((r) => {
    pipelineResolve = r
  })
  return { kind: 'ok' as const, text: 'reply' }
})

vi.mock('../src/chat-pipeline.js', () => ({
  runChatPipeline: (input: any) => pipelineMock(input),
}))

vi.mock('../src/users.js', () => ({
  isOpenMode: () => false,
  addUserChat: () => ({ userId: 'u_stub', created: false }),
}))

const { handleDiscordMessage } = await import('../src/discord/handler.js')
const { handleWhatsAppMessage } = await import('../src/whatsapp/handler.js')
const { inflightCount } = await import('../src/inflight.js')

describe('handler in-flight tracking', () => {
  it('Discord: inflightCount rises during handle and returns to 0 after', async () => {
    pipelineResolve = undefined
    const send = async () => {}
    const before = inflightCount()
    const p = handleDiscordMessage(
      { channelId: 'c', userId: 'u', authorTag: 't', text: 'hi', isDM: true } as any,
      send,
    )
    await new Promise((r) => setImmediate(r))
    expect(inflightCount()).toBeGreaterThan(before)
    pipelineResolve!()
    await p
    expect(inflightCount()).toBe(before)
  })

  it('WhatsApp: inflightCount rises during handle and returns to 0 after', async () => {
    pipelineResolve = undefined
    const send = async () => {}
    const before = inflightCount()
    const p = handleWhatsAppMessage(
      { jid: '1@s.whatsapp.net', text: 'hi', isGroup: false, messageId: 'm', timestamp: 0 } as any,
      send,
    )
    await new Promise((r) => setImmediate(r))
    expect(inflightCount()).toBeGreaterThan(before)
    pipelineResolve!()
    await p
    expect(inflightCount()).toBe(before)
  })
})
