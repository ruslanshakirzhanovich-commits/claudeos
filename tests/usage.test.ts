import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-test-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase } = await import('../src/db.js')
const { recordUsage, recordCompaction, resetUsage, getUsage } = await import('../src/usage.js')

initDatabase()

const CHAT = 'test-chat-usage'

beforeEach(() => resetUsage(CHAT))

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('usage tracker (DB-backed)', () => {
  it('returns null before any turn is recorded', () => {
    expect(getUsage(CHAT)).toBeNull()
  })

  it('stores the most recent turn with cache + context numbers', () => {
    recordUsage(CHAT, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 29_000,
      cacheCreationInputTokens: 3_000,
      contextWindow: 1_000_000,
    })
    const u = getUsage(CHAT)
    expect(u).not.toBeNull()
    expect(u!.cacheReadTokens).toBe(29_000)
    expect(u!.cacheCreateTokens).toBe(3_000)
    expect(u!.contextWindow).toBe(1_000_000)
    expect(u!.compactions).toBe(0)
  })

  it('preserves compactions across recordUsage (state is per-chat)', () => {
    recordCompaction(CHAT)
    recordCompaction(CHAT)
    recordUsage(CHAT, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
    })
    expect(getUsage(CHAT)!.compactions).toBe(2)
  })

  it('recordCompaction works before any usage has been recorded', () => {
    recordCompaction(CHAT)
    const u = getUsage(CHAT)
    expect(u).not.toBeNull()
    expect(u!.compactions).toBe(1)
    expect(u!.inputTokens).toBe(0)
    expect(u!.cacheReadTokens).toBe(0)
  })

  it('resetUsage clears all state for the chat', () => {
    recordUsage(CHAT, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 1,
      contextWindow: 200_000,
    })
    recordCompaction(CHAT)
    resetUsage(CHAT)
    expect(getUsage(CHAT)).toBeNull()
  })
})
