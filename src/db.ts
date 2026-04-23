import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_PATH, STORE_DIR } from './config.js'
import { runMigrations, getCurrentSchemaVersion } from './migrations.js'

const BetterSqlite3 = (Database as any).default ?? Database

let _db: InstanceType<typeof Database> | null = null

export function getDb(): InstanceType<typeof Database> {
  if (_db) return _db
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true })
  _db = new BetterSqlite3(DB_PATH)
  _db!.pragma('journal_mode = WAL')
  _db!.pragma('foreign_keys = ON')
  return _db!
}

export function initDatabase(): void {
  const db = getDb()
  runMigrations(db)
}

export function getSchemaVersion(): number {
  return getCurrentSchemaVersion(getDb())
}

export interface AllowedChatRow {
  chat_id: string
  added_at: number
  added_by: string | null
  note: string | null
  last_seen_at: number | null
}

export function touchAllowedChat(chatId: string): void {
  getDb()
    .prepare('UPDATE allowed_chats SET last_seen_at = ? WHERE chat_id = ?')
    .run(Date.now(), chatId)
}

export function listAllowedChats(): AllowedChatRow[] {
  return getDb()
    .prepare('SELECT * FROM allowed_chats ORDER BY added_at ASC')
    .all() as AllowedChatRow[]
}

export function isChatAllowed(chatId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM allowed_chats WHERE chat_id = ?')
    .get(chatId) as { ok: number } | undefined
  return Boolean(row)
}

export function countAllowedChats(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM allowed_chats').get() as { c: number }
  return row.c
}

export function addAllowedChat(chatId: string, addedBy: string | null, note: string | null): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO allowed_chats (chat_id, added_at, added_by, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO NOTHING`,
    )
    .run(chatId, Date.now(), addedBy, note)
  return info.changes > 0
}

export function removeAllowedChat(chatId: string): boolean {
  const info = getDb().prepare('DELETE FROM allowed_chats WHERE chat_id = ?').run(chatId)
  return info.changes > 0
}

export function seedAllowedChatsFromEnv(chatIds: readonly string[]): number {
  if (countAllowedChats() > 0) return 0
  let seeded = 0
  for (const id of chatIds) {
    if (addAllowedChat(id, 'env', 'seeded from ALLOWED_CHAT_IDS')) seeded++
  }
  return seeded
}

export function isAuthorised(chatId: number | string): boolean {
  if (countAllowedChats() === 0) return true
  return isChatAllowed(String(chatId))
}

export function isOpenMode(): boolean {
  return countAllowedChats() === 0
}

export function backupDatabase(destPath: string): void {
  getDb().exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
}

export interface BackupVerification {
  schemaVersion: number
  sessions: number
  memories: number
  allowedChats: number
}

export function verifyBackup(backupPath: string): BackupVerification {
  const handle = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true }) as InstanceType<typeof Database>
  try {
    const integrityRows = handle.pragma('integrity_check') as Array<{ integrity_check: string }>
    const integrity = integrityRows.map((r) => r.integrity_check).join('; ')
    if (integrity !== 'ok') {
      throw new Error(`integrity_check failed: ${integrity.slice(0, 500)}`)
    }

    const fkRows = handle.pragma('foreign_key_check') as Array<Record<string, unknown>>
    if (fkRows.length > 0) {
      throw new Error(`foreign_key_check found ${fkRows.length} violations`)
    }

    const schemaVersion = handle.pragma('user_version', { simple: true }) as number
    const sessions = (handle.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c
    const memories = (handle.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
    const allowedChats = (handle.prepare('SELECT COUNT(*) AS c FROM allowed_chats').get() as { c: number }).c
    return { schemaVersion, sessions, memories, allowedChats }
  } finally {
    handle.close()
  }
}

export interface BotStats {
  allowedChats: number
  totalMemories: number
  memoriesLast24h: number
  uniqueChatsWithMemories: number
  activeTasks: number
  pausedTasks: number
}

export function getBotStats(): BotStats {
  const db = getDb()
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM allowed_chats)                                AS allowed,
         (SELECT COUNT(*) FROM memories)                                     AS mem_total,
         (SELECT COUNT(*) FROM memories WHERE created_at > ?)                AS mem_recent,
         (SELECT COUNT(DISTINCT chat_id) FROM memories)                      AS unique_chats,
         (SELECT COUNT(*) FROM scheduled_tasks WHERE status = 'active')      AS tasks_active,
         (SELECT COUNT(*) FROM scheduled_tasks WHERE status = 'paused')      AS tasks_paused`,
    )
    .get(cutoff24h) as {
      allowed: number
      mem_total: number
      mem_recent: number
      unique_chats: number
      tasks_active: number
      tasks_paused: number
    }
  return {
    allowedChats: row.allowed,
    totalMemories: row.mem_total,
    memoriesLast24h: row.mem_recent,
    uniqueChatsWithMemories: row.unique_chats,
    activeTasks: row.tasks_active,
    pausedTasks: row.tasks_paused,
  }
}

