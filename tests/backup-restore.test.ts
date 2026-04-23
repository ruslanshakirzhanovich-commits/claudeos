import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-backup-restore-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')
const backupFile = path.join(tmpDir, 'restore-target.db')

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
  insertMemories,
  addAllowedChat,
  setSession,
  backupDatabase,
  verifyBackup,
  getDb,
} = await import('../src/db.js')

initDatabase()

function clearAll(): void {
  const db = getDb()
  db.exec('DELETE FROM memories')
  db.exec('DELETE FROM allowed_chats')
  db.exec('DELETE FROM sessions')
}

beforeEach(() => {
  clearAll()
  if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile)
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('backup → restore → verify roundtrip', () => {
  it('backup contains the same rows as the live DB', () => {
    addAllowedChat('123', 'admin', 'test')
    addAllowedChat('456', 'admin', 'test')
    setSession('123', 'sess-abc')
    insertMemories([
      { chatId: '123', content: 'hello', sector: 'episodic' },
      { chatId: '123', content: 'prefers terse answers', sector: 'semantic' },
      { chatId: '456', content: 'other chat turn', sector: 'episodic' },
    ])

    backupDatabase(backupFile)
    const report = verifyBackup(backupFile)

    expect(report.memories).toBe(3)
    expect(report.allowedChats).toBe(2)
    expect(report.sessions).toBe(1)
    expect(report.schemaVersion).toBeGreaterThan(0)
  })

  it('restoring the backup as a fresh DB yields an identical working dataset', () => {
    addAllowedChat('123', 'admin', null)
    insertMemories([
      { chatId: '123', content: 'note one', sector: 'episodic' },
      { chatId: '123', content: 'note two', sector: 'semantic' },
    ])
    backupDatabase(backupFile)

    // Open the backup as if it were a new deployment's DB.
    const restored = new BetterSqlite3(backupFile, { readonly: true, fileMustExist: true })
    try {
      const memRows = restored
        .prepare(`SELECT content, sector FROM memories WHERE chat_id = ? ORDER BY id ASC`)
        .all('123') as Array<{ content: string; sector: string }>
      expect(memRows).toEqual([
        { content: 'note one', sector: 'episodic' },
        { content: 'note two', sector: 'semantic' },
      ])

      const allowed = restored
        .prepare(`SELECT chat_id FROM allowed_chats ORDER BY chat_id`)
        .all() as Array<{ chat_id: string }>
      expect(allowed.map((r) => r.chat_id)).toEqual(['123'])

      // FTS5 shadow tables survive VACUUM INTO and still serve MATCH.
      const fts = restored
        .prepare(
          `SELECT m.content FROM memories m
             JOIN memories_fts f ON f.rowid = m.id
            WHERE memories_fts MATCH ? AND m.chat_id = ?`,
        )
        .all('note*', '123') as Array<{ content: string }>
      expect(fts.map((r) => r.content).sort()).toEqual(['note one', 'note two'])
    } finally {
      restored.close()
    }
  })

  it('verifyBackup refuses a corrupted backup file', () => {
    backupDatabase(backupFile)
    // Flip a byte near the file header to corrupt it.
    const buf = fs.readFileSync(backupFile)
    buf[100] = buf[100]! ^ 0xff
    fs.writeFileSync(backupFile, buf)

    expect(() => verifyBackup(backupFile)).toThrow()
  })

  it('verifyBackup refuses a non-existent backup path', () => {
    expect(() => verifyBackup(path.join(tmpDir, 'does-not-exist.db'))).toThrow()
  })
})
