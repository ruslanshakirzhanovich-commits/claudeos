import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_PATH, STORE_DIR } from './config.js'
import { runMigrations, getCurrentSchemaVersion, type MigrationSeeds } from './migrations.js'
import * as users from './users.js'

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

export function initDatabase(seeds: MigrationSeeds = {}): void {
  const db = getDb()
  runMigrations(db, seeds)
}

/**
 * Close the database handle and clear the singleton. Intended for tests
 * that create a throwaway DB and need a clean slate between suites — or
 * for a graceful shutdown path that wants SQLite to flush WAL cleanly
 * before process exit. Safe to call multiple times.
 */
export function closeDb(): void {
  if (!_db) return
  try {
    _db.close()
  } catch {
    /* already closed */
  }
  _db = null
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
  users.touchUserChat(chatId)
}

export function listAllowedChats(): AllowedChatRow[] {
  return getDb()
    .prepare(
      `SELECT chat_id, added_at, added_by, note, last_seen_at
       FROM user_chats
       ORDER BY added_at ASC`,
    )
    .all() as AllowedChatRow[]
}

export function isChatAllowed(chatId: string): boolean {
  return users.getUserByChat(chatId) !== null
}

export function countAllowedChats(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM user_chats').get() as { c: number }
  return row.c
}

// Telegram chat ids are signed 64-bit integers. WhatsApp jids look like
// "15551234567@s.whatsapp.net" — reject those at the DB boundary so a future
// caller (new admin command, import script, REST endpoint) cannot accidentally
// poison `allowed_chats` with a non-Telegram identifier.
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/

export function isValidTelegramChatId(chatId: string): boolean {
  return TELEGRAM_CHAT_ID_RE.test(chatId)
}

export function addAllowedChat(
  chatId: string,
  addedBy: string | null,
  note: string | null,
): boolean {
  if (!isValidTelegramChatId(chatId)) {
    throw new Error(`addAllowedChat: not a Telegram chat id: ${chatId.slice(0, 80)}`)
  }
  if (isChatAllowed(chatId)) return false
  users.addUserChat({
    chatId,
    channel: 'telegram',
    addedBy: addedBy ?? undefined,
    note: note ?? undefined,
  })
  return true
}

export interface RemoveChatResult {
  removed: boolean
  memoriesDeleted: number
  tasksDeleted: number
  sessionCleared: boolean
  preferencesCleared: boolean
}

export function removeAllowedChat(chatId: string): RemoveChatResult {
  const r = users.removeUserChat(chatId)
  return {
    removed: r.removed,
    memoriesDeleted: r.memoriesDeleted,
    tasksDeleted: r.tasksDeleted,
    sessionCleared: r.sessionCleared,
    preferencesCleared: r.preferencesCleared,
  }
}

export function isAuthorised(chatId: number | string): boolean {
  return users.isAuthorisedChat(String(chatId))
}

export function isOpenMode(): boolean {
  return users.isOpenMode()
}

// SQLite's VACUUM INTO does not support parameter binding for the target
// path — it must be interpolated into the statement. That's safe as long as
// we tightly validate what's in `destPath` first. The allowed-directory
// prefix check blocks traversal, and the filename regex blocks quotes, shell
// metacharacters, and anything that could break out of the SQL literal.
const SAFE_BACKUP_FILENAME = /^[A-Za-z0-9._-]+\.db$/

export function assertSafeBackupPath(destPath: string, allowedDir: string): void {
  if (!path.isAbsolute(destPath)) {
    throw new Error(`backup destPath must be absolute: ${destPath}`)
  }
  const resolvedDest = path.resolve(destPath)
  const resolvedDir = path.resolve(allowedDir)
  const withSep = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep
  if (!resolvedDest.startsWith(withSep)) {
    throw new Error(`backup destPath outside allowed dir: ${destPath}`)
  }
  const name = path.basename(resolvedDest)
  if (!SAFE_BACKUP_FILENAME.test(name)) {
    throw new Error(`invalid backup filename: ${name}`)
  }
}

