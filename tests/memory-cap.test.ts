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

const { initDatabase, closeDb, insertMemories, capEpisodicMemories, countMemories, getDb } =
  await import('../src/db.js')

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
  return (
    getDb()
      .prepare(`SELECT id FROM memories WHERE chat_id = ? AND sector = ? ORDER BY id ASC`)
      .all(chatId, sector) as Array<{ id: number }>
  ).map((r) => r.id)
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

    const kept = (
      getDb()
        .prepare(`SELECT id FROM memories WHERE chat_id = 'chat-a' ORDER BY accessed_at DESC`)
        .all() as Array<{ id: number }>
    ).map((r) => r.id)
    // The 4 newest ids (indices 6..9) should survive.
    expect(kept).toEqual(ids.slice(6).reverse())
  })

  it('never touches semantic memories, even over the cap', () => {
    seed('chat-a', 'semantic', 50)
    seed('chat-a', 'episodic', 10)
    capEpisodicMemories(3)
    const bySector = (
      getDb()
        .prepare(
          `SELECT sector, COUNT(*) AS c FROM memories WHERE chat_id = 'chat-a' GROUP BY sector`,
        )
        .all() as Array<{ sector: string; c: number }>
    ).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.sector]: r.c }), {})
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

  describe('protection options', () => {
    function setSalience(id: number, salience: number): void {
      getDb().prepare(`UPDATE memories SET salience = ? WHERE id = ?`).run(salience, id)
    }

    function setCreatedAt(id: number, ts: number): void {
      getDb().prepare(`UPDATE memories SET created_at = ? WHERE id = ?`).run(ts, id)
    }

    it('spares memories younger than protectCreatedAfterMs from eviction', () => {
      const ids = seed('chat-a', 'episodic', 10)
      // All accessed at the same moment — without protection, ids past the cap
      // would be dropped in ROW_NUMBER order (effectively arbitrary).
      ids.forEach((id, i) => bumpAccessed(id, 1_000 + i))

      const now = Date.now()
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000
      // Oldest 5 rows predate the cutoff; newest 5 are "fresh" and must survive.
      ids.slice(0, 5).forEach((id) => setCreatedAt(id, weekAgo - 1_000))
      ids.slice(5).forEach((id) => setCreatedAt(id, now))

      const { deleted } = capEpisodicMemories(3, { protectCreatedAfterMs: weekAgo })
      expect(deleted).toBe(5)
      const survivors = (
        getDb()
          .prepare(`SELECT id FROM memories WHERE chat_id = 'chat-a' ORDER BY id ASC`)
          .all() as Array<{ id: number }>
      ).map((r) => r.id)
      // All 5 fresh ids must survive, none of the old ones.
      expect(survivors).toEqual(ids.slice(5))
    })

    it('spares memories with salience >= protectMinSalience from eviction', () => {
      const ids = seed('chat-a', 'episodic', 10)
      ids.forEach((id, i) => bumpAccessed(id, 1_000 + i))

      const now = Date.now()
      // Make all rows old so the age protection does not apply.
      ids.forEach((id) => setCreatedAt(id, now - 30 * 24 * 60 * 60 * 1000))
      // First 3 ids are high salience (explicitly curated identity facts).
      ids.slice(0, 3).forEach((id) => setSalience(id, 3.0))

      const { deleted } = capEpisodicMemories(2, { protectMinSalience: 2.0 })
      expect(deleted).toBe(5)
      const survivors = new Set(
        (
          getDb().prepare(`SELECT id FROM memories WHERE chat_id = 'chat-a'`).all() as Array<{
            id: number
          }>
        ).map((r) => r.id),
      )
      // All three high-salience ids must be kept.
      for (const id of ids.slice(0, 3)) expect(survivors.has(id)).toBe(true)
      // Total remaining: 3 protected + 2 most-recent non-protected = 5.
      expect(survivors.size).toBe(5)
    })

    it('falls back to old unprotected behaviour when no options are passed', () => {
      // Regression safety: the existing call sites pass no options and must
      // keep seeing the pre-option semantics (drop by accessed_at past cap).
      const ids = seed('chat-a', 'episodic', 6)
      ids.forEach((id, i) => bumpAccessed(id, 1_000 + i))
      const { deleted } = capEpisodicMemories(2)
      expect(deleted).toBe(4)
      expect(countMemories('chat-a')).toBe(2)
    })
  })

  describe('batching', () => {
    it('deletes the exact same total when batchSize forces multiple passes', async () => {
      const ids = seed('chat-a', 'episodic', 25)
      ids.forEach((id, i) => bumpAccessed(id, 1_000 + i))

      // With batchSize=7 and 20 rows to drop, the implementation should
      // make 3 passes (7 + 7 + 6) and still report the full total.
      const { deleted, batches } = await capEpisodicMemoriesBatched(5, { batchSize: 7 })
      expect(deleted).toBe(20)
      expect(batches).toBeGreaterThanOrEqual(3)
      expect(countMemories('chat-a')).toBe(5)
    })

    it('one pass when rows fit inside a single batch', async () => {
      seed('chat-a', 'episodic', 8)
      const { deleted, batches } = await capEpisodicMemoriesBatched(2, { batchSize: 100 })
      expect(deleted).toBe(6)
      expect(batches).toBe(1)
    })

    it('respects protection options while batching', async () => {
      const ids = seed('chat-a', 'episodic', 12)
      ids.forEach((id, i) => bumpAccessed(id, 1_000 + i))
      const now = Date.now()
      ids.forEach((id) => setCreatedAtRaw(id, now - 30 * 24 * 60 * 60 * 1000))
      // Protect the 4 highest-id rows with salience.
      ids.slice(-4).forEach((id) => setSalienceRaw(id, 3.0))

      const { deleted } = await capEpisodicMemoriesBatched(3, {
        batchSize: 2,
        protectMinSalience: 2.0,
      })
      // ids[8..11] are high-salience. ids[9..11] would survive anyway as
      // the top-3 by accessed_at; ids[8] survives only because of the
      // salience guard. ids[0..7] (low salience, older) all evict.
      expect(deleted).toBe(8)
      expect(countMemories('chat-a')).toBe(4)
    })
  })
})

// Helpers reused by the batching suite. Declared outside the block because
// vitest hoists describe/beforeEach wiring.
function setCreatedAtRaw(id: number, ts: number): void {
  getDb().prepare(`UPDATE memories SET created_at = ? WHERE id = ?`).run(ts, id)
}

function setSalienceRaw(id: number, salience: number): void {
  getDb().prepare(`UPDATE memories SET salience = ? WHERE id = ?`).run(salience, id)
}

// Pulled from the same module; declared at the bottom so the dynamic import
// that sits at the top of the file has already resolved by the time tests run.
const { capEpisodicMemoriesBatched } = await import('../src/db.js')
