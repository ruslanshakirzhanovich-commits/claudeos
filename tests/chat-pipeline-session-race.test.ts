import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-race-'))
const dbFile = path.join(tmpDir, 'db.sqlite')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
  PROJECT_ROOT: tmpDir,
  CLAUDE_MODEL: '',
  CLAUDE_DEFAULT_EFFORT: '',
  RATE_LIMIT_CAPACITY: 10,
  RATE_LIMIT_REFILL_PER_MIN: 100,
  RATE_LIMIT_MAX_TRACKED: 100,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: async () => '',
  saveConversationTurn: async () => {},
}))

const seenSessionIds: Array<string | undefined> = []
const runAgentMock = vi.fn(async (_msg: string, opts: any) => {
  seenSessionIds.push(opts.sessionId)
  await new Promise((r) => setTimeout(r, 30))
  return { text: 'ok', newSessionId: `sid-${seenSessionIds.length}` }
})

vi.mock('../src/agent.js', () => ({
  runAgent: (m: string, o: any) => runAgentMock(m, o),
}))

const { initDatabase, closeDb } = await import('../src/db.js')
const { runChatPipeline } = await import('../src/chat-pipeline.js')

beforeAll(() => {
  initDatabase()
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('runChatPipeline session-id race', () => {
  it('serializes per-chat: second call sees the sessionId written by the first', async () => {
    const log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => log,
    } as any

    seenSessionIds.length = 0
    runAgentMock.mockClear()

    const a = runChatPipeline({
      chatId: 'race-chat',
      userMessage: 'hi 1',
      wrappedUserMessage: 'wrap 1',
      permissionMode: 'plan',
      log,
    })
    const b = runChatPipeline({
      chatId: 'race-chat',
      userMessage: 'hi 2',
      wrappedUserMessage: 'wrap 2',
      permissionMode: 'plan',
      log,
    })

    await Promise.all([a, b])

    expect(seenSessionIds[0]).toBeUndefined()
    expect(seenSessionIds[1]).toBe('sid-1')
  })
})
