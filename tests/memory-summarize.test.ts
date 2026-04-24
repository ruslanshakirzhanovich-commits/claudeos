import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-summarize-test-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
  PROJECT_ROOT: tmpDir,
  CLAUDE_MODEL: '',
}))
vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})
// The agent SDK is only reached by summarizeViaAgentSdk, which we do NOT
// exercise here — the test drives runMemorySummarizeSweep with an
// injected fake. Stub the import so module load doesn't try to connect.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: async function* () {
      /* never yields */
    },
  }),
}))

const {
  initDatabase,
  closeDb,
  insertMemories,
  getDb,
  listChatsWithStaleEpisodic,
  getStaleEpisodicForChat,
  replaceEpisodicWithSummary,
  countMemories,
} = await import('../src/db.js')
const { runMemorySummarizeSweep } = await import('../src/memory-summarize.js')

initDatabase()

function clearAll(): void {
  getDb().exec('DELETE FROM memories')
}

function seedEpisodic(chatId: string, count: number, ageDays: number): void {
  const now = Date.now()
  const createdAt = now - ageDays * 24 * 60 * 60 * 1000
  const rows = Array.from({ length: count }, (_, i) => ({
    chatId,
    content: `old-episodic ${chatId} #${i}`,
    sector: 'episodic' as const,
  }))
  insertMemories(rows)
  // insertMemories stamps created_at to now. Push the seeded rows back
  // in time so they qualify as "stale" for the summarize cutoff.
  getDb()
    .prepare(
      `UPDATE memories SET created_at = ? WHERE chat_id = ? AND sector = 'episodic'`,
    )
    .run(createdAt, chatId)
}

beforeEach(clearAll)

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('listChatsWithStaleEpisodic', () => {
  it('returns only chats over the minCount and older than cutoff', () => {
    seedEpisodic('chat-a', 15, 30)
    seedEpisodic('chat-b', 3, 30)
    seedEpisodic('chat-c', 15, 1) // too new
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    expect(listChatsWithStaleEpisodic(cutoff, 10).sort()).toEqual(['chat-a'])
  })
})

describe('replaceEpisodicWithSummary', () => {
  it('atomically swaps N episodic rows for one semantic summary', () => {
    seedEpisodic('chat-a', 5, 30)
    const ids = (getStaleEpisodicForChat('chat-a', Date.now(), 100)).map((r) => r.id)
    const res = replaceEpisodicWithSummary('chat-a', ids, 'user prefers concise answers')
    expect(res.inserted).toBe(1)
    expect(res.deleted).toBe(5)

    const after = getDb()
      .prepare(`SELECT sector, content FROM memories WHERE chat_id = 'chat-a'`)
      .all() as Array<{ sector: string; content: string }>
    expect(after).toEqual([{ sector: 'semantic', content: 'user prefers concise answers' }])
  })

  it('is a no-op for empty ids', () => {
    seedEpisodic('chat-a', 3, 30)
    const res = replaceEpisodicWithSummary('chat-a', [], 'summary')
    expect(res).toEqual({ inserted: 0, deleted: 0 })
    expect(countMemories('chat-a')).toBe(3)
  })

  it('is a no-op for blank summary (never wipe sources without a replacement)', () => {
    seedEpisodic('chat-a', 3, 30)
    const ids = (getStaleEpisodicForChat('chat-a', Date.now(), 100)).map((r) => r.id)
    const res = replaceEpisodicWithSummary('chat-a', ids, '   ')
    expect(res).toEqual({ inserted: 0, deleted: 0 })
    expect(countMemories('chat-a')).toBe(3)
  })
})

describe('runMemorySummarizeSweep', () => {
  it('consolidates stale episodic per chat through the injected summarizer', async () => {
    seedEpisodic('chat-a', 12, 30)
    seedEpisodic('chat-b', 12, 30)
    seedEpisodic('chat-c', 3, 30) // below minBatch, untouched

    const seen: string[] = []
    const summarize = vi.fn(async (text: string) => {
      seen.push(text.slice(0, 20))
      return 'user is active'
    })

    const res = await runMemorySummarizeSweep(
      { minAgeDays: 7, batch: 50, minBatch: 10 },
      summarize,
    )

    expect(res.chatsProcessed).toBe(2)
    expect(res.chatsConsolidated).toBe(2)
    expect(res.episodicConsolidated).toBe(24)
    expect(res.errors).toBe(0)
    expect(summarize).toHaveBeenCalledTimes(2)

    expect(countMemories('chat-a')).toBe(1)
    expect(countMemories('chat-b')).toBe(1)
    expect(countMemories('chat-c')).toBe(3)
  })

  it('skips the swap when summarize returns empty', async () => {
    seedEpisodic('chat-a', 12, 30)
    const summarize = vi.fn(async () => '')
    const res = await runMemorySummarizeSweep(
      { minAgeDays: 7, batch: 50, minBatch: 10 },
      summarize,
    )
    expect(res.chatsConsolidated).toBe(0)
    expect(res.episodicConsolidated).toBe(0)
    expect(countMemories('chat-a')).toBe(12) // still intact
  })

  it('records an error and moves on when summarize throws', async () => {
    seedEpisodic('chat-a', 12, 30)
    seedEpisodic('chat-b', 12, 30)
    const summarize = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('network down')
      })
      .mockImplementationOnce(async () => 'ok summary')

    const res = await runMemorySummarizeSweep(
      { minAgeDays: 7, batch: 50, minBatch: 10 },
      summarize,
    )

    expect(res.errors).toBe(1)
    expect(res.chatsConsolidated).toBe(1)
    // The failing chat keeps its rows; the succeeding one is consolidated.
    const totals = [countMemories('chat-a'), countMemories('chat-b')].sort()
    expect(totals).toEqual([1, 12])
  })

  it('does nothing when there is no stale episodic to consolidate', async () => {
    seedEpisodic('chat-a', 2, 1) // too new, below minBatch
    const summarize = vi.fn(async () => 'nope')
    const res = await runMemorySummarizeSweep(
      { minAgeDays: 7, batch: 50, minBatch: 10 },
      summarize,
    )
    expect(res).toEqual({
      chatsProcessed: 0,
      chatsConsolidated: 0,
      episodicConsolidated: 0,
      errors: 0,
    })
    expect(summarize).not.toHaveBeenCalled()
  })
})
