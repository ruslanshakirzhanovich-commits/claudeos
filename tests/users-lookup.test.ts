import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-users-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpRoot,
}))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb } = await import('../src/db.js')
const {
  generateUserId,
  getUserByChat,
  countUsers,
  isOpenMode,
  isAuthorisedChat,
  isAdminChat,
  addUserChat,
  removeUserChat,
  touchUserChat,
} = await import('../src/users.js')

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

describe('users.ts', () => {
  it('generateUserId returns u_ + 8 hex', () => {
    const id = generateUserId()
    expect(id).toMatch(/^u_[0-9a-f]{8}$/)
  })

  it('isOpenMode true when users empty, false after addUserChat', () => {
    expect(isOpenMode()).toBe(true)
    expect(countUsers()).toBe(0)
    addUserChat({ chatId: '12345', channel: 'telegram' })
    expect(isOpenMode()).toBe(false)
    expect(countUsers()).toBe(1)
  })

  it('addUserChat creates a new user when no existingUserId given', () => {
    const r = addUserChat({ chatId: '12345', channel: 'telegram' })
    expect(r.created).toBe(true)
    const lookup = getUserByChat('12345')
    expect(lookup?.userId).toBe(r.userId)
    expect(lookup?.channel).toBe('telegram')
    expect(lookup?.isAdmin).toBe(true)
  })

  it('addUserChat with existingUserId links to existing user, no new user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    const b = addUserChat({
      chatId: 'discord:222',
      channel: 'discord',
      existingUserId: a.userId,
    })
    expect(b.created).toBe(false)
    expect(b.userId).toBe(a.userId)
    expect(getUserByChat('discord:222')?.userId).toBe(a.userId)
  })

  it('addUserChat second user is not admin by default (only first auto-promotes)', () => {
    addUserChat({ chatId: '11111', channel: 'telegram' })
    const b = addUserChat({ chatId: '22222', channel: 'telegram' })
    expect(getUserByChat('22222')?.isAdmin).toBe(false)
    expect(getUserByChat('11111')?.isAdmin).toBe(true)
    void b
  })

  it('addUserChat respects explicit isAdmin: false on the very first user', () => {
    addUserChat({ chatId: '11111', channel: 'telegram', isAdmin: false })
    expect(getUserByChat('11111')?.isAdmin).toBe(false)
  })

  it('isAuthorisedChat: true in open mode (any chat); membership-based otherwise', () => {
    expect(isAuthorisedChat('any')).toBe(true)
    addUserChat({ chatId: '11111', channel: 'telegram' })
    expect(isAuthorisedChat('11111')).toBe(true)
    expect(isAuthorisedChat('99999')).toBe(false)
  })

  it('isAdminChat reflects users.is_admin via the chat lookup', () => {
    addUserChat({ chatId: '11111', channel: 'telegram' })
    expect(isAdminChat('11111')).toBe(true)
    addUserChat({ chatId: '22222', channel: 'telegram' })
    expect(isAdminChat('22222')).toBe(false)
  })

  it('removeUserChat with last chat deletes the user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    const r = removeUserChat('11111')
    expect(r.removed).toBe(true)
    expect(r.userDeleted).toBe(true)
    expect(getUserByChat('11111')).toBeNull()
    const row = getDb().prepare('SELECT 1 FROM users WHERE user_id = ?').get(a.userId)
    expect(row).toBeUndefined()
  })

  it('removeUserChat with multiple chats keeps the user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    addUserChat({ chatId: 'discord:222', channel: 'discord', existingUserId: a.userId })
    const r = removeUserChat('11111')
    expect(r.removed).toBe(true)
    expect(r.userDeleted).toBe(false)
    expect(getUserByChat('discord:222')?.userId).toBe(a.userId)
  })

  it('touchUserChat updates last_seen_at', () => {
    addUserChat({ chatId: '11111', channel: 'telegram' })
    const before = getDb()
      .prepare('SELECT last_seen_at FROM user_chats WHERE chat_id = ?')
      .get('11111') as { last_seen_at: number | null }
    expect(before.last_seen_at).toBeNull()
    touchUserChat('11111')
    const after = getDb()
      .prepare('SELECT last_seen_at FROM user_chats WHERE chat_id = ?')
      .get('11111') as { last_seen_at: number }
    expect(after.last_seen_at).toBeGreaterThan(0)
  })

  it('addUserChat rejects mismatched channel/format', () => {
    expect(() => addUserChat({ chatId: '12345', channel: 'discord' })).toThrow(
      /channel.*mismatch|format/i,
    )
  })
})
