import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-maint-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js')
  return { ...actual, DB_PATH: dbFile, STORE_DIR: tmpRoot }
})

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb, insertMemories, countMemories } = await import('../src/db.js')
const { runMaintenance } = await import('../src/maintenance.js')

beforeAll(() => {
  initDatabase()
  insertMemories([
    { chatId: 'c1', content: 'a', sector: 'episodic' },
    { chatId: 'c1', content: 'b', sector: 'episodic' },
    { chatId: 'c1', content: 'c', sector: 'semantic' },
  ])
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('runMaintenance', () => {
  it('runs VACUUM and ANALYZE without breaking the DB', () => {
    const before = countMemories('c1')
    expect(before).toBe(3)

    const r = runMaintenance()
    expect(r.vacuumMs).toBeGreaterThanOrEqual(0)
    expect(r.analyzeMs).toBeGreaterThanOrEqual(0)
    expect(r.sizeBytes).toBeGreaterThan(0)

    const after = countMemories('c1')
    expect(after).toBe(3)

    insertMemories([{ chatId: 'c1', content: 'd', sector: 'episodic' }])
    expect(countMemories('c1')).toBe(4)
  })

  it('reports a non-trivial sizeBytes derived from page_count * page_size', () => {
    const r = runMaintenance()
    const db = getDb()
    const pc = db.pragma('page_count', { simple: true }) as number
    const ps = db.pragma('page_size', { simple: true }) as number
    expect(r.sizeBytes).toBe(pc * ps)
  })
})
