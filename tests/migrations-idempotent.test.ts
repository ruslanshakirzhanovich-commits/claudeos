import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

const { MIGRATIONS, runMigrations } = await import('../src/migrations.js')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-migrations-test-'))

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function openFresh(name: string): InstanceType<typeof Database> {
  const dbFile = path.join(tmpDir, name)
  try {
    fs.unlinkSync(dbFile)
  } catch {
    /* ignore */
  }
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  return db
}

describe('migrations idempotency', () => {
  it('double-applies without error: reset user_version then rerun', () => {
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version
    const db = openFresh('double-apply.db')
    try {
      runMigrations(db)
      expect(db.pragma('user_version', { simple: true })).toBe(latest)

      db.pragma('user_version = 0')
      runMigrations(db)

      expect(db.pragma('user_version', { simple: true })).toBe(latest)

      const scheduledCols = (
        db.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as { name: string }[]
      )
        .map((c) => c.name)
        .sort()
      expect(scheduledCols).toEqual(
        expect.arrayContaining([
          'id',
          'chat_id',
          'prompt',
          'schedule',
          'next_run',
          'last_run',
          'last_result',
          'status',
          'created_at',
          'missed_runs',
          'last_missed_at',
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('no-ops cleanly when already at latest version', () => {
    const db = openFresh('no-op.db')
    try {
      runMigrations(db)
      const before = db.pragma('user_version', { simple: true })
      runMigrations(db)
      const after = db.pragma('user_version', { simple: true })
      expect(after).toBe(before)
    } finally {
      db.close()
    }
  })
})
