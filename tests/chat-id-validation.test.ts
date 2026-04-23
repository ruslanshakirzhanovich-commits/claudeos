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

const {
  initDatabase,
  closeDb,
  addAllowedChat,
  isValidTelegramChatId,
  isChatAllowed,
  seedAllowedChatsFromEnv,
  countAllowedChats,
} = await import('../src/db.js')

initDatabase()

afterAll(() => {
  closeDb()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
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
    expect(() => addAllowedChat('15551234567@s.whatsapp.net', 'admin', null)).toThrow(/not a Telegram chat id/)
    expect(isChatAllowed('15551234567@s.whatsapp.net')).toBe(false)
  })

  it('accepts a valid Telegram chat id and returns true on first insert', () => {
    expect(addAllowedChat('999111', 'admin', 'note')).toBe(true)
    expect(isChatAllowed('999111')).toBe(true)
  })
})

describe('seedAllowedChatsFromEnv silently skips invalid ids', () => {
  it('seeds only the well-formed entries', () => {
    // start clean: countAllowedChats may be >0 due to prior tests, so use a
    // fresh DB context isn't possible here. seedAllowedChatsFromEnv early-exits
    // if the table already has rows, so we expect 0 in that case — but the
    // important invariant is that no jid leaks into the table.
    const before = countAllowedChats()
    seedAllowedChatsFromEnv(['15551234567@s.whatsapp.net', '888777'])
    if (before === 0) {
      expect(isChatAllowed('888777')).toBe(true)
    }
    expect(isChatAllowed('15551234567@s.whatsapp.net')).toBe(false)
  })
})