export function getTtsEnabled(chatId: string): boolean {
  const row = getDb()
    .prepare('SELECT tts_enabled FROM chat_preferences WHERE chat_id = ?')
    .get(chatId) as { tts_enabled: number } | undefined
  return row?.tts_enabled === 1
}

export function setTtsEnabled(chatId: string, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO chat_preferences (chat_id, tts_enabled) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET tts_enabled = excluded.tts_enabled`,
    )
    .run(chatId, enabled ? 1 : 0)
}

export function getPreferredModel(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT preferred_model FROM chat_preferences WHERE chat_id = ?')
    .get(chatId) as { preferred_model: string | null } | undefined
  return row?.preferred_model ?? null
}

export function setPreferredModel(chatId: string, modelId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO chat_preferences (chat_id, preferred_model) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET preferred_model = excluded.preferred_model`,
    )
    .run(chatId, modelId)
}

export function getEffortLevel(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT effort_level FROM chat_preferences WHERE chat_id = ?')
    .get(chatId) as { effort_level: string | null } | undefined
  return row?.effort_level ?? null
}

export function setEffortLevel(chatId: string, level: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO chat_preferences (chat_id, effort_level) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET effort_level = excluded.effort_level`,
    )
    .run(chatId, level)
}

export interface SessionRow {
  chat_id: string
  session_id: string
  updated_at: number
}

export function getSession(chatId: string): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined
  return row?.session_id ?? null
}

export function getSessionMeta(chatId: string): { sessionId: string; updatedAt: number } | null {
  const row = getDb()
    .prepare('SELECT session_id, updated_at FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; updated_at: number } | undefined
  if (!row) return null
  return { sessionId: row.session_id, updatedAt: row.updated_at }
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(chatId, sessionId, Date.now())
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

export interface MemoryRow {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
}

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey: string | null = null,
): number {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
       VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
    )
    .run(chatId, topicKey, content, sector, now, now)
  return Number(info.lastInsertRowid)
}

export interface MemoryInput {
  chatId: string
  content: string
  sector: 'semantic' | 'episodic'
  topicKey?: string | null
}

export function insertMemories(rows: MemoryInput[]): void {
  if (rows.length === 0) return
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
     VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
  )
  const tx = db.transaction((items: MemoryInput[]) => {
    const now = Date.now()
    for (const r of items) {
      stmt.run(r.chatId, r.topicKey ?? null, r.content, r.sector, now, now)
    }
  })
  tx(rows)
}

export function searchMemoriesFts(chatId: string, query: string, limit = 3): MemoryRow[] {
  if (!query) return []
  try {
    return getDb()
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts f ON f.rowid = m.id
         WHERE memories_fts MATCH ? AND m.chat_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(query, chatId, limit) as MemoryRow[]
  } catch {
    return []
  }
}

export function getRecentMemories(chatId: string, limit = 5): MemoryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ?
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as MemoryRow[]
}

export function touchMemory(id: number): void {
  getDb()
    .prepare(
      `UPDATE memories
       SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0)
       WHERE id = ?`,
    )
    .run(Date.now(), id)
}

export function touchMemories(ids: number[]): void {
  if (ids.length === 0) return
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE memories
     SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0)
     WHERE id = ?`,
  )
  const tx = db.transaction((rowIds: number[]) => {
    const now = Date.now()
    for (const id of rowIds) stmt.run(now, id)
  })
  tx(ids)
}

export function decayMemories(): { decayed: number; deleted: number } {
  const db = getDb()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const updateStmt = db.prepare('UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?')
  const deleteStmt = db.prepare('DELETE FROM memories WHERE salience < 0.1')
  const tx = db.transaction(() => {
    const decayInfo = updateStmt.run(cutoff)
    const delInfo = deleteStmt.run()
    return { decayed: Number(decayInfo.changes), deleted: Number(delInfo.changes) }
  })
  return tx()
}

export function optimizeFts(): void {
  const db = getDb()
  db.exec(`INSERT INTO memories_fts(memories_fts, rank) VALUES('merge', -16)`)
}

export function countMemories(chatId?: string): number {
  const row = chatId
    ? (getDb()
        .prepare('SELECT COUNT(*) AS c FROM memories WHERE chat_id = ?')
        .get(chatId) as { c: number })
    : (getDb().prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number })
  return row.c
}

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'created_at'>): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
       (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(task.id, task.chat_id, task.prompt, task.schedule, task.next_run, task.status, Date.now())
}

export function listTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY next_run ASC')
    .all() as ScheduledTask[]
}

export function getTask(id: string): ScheduledTask | null {
  return (
    (getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get(id) as ScheduledTask | undefined) ?? null
  )
}

export function getDueTasks(): ScheduledTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?
       ORDER BY next_run ASC`,
    )
    .all(Date.now()) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?, next_run = ?
       WHERE id = ?`,
    )
    .run(Date.now(), result.slice(0, 500), nextRun, id)
}

export function setTaskStatus(id: string, status: 'active' | 'paused'): void {
  getDb().prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(status, id)
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}
