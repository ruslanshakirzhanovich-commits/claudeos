import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decay-sem-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({ DB_PATH: dbFile, STORE_DIR: tmpDir }))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, insertMemories, decayMemories, getDb } = await import('../src/db.js')

initDatabase()

beforeEach(() => {
  getDb().exec('DELETE FROM memories')
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function backdate(id: number, createdAt: number): void {
  getDb().prepare(`UPDATE memories SET created_at = ? WHERE id = ?`).run(createdAt, id)
}

function setSalience(id: number, s: number): void {
  getDb().prepare(`UPDATE memories SET salience = ? WHERE id = ?`).run(s, id)
}

function getSalience(id: number): number {
  return (
    getDb().prepare(`SELECT salience FROM memories WHERE id = ?`).get(id) as { salience: number }
  ).salience
}

function idsBySector(chatId: string, sector: 'semantic' | 'episodic'): number[] {
  return (
    getDb()
      .prepare(`SELECT id FROM memories WHERE chat_id = ? AND sector = ? ORDER BY id ASC`)
      .all(chatId, sector) as Array<{ id: number }>
  ).map((r) => r.id)
}

describe('decayMemories — semantic protection', () => {
  it('does not decay salience on semantic memories, even if they are old', () => {
    insertMemories([
      { chatId: 'c', content: 'semantic fact', sector: 'semantic' },
      { chatId: 'c', content: 'episodic trace', sector: 'episodic' },
    ])
    const [semId] = idsBySector('c', 'semantic')
    const [epiId] = idsBySector('c', 'episodic')

    // Backdate both so they match the decay cutoff (older than 24h).
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000
    backdate(semId!, old)
    backdate(epiId!, old)
    setSalience(semId!, 1.0)
    setSalience(epiId!, 1.0)

    decayMemories()

    // Semantic stays at 1.0; episodic drops to 0.98.
    expect(getSalience(semId!)).toBeCloseTo(1.0, 6)
    expect(getSalience(epiId!)).toBeCloseTo(0.98, 6)
  })

  it('never deletes semantic memories via the salience-threshold sweep', () => {
    insertMemories([
      { chatId: 'c', content: 'priceless semantic', sector: 'semantic' },
      { chatId: 'c', content: 'stale episodic', sector: 'episodic' },
    ])
    const [semId] = idsBySector('c', 'semantic')
    const [epiId] = idsBySector('c', 'episodic')

    // Force both below the deletion threshold. Without the semantic guard,
    // the semantic row would also be dropped — this test pins the fix.
    setSalience(semId!, 0.05)
    setSalience(epiId!, 0.05)

    const { deleted } = decayMemories()

    // Only the episodic row should be gone.
    expect(deleted).toBe(1)
    expect(idsBySector('c', 'semantic')).toEqual([semId!])
    expect(idsBySector('c', 'episodic')).toEqual([])
  })
})
