import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetCrashDedupForTest } from '../src/crash-dedup.js'

const sendSpy = vi.fn(async () => {})

vi.mock('../src/bot.js', () => ({
  sendToChat: (chatId: string, text: string) => sendSpy(chatId, text),
}))

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js')
  return { ...actual, ADMIN_CHAT_IDS: ['admin-1', 'admin-2'] }
})

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { notifyAdminsOnInitFailure } = await import('../src/init-notify.js')

beforeEach(() => {
  sendSpy.mockClear()
  resetCrashDedupForTest()
})

describe('notifyAdminsOnInitFailure', () => {
  it('sends a Telegram message to every admin on first failure', async () => {
    await notifyAdminsOnInitFailure('Discord', new Error('login dropped'))
    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(sendSpy.mock.calls[0]?.[0]).toBe('admin-1')
    expect(sendSpy.mock.calls[1]?.[0]).toBe('admin-2')
    expect(sendSpy.mock.calls[0]?.[1]).toContain('Discord init failed')
    expect(sendSpy.mock.calls[0]?.[1]).toContain('login dropped')
  })

  it('does not send a second time for the same channel + identical error within the dedup window', async () => {
    const e = new Error('same problem')
    await notifyAdminsOnInitFailure('WhatsApp', e)
    sendSpy.mockClear()
    await notifyAdminsOnInitFailure('WhatsApp', e)
    expect(sendSpy).toHaveBeenCalledTimes(0)
  })

  it('different channels with the same stack are not deduped together', async () => {
    const e = new Error('same problem')
    await notifyAdminsOnInitFailure('WhatsApp', e)
    sendSpy.mockClear()
    await notifyAdminsOnInitFailure('Discord', e)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })
})
