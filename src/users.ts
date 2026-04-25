import crypto from 'node:crypto'
import { getDb } from './db.js'
import { classifyChatId, type ChannelKind } from './channel.js'
import { logger } from './logger.js'

export interface UserLookup {
  userId: string
  isAdmin: boolean
  channel: ChannelKind
}

export interface AddUserChatOpts {
  chatId: string
  channel: ChannelKind
  existingUserId?: string
  isAdmin?: boolean
  addedBy?: string
  note?: string
  displayName?: string
}

export interface AddUserChatResult {
  userId: string
  created: boolean
}

export interface RemoveUserChatResult {
  removed: boolean
  userDeleted: boolean
  memoriesDeleted: number
  tasksDeleted: number
  sessionCleared: boolean
  preferencesCleared: boolean
}

export function generateUserId(): string {
  return 'u_' + crypto.randomBytes(4).toString('hex')
}

export function countUsers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  return row.c
}

export function isOpenMode(): boolean {
  return countUsers() === 0
}

export function getUserByChat(chatId: string): UserLookup | null {
  const row = getDb()
    .prepare(
      `SELECT u.user_id AS userId, u.is_admin AS isAdmin, c.channel AS channel
       FROM user_chats c JOIN users u ON u.user_id = c.user_id
       WHERE c.chat_id = ?`,
    )
    .get(chatId) as { userId: string; isAdmin: number; channel: ChannelKind } | undefined
  if (!row) return null
  return { userId: row.userId, isAdmin: row.isAdmin === 1, channel: row.channel }
}

export function isAuthorisedChat(chatId: string): boolean {
  if (isOpenMode()) return true
  return getUserByChat(chatId) !== null
}

export function isAdminChat(chatId: string): boolean {
  return getUserByChat(chatId)?.isAdmin === true
}

export function addUserChat(opts: AddUserChatOpts): AddUserChatResult {
  const detected = classifyChatId(opts.chatId)
  if (detected !== opts.channel) {
    throw new Error(
      `addUserChat: channel mismatch — chat_id ${opts.chatId.slice(0, 80)} parsed as ${detected}, declared as ${opts.channel}`,
    )
  }

  const db = getDb()
  const now = Date.now()

  const tx = db.transaction((): AddUserChatResult => {
    let userId = opts.existingUserId
    let created = false
    if (!userId) {
      const existingCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      const shouldAutoAdmin = existingCount === 0 && opts.isAdmin !== false
      const isAdmin = opts.isAdmin ?? shouldAutoAdmin
      userId = generateUserId()
      db.prepare(
        `INSERT INTO users (user_id, display_name, is_admin, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(userId, opts.displayName ?? opts.chatId, isAdmin ? 1 : 0, now)
      created = true
      if (shouldAutoAdmin) {
        logger.warn({ userId }, 'bootstrap admin: promoted first user')
      }
      logger.info(
        { userId, channel: opts.channel, chatId: opts.chatId, addedBy: opts.addedBy },
        'user created',
      )
    } else {
      if (typeof opts.isAdmin === 'boolean') {
        db.prepare('UPDATE users SET is_admin = ? WHERE user_id = ?').run(
          opts.isAdmin ? 1 : 0,
          userId,
        )
      }
    }

    db.prepare(
      `INSERT INTO user_chats (chat_id, user_id, channel, added_at, added_by, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(opts.chatId, userId, opts.channel, now, opts.addedBy ?? null, opts.note ?? null)

    return { userId, created }
  })

  return tx()
}

export function removeUserChat(chatId: string): RemoveUserChatResult {
  const db = getDb()

  const tx = db.transaction((): RemoveUserChatResult => {
    const before = db.prepare('SELECT user_id FROM user_chats WHERE chat_id = ?').get(chatId) as
      | { user_id: string }
      | undefined

    const chat = db.prepare('DELETE FROM user_chats WHERE chat_id = ?').run(chatId)
    const prefs = db.prepare('DELETE FROM chat_preferences WHERE chat_id = ?').run(chatId)
    const session = db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
    const memories = db.prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId)
    const tasks = db.prepare('DELETE FROM scheduled_tasks WHERE chat_id = ?').run(chatId)

    let userDeleted = false
    if (before) {
      const remaining = (
        db
          .prepare('SELECT COUNT(*) AS c FROM user_chats WHERE user_id = ?')
          .get(before.user_id) as { c: number }
      ).c
      if (remaining === 0) {
        db.prepare('DELETE FROM users WHERE user_id = ?').run(before.user_id)
        userDeleted = true
        logger.info({ userId: before.user_id }, 'user removed (last chat deleted)')
      }
    }

    return {
      removed: Number(chat.changes) > 0,
      userDeleted,
      memoriesDeleted: Number(memories.changes),
      tasksDeleted: Number(tasks.changes),
      sessionCleared: Number(session.changes) > 0,
      preferencesCleared: Number(prefs.changes) > 0,
    }
  })

  return tx()
}

export function touchUserChat(chatId: string): void {
  getDb()
    .prepare('UPDATE user_chats SET last_seen_at = ? WHERE chat_id = ?')
    .run(Date.now(), chatId)
}