export function backupDatabase(destPath: string, allowedDir: string): void {
  assertSafeBackupPath(destPath, allowedDir)
  getDb().exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
}

export interface BackupVerification {
  schemaVersion: number
  sessions: number
  memories: number
  allowedChats: number
}

export function verifyBackup(backupPath: string): BackupVerification {
  const handle = new BetterSqlite3(backupPath, {
    readonly: true,
    fileMustExist: true,
  }) as InstanceType<typeof Database>
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
    // Prefer user_chats (v8+) over the legacy allowed_chats table.
    const hasUserChats = Boolean(
      handle.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_chats'`).get(),
    )
    const allowedChats = (
      handle
        .prepare(`SELECT COUNT(*) AS c FROM ${hasUserChats ? 'user_chats' : 'allowed_chats'}`)
        .get() as { c: number }
    ).c
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
         (SELECT COUNT(*) FROM user_chats)                                   AS allowed,
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
  const row = getDb().prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get(chatId) as
    | { session_id: string }
    | undefined
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
  // Decay is episodic-only. Semantic memories model long-lived identity
  // facts ("user prefers X", "user lives in Y") and must not evaporate
  // just because nobody queried them for a while.
  const updateStmt = db.prepare(
    `UPDATE memories SET salience = salience * 0.98
       WHERE sector = 'episodic' AND created_at < ?`,
  )
  const deleteStmt = db.prepare(`DELETE FROM memories WHERE sector = 'episodic' AND salience < 0.1`)
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

export interface StaleEpisodic {
  id: number
  content: string
  created_at: number
}

// Which chats have >= minCount episodic rows older than cutoffMs. Used by
// the summarize sweep to pick candidates without walking every chat.
export function listChatsWithStaleEpisodic(cutoffMs: number, minCount: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT chat_id, COUNT(*) AS c FROM memories
        WHERE sector = 'episodic' AND created_at < ?
        GROUP BY chat_id
       HAVING c >= ?`,
    )
    .all(cutoffMs, minCount) as Array<{ chat_id: string; c: number }>
  return rows.map((r) => r.chat_id)
}

// Oldest stale episodic rows for one chat, for folding into a summary.
// Ordered oldest-first so the summary reads chronologically.
export function getStaleEpisodicForChat(
  chatId: string,
  cutoffMs: number,
  limit: number,
): StaleEpisodic[] {
  return getDb()
    .prepare(
      `SELECT id, content, created_at FROM memories
        WHERE chat_id = ? AND sector = 'episodic' AND created_at < ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(chatId, cutoffMs, limit) as StaleEpisodic[]
}

// Atomic swap: insert the summary as a semantic row, then delete the
// episodic rows it replaces. Both in one transaction so a crash between
// them can't produce a summary without sources or sources without a
// summary. No-op if ids is empty or summary is blank.
export function replaceEpisodicWithSummary(
  chatId: string,
  episodicIds: number[],
  summaryContent: string,
): { inserted: number; deleted: number } {
  if (!episodicIds.length || !summaryContent.trim()) {
    return { inserted: 0, deleted: 0 }
  }
  const db = getDb()
  const insertStmt = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at)
     VALUES (?, ?, 'semantic', 1.0, ?, ?)`,
  )
  const placeholders = episodicIds.map(() => '?').join(',')
  const deleteStmt = db.prepare(
    `DELETE FROM memories WHERE sector = 'episodic' AND id IN (${placeholders})`,
  )
  const tx = db.transaction(() => {
    const now = Date.now()
    const insInfo = insertStmt.run(chatId, summaryContent, now, now)
    const delInfo = deleteStmt.run(...episodicIds)
    return { inserted: Number(insInfo.changes), deleted: Number(delInfo.changes) }
  })
  return tx()
}

export interface CapEpisodicOptions {
  // Spare rows whose salience is at or above this threshold. These are
  // usually curated identity facts that the user touches repeatedly.
  protectMinSalience?: number
  // Spare rows created at or after this epoch-ms cutoff. Stops newly-minted
  // memories from being evicted by an active chat that just happens to have
  // touched other rows more recently.
  protectCreatedAfterMs?: number
}

// Keep at most `cap` episodic memories per chat. Drops the oldest by
// accessed_at so the active conversation's context survives even after
// a long idle period. Semantic memories are never touched — they carry
// long-lived user profile facts that aren't supposed to age out.
// Returns how many rows were deleted across all chats. cap <= 0 is a
// no-op so the feature can be disabled via env.
export function capEpisodicMemories(
  cap: number,
  opts: CapEpisodicOptions = {},
): { deleted: number } {
  if (cap <= 0) return { deleted: 0 }
  const db = getDb()

  const selectOverflow = `
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY chat_id ORDER BY accessed_at DESC
             ) AS rn
        FROM memories
       WHERE sector = 'episodic'
    )
    WHERE rn > ?
  `
  let sql = `DELETE FROM memories WHERE id IN (${selectOverflow})`
  const params: Array<number> = [cap]
  if (opts.protectMinSalience !== undefined) {
    sql += ` AND salience < ?`
    params.push(opts.protectMinSalience)
  }
  if (opts.protectCreatedAfterMs !== undefined) {
    sql += ` AND created_at < ?`
    params.push(opts.protectCreatedAfterMs)
  }
  const info = db.prepare(sql).run(...params)
  return { deleted: Number(info.changes) }
}

export interface CapEpisodicBatchedOptions extends CapEpisodicOptions {
  // How many rows to delete per transaction before yielding to the event
  // loop. Keeps a 100k-row cleanup from freezing the bot for a whole second
  // under better-sqlite3's synchronous API. `undefined` or 0 means one-shot.
  batchSize?: number
}

// Async sibling of capEpisodicMemories that splits the DELETE into fixed-size
// passes and awaits setImmediate between each, so incoming Telegram/Discord
// messages can be handled mid-sweep instead of queueing behind a multi-second
// synchronous delete.
export async function capEpisodicMemoriesBatched(
  cap: number,
  opts: CapEpisodicBatchedOptions = {},
): Promise<{ deleted: number; batches: number }> {
  if (cap <= 0) return { deleted: 0, batches: 0 }
  const db = getDb()
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 0

  // The protection filters must live inside the IN-subquery so LIMIT selects
  // exactly the rows that will actually be deleted; otherwise LIMIT can pick
  // a protected row and the outer WHERE filters it out, leaving the cap
  // under-enforced per pass.
  let selectOverflow = `
    SELECT id FROM (
      SELECT id, salience, created_at,
             ROW_NUMBER() OVER (
               PARTITION BY chat_id ORDER BY accessed_at DESC
             ) AS rn
        FROM memories
       WHERE sector = 'episodic'
    )
    WHERE rn > ?
  `
  const baseParams: Array<number> = [cap]
  if (opts.protectMinSalience !== undefined) {
    selectOverflow += ` AND salience < ?`
    baseParams.push(opts.protectMinSalience)
  }
  if (opts.protectCreatedAfterMs !== undefined) {
    selectOverflow += ` AND created_at < ?`
    baseParams.push(opts.protectCreatedAfterMs)
  }
  if (batchSize > 0) {
    selectOverflow += ` LIMIT ?`
  }
  const sql = `DELETE FROM memories WHERE id IN (${selectOverflow})`

  const stmt = db.prepare(sql)

  let totalDeleted = 0
  let batches = 0
  for (;;) {
    const params = batchSize > 0 ? [...baseParams, batchSize] : baseParams
    const info = stmt.run(...params)
    const n = Number(info.changes)
    batches += 1
    totalDeleted += n
    if (batchSize === 0 || n < batchSize) break
    // Yield so the event loop can process queued I/O before the next pass.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { deleted: totalDeleted, batches }
}

export interface IdentityFactRow {
  id: number
  chat_id: string
  fact: string
  fact_normalized: string
  source: string
  created_at: number
}

const IDENTITY_FACT_MAX_LEN = 1000

function normalizeFact(fact: string): string {
  return fact.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Returns true if a new row was inserted, false if a matching fact (by
// normalized form) already existed for this chat. Throws on invalid input
// so the caller can surface a clear error to the user.
export function addIdentityFact(chatId: string, fact: string, source: string = 'user'): boolean {
  const trimmed = fact.trim()
  if (!trimmed) throw new Error('identity fact must not be empty')
  if (trimmed.length > IDENTITY_FACT_MAX_LEN) {
    throw new Error(`identity fact too long (max ${IDENTITY_FACT_MAX_LEN} chars)`)
  }
  const normalized = normalizeFact(trimmed)
  const info = getDb()
    .prepare(
      `INSERT INTO identity_facts (chat_id, fact, fact_normalized, source, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, fact_normalized) DO NOTHING`,
    )
    .run(chatId, trimmed, normalized, source, Date.now())
  return info.changes > 0
}

export function listIdentityFacts(chatId: string): IdentityFactRow[] {
  return getDb()
    .prepare(
      `SELECT id, chat_id, fact, fact_normalized, source, created_at
         FROM identity_facts
        WHERE chat_id = ?
        ORDER BY created_at ASC`,
    )
    .all(chatId) as IdentityFactRow[]
}

export function removeIdentityFact(chatId: string, id: number): boolean {
  const info = getDb()
    .prepare(`DELETE FROM identity_facts WHERE chat_id = ? AND id = ?`)
    .run(chatId, id)
  return info.changes > 0
}

export function countIdentityFacts(chatId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM identity_facts WHERE chat_id = ?`)
    .get(chatId) as { c: number }
  return row.c
}

