import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chatid-test-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, addAllowedChat, isValidTelegramChatId, isChatAllowed } =
  await import('../src/db.js')

initDatabase()

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('isValidTelegramChatId', () => {
  it('accepts plain integer chat ids and negative supergroups', () => {
    expect(isValidTelegramChatId('123456')).toBe(true)
    expect(isValidTelegramChatId('-1001234567890')).toBe(true)
  })

  it('rejects WhatsApp jids and other non-numeric strings', () => {
    expect(isValidTelegramChatId('15551234567@s.whatsapp.net')).toBe(false)
    expect(isValidTelegramChatId('15551234567@g.us')).toBe(false)
    expect(isValidTelegramChatId('abc')).toBe(false)
    expect(isValidTelegramChatId('')).toBe(false)
    expect(isValidTelegramChatId('123 456')).toBe(false)
    expect(isValidTelegramChatId('12.34')).toBe(false)
  })
})

describe('addAllowedChat input validation', () => {
  it('throws when given a WhatsApp jid', () => {
    expect(() => addAllowedChat('15551234567@s.whatsapp.net', 'admin', null)).toThrow(
      /not a Telegram chat id/,
    )
    expect(isChatAllowed('15551234567@s.whatsapp.net')).toBe(false)
  })

  it('accepts a valid Telegram chat id and returns true on first insert', () => {
    expect(addAllowedChat('999111', 'admin', 'note')).toBe(true)
    expect(isChatAllowed('999111')).toBe(true)
  })
})

// seedAllowedChatsFromEnv was removed in v8 — env seeds run inside the
// migration now. The Telegram-only invariant for runtime addAllowedChat is
// covered by the test above.
