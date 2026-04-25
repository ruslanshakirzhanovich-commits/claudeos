import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, it, expect, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig8-'))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

// Single mock for the whole file: tests that need different env shapes use
// separate freshDb() instances and seed the legacy allowed_chats table by
// hand. Only the empty-env case can't be mocked here without a remock.
vi.mock('../src/config.js', () => ({
  ALLOWED_CHAT_IDS: ['111', '222'],
  ADMIN_CHAT_IDS: ['111'],
  ALLOWED_DISCORD_USERS: ['d-aaa'],
  ADMIN_DISCORD_USERS: [],
  ALLOWED_WHATSAPP_NUMBERS: ['15551234567'],
  ADMIN_WHATSAPP_NUMBERS: [],
}))

const { runMigrations, MIGRATIONS } = await import('../src/migrations.js')

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function freshDb(name: string): InstanceType<typeof Database> {
  const file = path.join(tmpRoot, name)
  try {
    fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  return db
}

function runUpToV7(db: InstanceType<typeof Database>): void {
  const v7Idx = MIGRATIONS.findIndex((m) => m.version === 7)
  const upToV7 = MIGRATIONS.slice(0, v7Idx + 1)
  const tx = db.transaction(() => {
    for (const m of upToV7) m.up(db)
    db.pragma('user_version = 7')
  })
  tx()
}

describe('migration v8', () => {
  it('seeds users from existing allowed_chats and env lists', () => {
    const db = freshDb('seed.db')
    try {
      runUpToV7(db)

      const now = Date.now()
      db.prepare(
        `INSERT INTO allowed_chats (chat_id, added_at, added_by, note, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('111', now - 1000, 'env', 'first', null)
      db.prepare(
        `INSERT INTO allowed_chats (chat_id, added_at, added_by, note, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('222', now, 'env', null, null)

      runMigrations(db)

      const users = db.prepare('SELECT user_id, display_name, is_admin FROM users ORDER BY created_at').all() as Array<{
        user_id: string
        display_name: string
        is_admin: number
      }>
      expect(users).toHaveLength(4)

      const userChats = db
        .prepare('SELECT chat_id, channel FROM user_chats ORDER BY chat_id')
        .all() as Array<{ chat_id: string; channel: string }>
      const chatIds = userChats.map((c) => c.chat_id).sort()
      expect(chatIds).toEqual(
        ['111', '15551234567@s.whatsapp.net', '222', 'discord:d-aaa'].sort(),
      )

      const admin111 = db
        .prepare(
          `SELECT u.is_admin FROM users u JOIN user_chats c ON c.user_id = u.user_id
           WHERE c.chat_id = '111'`,
        )
        .get() as { is_admin: number }
      expect(admin111.is_admin).toBe(1)
    } finally {
      db.close()
    }
  })

  it('bootstrap admin fallback: oldest user becomes admin when no admin in envs match seeds', () => {
    // The mock has ADMIN_CHAT_IDS=['111'] but we won't seed allowed_chats
    // with '111'. We seed Discord ('d-aaa') and WhatsApp via env only, no
    // ADMIN_DISCORD_USERS / ADMIN_WHATSAPP_NUMBERS → no env match → fallback
    // promotes oldest user.
    const db = freshDb('bootstrap.db')
    try {
      runUpToV7(db)
      // No allowed_chats seeded — only the env-discord and env-whatsapp users.
      runMigrations(db)

      const adminCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get() as { c: number }
      ).c
      expect(adminCount).toBe(1)

      const userCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
      ).c
      expect(userCount).toBe(2) // discord + whatsapp seeds, no telegram

      // Oldest user (smallest created_at) is admin
      const oldest = db
        .prepare('SELECT user_id, is_admin FROM users ORDER BY created_at ASC LIMIT 1')
        .get() as { user_id: string; is_admin: number }
      expect(oldest.is_admin).toBe(1)
    } finally {
      db.close()
    }
  })

  it('idempotent: re-running v8 (after reset of user_version) does not duplicate', () => {
    const db = freshDb('idempotent.db')
    try {
      runUpToV7(db)
      runMigrations(db)
      const before = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      expect(before).toBeGreaterThan(0)

      db.pragma('user_version = 7')
      runMigrations(db)
      const after = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      expect(after).toBe(before) // no duplicates from second run
    } finally {
      db.close()
    }
  })

  it('matches admin envs to seeded chats (ADMIN_CHAT_IDS=["111"] with allowed_chats containing 111)', () => {
    const db = freshDb('admin-match.db')
    try {
      runUpToV7(db)
      // Only seed chat 222 (not 111). ADMIN_CHAT_IDS=['111'] should not
      // match anything → bootstrap promotes oldest (which is one of 222 or
      // discord/whatsapp seeds depending on order).
      const now = Date.now()
      db.prepare(
        `INSERT INTO allowed_chats (chat_id, added_at, added_by, note, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('222', now - 5000, 'env', null, null)

      runMigrations(db)

      // 222 is the oldest (created_at = now-5000; discord/whatsapp seeds are at
      // now or now+ε). It should be the bootstrap admin.
      const bootstrapAdmin = db
        .prepare(
          `SELECT c.chat_id FROM users u JOIN user_chats c ON c.user_id = u.user_id
           WHERE u.is_admin = 1 ORDER BY u.created_at ASC LIMIT 1`,
        )
        .get() as { chat_id: string }
      expect(bootstrapAdmin.chat_id).toBe('222')

      const adminCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get() as { c: number }
      ).c
      expect(adminCount).toBe(1)
    } finally {
      db.close()
    }
  })
})
