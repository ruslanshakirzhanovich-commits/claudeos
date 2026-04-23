import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-memcap-test-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, insertMemories, capEpisodicMemories, countMemories, getDb } = await import(
  '../src/db.js'
)

initDatabase()

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function bumpAccessed(id: number, ts: number): void {
  getDb().prepare(`UPDATE memories SET accessed_at = ? WHERE id = ?`).run(ts, id)
}

function seed(chatId: string, sector: 'episodic' | 'semantic', count: number): number[] {
  const rows = Array.from({ length: count }, (_, i) => ({
    chatId,
    content: `${sector}-${chatId}-${i}`,
    sector,
  }))
  insertMemories(rows)
  return (getDb()
    .prepare(
      `SELECT id FROM memories WHERE chat_id = ? AND sector = ? ORDER BY id ASC`,
    )
    .all(chatId, sector) as Array<{ id: number }>).map((r) => r.id)
}

function clearAll(): void {
  getDb().exec('DELETE FROM memories')
}

beforeEach(clearAll)

describe('capEpisodicMemories', () => {
  it('keeps the newest `cap` per chat and drops the rest', () => {
    const ids = seed('chat-a', 'episodic', 10)
    // Assign increasing accessed_at in the order rows were inserted, so
    // the first ids are the oldest.
    ids.forEach((id, i) => bumpAccessed(id, 1_000 + i))

    const { deleted } = capEpisodicMemories(4)
    expect(deleted).toBe(6)
    expect(countMemories('chat-a')).toBe(4)

    const kept = (getDb()
      .prepare(`SELECT id FROM memories WHERE chat_id = 'chat-a' ORDER BY accessed_at DESC`)
      .all() as Array<{ id: number }>).map((r) => r.id)
    // The 4 newest ids (indices 6..9) should survive.
    expect(kept).toEqual(ids.slice(6).reverse())
  })

  it('never touches semantic memories, even over the cap', () => {
    seed('chat-a', 'semantic', 50)
    seed('chat-a', 'episodic', 10)
    capEpisodicMemories(3)
    const bySector = (getDb()
      .prepare(
        `SELECT sector, COUNT(*) AS c FROM memories WHERE chat_id = 'chat-a' GROUP BY sector`,
      )
      .all() as Array<{ sector: string; c: number }>).reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.sector]: r.c }),
      {},
    )
    expect(bySector.semantic).toBe(50)
    expect(bySector.episodic).toBe(3)
  })

  it('applies the cap per chat independently', () => {
    seed('chat-a', 'episodic', 20)
    seed('chat-b', 'episodic', 2)
    capEpisodicMemories(5)
    expect(countMemories('chat-a')).toBe(5)
    expect(countMemories('chat-b')).toBe(2)
  })

  it('cap <= 0 is a no-op', () => {
    seed('chat-a', 'episodic', 10)
    const { deleted } = capEpisodicMemories(0)
    expect(deleted).toBe(0)
    expect(countMemories('chat-a')).toBe(10)
  })

  it('is a no-op when every chat is already under the cap', () => {
    seed('chat-a', 'episodic', 3)
    seed('chat-b', 'episodic', 1)
    const { deleted } = capEpisodicMemories(10)
    expect(deleted).toBe(0)
    expect(countMemories()).toBe(4)
  })
})
