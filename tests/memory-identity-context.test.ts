import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-identity-ctx-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
  MEMORY_EPISODIC_CAP_PER_CHAT: 1000,
  MEMORY_PROTECT_MIN_SALIENCE: 2.0,
  MEMORY_PROTECT_MIN_AGE_HOURS: 168,
  MEMORY_CAP_BATCH_SIZE: 100,
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb, addIdentityFact } = await import('../src/db.js')
initDatabase()

const { buildMemoryContext } = await import('../src/memory.js')

beforeEach(() => {
  getDb().exec('DELETE FROM identity_facts')
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

describe('buildMemoryContext — identity facts injection', () => {
  it('prepends identity facts into the memory context block', async () => {
    addIdentityFact('chat-a', 'prefers terse answers', 'user')
    addIdentityFact('chat-a', 'is a Linux user', 'user')

    const ctx = await buildMemoryContext('chat-a', 'hello')
    expect(ctx).toContain('prefers terse answers')
    expect(ctx).toContain('is a Linux user')
    // Identity-specific marker so the agent can tell user-curated facts
    // apart from best-effort episodic recall.
    expect(ctx).toMatch(/identity|curated|facts/i)
  })

  it('returns a non-empty context even when there are no memories but identity facts exist', async () => {
    addIdentityFact('chat-solo', 'loves Go', 'user')
    const ctx = await buildMemoryContext('chat-solo', 'what up')
    expect(ctx).not.toBe('')
    expect(ctx).toContain('loves Go')
  })

  it('scopes identity facts per chat', async () => {
    addIdentityFact('chat-a', 'only-a-fact', 'user')
    addIdentityFact('chat-b', 'only-b-fact', 'user')
    const ctxA = await buildMemoryContext('chat-a', 'hello')
    const ctxB = await buildMemoryContext('chat-b', 'hello')
    expect(ctxA).toContain('only-a-fact')
    expect(ctxA).not.toContain('only-b-fact')
    expect(ctxB).toContain('only-b-fact')
    expect(ctxB).not.toContain('only-a-fact')
  })
})
