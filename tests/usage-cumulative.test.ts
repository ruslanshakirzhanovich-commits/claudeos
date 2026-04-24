import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-cum-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb } = await import('../src/db.js')
const { recordUsage, resetUsage, getUsage } = await import('../src/usage.js')

initDatabase()

const CHAT = 'chat-cumulative'

beforeEach(() => resetUsage(CHAT))

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('recordUsage — cumulative semantics', () => {
  it('accumulates token counts across successive calls', () => {
    recordUsage(CHAT, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 10_000,
      cacheCreationInputTokens: 2_000,
      contextWindow: 200_000,
    })
    recordUsage(CHAT, {
      inputTokens: 400,
      outputTokens: 150,
      cacheReadInputTokens: 5_000,
      cacheCreationInputTokens: 1_000,
      contextWindow: 350_000,
    })
    const u = getUsage(CHAT)!
    expect(u.inputTokens).toBe(1400)
    expect(u.outputTokens).toBe(650)
    expect(u.cacheReadTokens).toBe(15_000)
    expect(u.cacheCreateTokens).toBe(3_000)
    // Context window is a *peak* value — max over the session, not a sum.
    expect(u.contextWindow).toBe(350_000)
  })

  it('contextWindow tracks the peak, never regresses when a smaller window comes in later', () => {
    recordUsage(CHAT, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 500_000,
    })
    recordUsage(CHAT, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 120_000, // smaller — compaction shrank the window
    })
    expect(getUsage(CHAT)!.contextWindow).toBe(500_000)
  })

  it('resetUsage wipes the accumulators so fresh counts start from zero', () => {
    recordUsage(CHAT, {
      inputTokens: 999,
      outputTokens: 999,
      cacheReadInputTokens: 999,
      cacheCreationInputTokens: 999,
      contextWindow: 999,
    })
    resetUsage(CHAT)
    recordUsage(CHAT, {
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 100,
    })
    const u = getUsage(CHAT)!
    expect(u.inputTokens).toBe(7)
    expect(u.outputTokens).toBe(3)
    expect(u.contextWindow).toBe(100)
  })
})
