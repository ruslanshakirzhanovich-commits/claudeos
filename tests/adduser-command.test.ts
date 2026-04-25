import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-adduser-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js')
  return { ...actual, DB_PATH: dbFile, STORE_DIR: tmpRoot }
})
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb } = await import('../src/db.js')
const { addUserChat, getUserByChat } = await import('../src/users.js')
const { parseAddUserArgs } = await import('../src/commands/users.js')

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

describe('parseAddUserArgs', () => {
  it('parses a Telegram numeric chat id', () => {
    expect(parseAddUserArgs(['12345'])).toEqual({
      chatId: '12345',
      channel: 'telegram',
      isAdmin: false,
      existingUserId: undefined,
      note: null,
    })
  })

  it('parses a Discord chat id with --admin', () => {
    expect(parseAddUserArgs(['discord:abc', '--admin'])).toEqual({
      chatId: 'discord:abc',
      channel: 'discord',
      isAdmin: true,
      existingUserId: undefined,
      note: null,
    })
  })

  it('parses a WhatsApp jid with --user-id', () => {
    expect(parseAddUserArgs(['15551234567@s.whatsapp.net', '--user-id', 'u_abcd1234'])).toEqual({
      chatId: '15551234567@s.whatsapp.net',
      channel: 'whatsapp',
      isAdmin: false,
      existingUserId: 'u_abcd1234',
      note: null,
    })
  })

  it('parses a note', () => {
    expect(parseAddUserArgs(['12345', '--note', 'my', 'phone'])?.note).toBe('my phone')
  })

  it('returns null on unknown format', () => {
    expect(parseAddUserArgs(['notvalid'])).toBeNull()
  })

  it('returns null on missing args', () => {
    expect(parseAddUserArgs([])).toBeNull()
  })

  it('returns null on unknown flag', () => {
    expect(parseAddUserArgs(['12345', '--bogus'])).toBeNull()
  })
})

describe('/adduser end-to-end via parseAddUserArgs + addUserChat', () => {
  it('creates a Discord user via the command flow', () => {
    const args = parseAddUserArgs(['discord:dx1', '--admin'])
    expect(args).not.toBeNull()
    addUserChat({
      chatId: args!.chatId,
      channel: args!.channel,
      isAdmin: args!.isAdmin,
      existingUserId: args!.existingUserId,
      note: args!.note ?? undefined,
      addedBy: 'admin',
    })
    expect(getUserByChat('discord:dx1')?.isAdmin).toBe(true)
  })

  it('links a second chat to an existing user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    const args = parseAddUserArgs(['discord:dx2', '--user-id', a.userId])
    expect(args).not.toBeNull()
    const r = addUserChat({
      chatId: args!.chatId,
      channel: args!.channel,
      existingUserId: args!.existingUserId,
      addedBy: 'admin',
    })
    expect(r.userId).toBe(a.userId)
    expect(r.created).toBe(false)
  })
})
