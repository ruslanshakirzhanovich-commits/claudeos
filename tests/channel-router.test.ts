import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/bot.js', () => ({
  sendToChat: async () => {},
  TELEGRAM_BOT_TOKEN: 'stub',
}))
vi.mock('../src/discord/index.js', () => ({
  sendToDiscordUser: async () => {},
}))
vi.mock('../src/whatsapp/index.js', () => ({
  sendToWhatsAppJid: async () => {},
}))

const { classifyChatId, createChannelRouter } = await import('../src/channel-router.js')

describe('classifyChatId', () => {
  it('recognises Telegram numeric ids (positive, negative supergroups)', () => {
    expect(classifyChatId('110440505')).toBe('telegram')
    expect(classifyChatId('-1001234567890')).toBe('telegram')
  })

  it('recognises the discord: prefix', () => {
    expect(classifyChatId('discord:987654321')).toBe('discord')
  })

  it('recognises WhatsApp jid format via the @ separator', () => {
    expect(classifyChatId('491234567@s.whatsapp.net')).toBe('whatsapp')
    expect(classifyChatId('15551234567@g.us')).toBe('whatsapp')
  })

  it('returns unknown for empty / malformed strings', () => {
    expect(classifyChatId('')).toBe('unknown')
    expect(classifyChatId('not-a-chat')).toBe('unknown')
    expect(classifyChatId('12.34')).toBe('unknown')
  })
})

describe('createChannelRouter', () => {
  function makeFakes() {
    return {
      telegram: vi.fn(async () => {}),
      discord: vi.fn(async () => {}),
      whatsapp: vi.fn(async () => {}),
    }
  }

  it('dispatches a Telegram chat_id to the telegram sender', async () => {
    const s = makeFakes()
    const route = createChannelRouter(s)
    await route('110440505', 'hi')
    expect(s.telegram).toHaveBeenCalledWith('110440505', 'hi')
    expect(s.discord).not.toHaveBeenCalled()
    expect(s.whatsapp).not.toHaveBeenCalled()
  })

  it('strips the discord: prefix before calling the discord sender', async () => {
    const s = makeFakes()
    const route = createChannelRouter(s)
    await route('discord:987654321', 'ping')
    expect(s.discord).toHaveBeenCalledWith('987654321', 'ping')
    expect(s.telegram).not.toHaveBeenCalled()
    expect(s.whatsapp).not.toHaveBeenCalled()
  })

  it('passes the full jid through to the whatsapp sender', async () => {
    const s = makeFakes()
    const route = createChannelRouter(s)
    const jid = '491234567@s.whatsapp.net'
    await route(jid, 'hallo')
    expect(s.whatsapp).toHaveBeenCalledWith(jid, 'hallo')
  })

  it('throws on an empty discord: payload — scheduler surfaces this to the log', async () => {
    const s = makeFakes()
    const route = createChannelRouter(s)
    await expect(route('discord:', 'oops')).rejects.toThrow(/malformed discord chat_id/)
    expect(s.discord).not.toHaveBeenCalled()
  })

  it('throws "unroutable" for a completely unrecognised chat_id', async () => {
    const s = makeFakes()
    const route = createChannelRouter(s)
    await expect(route('nope', 'x')).rejects.toThrow(/unroutable chat_id/)
    expect(s.telegram).not.toHaveBeenCalled()
    expect(s.discord).not.toHaveBeenCalled()
    expect(s.whatsapp).not.toHaveBeenCalled()
  })

  it('propagates sender errors unchanged — scheduler uses them as task-failure reason', async () => {
    const boom = new Error('discord offline')
    const s = {
      telegram: vi.fn(),
      discord: vi.fn(async () => {
        throw boom
      }),
      whatsapp: vi.fn(),
    }
    const route = createChannelRouter(s)
    await expect(route('discord:1', 'hello')).rejects.toBe(boom)
  })
})