export function countMemories(chatId?: string): number {
  const row = chatId
    ? (getDb().prepare('SELECT COUNT(*) AS c FROM memories WHERE chat_id = ?').get(chatId) as {
        c: number
      })
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
  missed_runs: number
  last_missed_at: number | null
}

export function createTask(
  task: Omit<
    ScheduledTask,
    'last_run' | 'last_result' | 'created_at' | 'missed_runs' | 'last_missed_at'
  >,
): void {
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
    (getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
      | ScheduledTask
      | undefined) ?? null
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

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
  missedDelta: number,
  lastMissedAt: number | null,
): number {
  const info = getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?,
           last_result = ?,
           next_run = ?,
           missed_runs = missed_runs + ?,
           last_missed_at = COALESCE(?, last_missed_at)
       WHERE id = ?`,
    )
    .run(Date.now(), result.slice(0, 500), nextRun, missedDelta, lastMissedAt, id)
  return Number(info.changes)
}

export interface MissedRunsSummary {
  totalMissed: number
  tasksWithMisses: number
  mostRecent: { id: string; at: number } | null
}

export function countMissedRuns(): MissedRunsSummary {
  const totals = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(missed_runs), 0) AS total,
         SUM(CASE WHEN missed_runs > 0 THEN 1 ELSE 0 END) AS tasks
       FROM scheduled_tasks`,
    )
    .get() as { total: number; tasks: number }
  const recent = getDb()
    .prepare(
      `SELECT id, last_missed_at AS at
       FROM scheduled_tasks
       WHERE last_missed_at IS NOT NULL
       ORDER BY last_missed_at DESC
       LIMIT 1`,
    )
    .get() as { id: string; at: number } | undefined
  return {
    totalMissed: Number(totals.total ?? 0),
    tasksWithMisses: Number(totals.tasks ?? 0),
    mostRecent: recent ? { id: recent.id, at: Number(recent.at) } : null,
  }
}

export function setTaskStatus(id: string, status: 'active' | 'paused'): void {
  getDb().prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(status, id)
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}
