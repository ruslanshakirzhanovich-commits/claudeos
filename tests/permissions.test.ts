import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perms-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js')
  return { ...actual, DB_PATH: dbFile, STORE_DIR: tmpRoot }
})

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb } = await import('../src/db.js')
const { addUserChat } = await import('../src/users.js')
const config = await import('../src/config.js')

initDatabase()

beforeEach(() => {
  getDb().exec('DELETE FROM user_chats; DELETE FROM users;')
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('Telegram isAdmin', () => {
  it('returns false in open mode and for non-members', () => {
    expect(config.isAdmin('999')).toBe(false)
    addUserChat({ chatId: '111', channel: 'telegram', isAdmin: false })
    expect(config.isAdmin('999')).toBe(false)
  })

  it('returns true for admin members', () => {
    addUserChat({ chatId: '111', channel: 'telegram', isAdmin: true })
    expect(config.isAdmin('111')).toBe(true)
  })

  it('does not do substring matching', () => {
    addUserChat({ chatId: '12345', channel: 'telegram', isAdmin: true })
    expect(config.isAdmin('234')).toBe(false)
    expect(config.isAdmin('123')).toBe(false)
  })

  it('handles negative (group) ids', () => {
    addUserChat({ chatId: '-1234567', channel: 'telegram', isAdmin: true })
    expect(config.isAdmin('-1234567')).toBe(true)
  })
})

describe('Discord isDiscordUserAdmin', () => {
  it('false for non-member', () => {
    addUserChat({ chatId: 'discord:aaa', channel: 'discord', isAdmin: false })
    expect(config.isDiscordUserAdmin('zzz')).toBe(false)
  })

  it('true for admin member', () => {
    addUserChat({ chatId: 'discord:aaa', channel: 'discord', isAdmin: true })
    expect(config.isDiscordUserAdmin('aaa')).toBe(true)
  })
})

describe('WhatsApp isWhatsAppNumberAdmin', () => {
  it('false for non-member', () => {
    addUserChat({ chatId: '15551234567@s.whatsapp.net', channel: 'whatsapp', isAdmin: false })
    expect(config.isWhatsAppNumberAdmin('15559999999')).toBe(false)
  })

  it('true for admin member (bare number)', () => {
    addUserChat({ chatId: '15551234567@s.whatsapp.net', channel: 'whatsapp', isAdmin: true })
    expect(config.isWhatsAppNumberAdmin('15551234567')).toBe(true)
  })
})

describe('Discord isDiscordUserAuthorised', () => {
  it('open mode allows everyone', () => {
    expect(config.isDiscordUserAuthorised('any')).toBe(true)
  })

  it('strict mode rejects non-members', () => {
    addUserChat({ chatId: 'discord:aaa', channel: 'discord' })
    expect(config.isDiscordUserAuthorised('aaa')).toBe(true)
    expect(config.isDiscordUserAuthorised('zzz')).toBe(false)
  })
})

describe('WhatsApp isWhatsAppAuthorised', () => {
  it('open mode allows everyone', () => {
    expect(config.isWhatsAppAuthorised('15551234567')).toBe(true)
  })

  it('strict mode rejects non-members', () => {
    addUserChat({ chatId: '15551234567@s.whatsapp.net', channel: 'whatsapp' })
    expect(config.isWhatsAppAuthorised('15551234567')).toBe(true)
    expect(config.isWhatsAppAuthorised('15559999999')).toBe(false)
  })
})
