import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const realTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-backup-rot-'))
const fakeStore = path.join(realTmp, 'store')
fs.mkdirSync(fakeStore, { recursive: true })

vi.mock('../src/config.js', () => ({ STORE_DIR: fakeStore }))
vi.mock('../src/db.js', () => ({
  backupDatabase: () => {},
  verifyBackup: () => ({ schemaVersion: 1, sessions: 0, memories: 0, allowedChats: 0 }),
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

const { rotateBackups, backupsDir } = await import('../src/backup.js')

const dir = backupsDir()

function touch(name: string, mtimeMs: number): void {
  const full = path.join(dir, name)
  fs.writeFileSync(full, '')
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs))
}

beforeEach(() => {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
})

afterEach(() => {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
})

describe('rotateBackups', () => {
  it('keeps the N newest backups and deletes older ones', () => {
    const now = Date.now()
    touch('claudeclaw-2026-04-20T00-00-00.db', now - 3 * 86400_000)
    touch('claudeclaw-2026-04-21T00-00-00.db', now - 2 * 86400_000)
    touch('claudeclaw-2026-04-22T00-00-00.db', now - 1 * 86400_000)
    touch('claudeclaw-2026-04-23T00-00-00.db', now)

    const removed = rotateBackups(2)
    expect(removed).toBe(2)

    const left = fs.readdirSync(dir).sort()
    expect(left).toEqual([
      'claudeclaw-2026-04-22T00-00-00.db',
      'claudeclaw-2026-04-23T00-00-00.db',
    ])
  })

  it('ignores non-backup files in the dir', () => {
    touch('claudeclaw-2026-04-23T00-00-00.db', Date.now())
    touch('readme.txt', Date.now())
    const removed = rotateBackups(1)
    expect(removed).toBe(0)
    expect(fs.readdirSync(dir).sort()).toEqual([
      'claudeclaw-2026-04-23T00-00-00.db',
      'readme.txt',
    ])
  })

  it('keep=N preserves exactly N files even with many backups', () => {
    for (let i = 0; i < 10; i++) {
      touch(`claudeclaw-2026-04-${String(10 + i).padStart(2, '0')}T00-00-00.db`, Date.now() - (9 - i) * 86400_000)
    }
    const removed = rotateBackups(3)
    expect(removed).toBe(7)
    expect(fs.readdirSync(dir).length).toBe(3)
  })

  it('returns 0 when backups dir does not exist', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    expect(rotateBackups(5)).toBe(0)
  })
})
