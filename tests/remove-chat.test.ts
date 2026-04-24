import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remove-chat-test-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
}))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const {
  initDatabase,
  closeDb,
  addAllowedChat,
  removeAllowedChat,
  isChatAllowed,
  setSession,
  getSession,
  setPreferredModel,
  getPreferredModel,
  setTtsEnabled,
  insertMemories,
  countMemories,
  createTask,
} = await import('../src/db.js')

initDatabase()

const CHAT = '555444'

beforeEach(() => {
  // best-effort cleanup between runs
  removeAllowedChat(CHAT)
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function seed(): void {
  addAllowedChat(CHAT, 'admin', 'test')
  setSession(CHAT, 'sess-abc-123')
  setPreferredModel(CHAT, 'claude-sonnet-4-6')
  setTtsEnabled(CHAT, true)
  insertMemories([
    { chatId: CHAT, content: 'fact one', sector: 'semantic' },
    { chatId: CHAT, content: 'fact two', sector: 'episodic' },
    { chatId: CHAT, content: 'fact three', sector: 'episodic' },
  ])
  createTask({
    id: 'task-1',
    chat_id: CHAT,
    prompt: 'daily reminder',
    schedule: '0 9 * * *',
    next_run: Date.now() + 86400_000,
    status: 'active',
  })
}

describe('removeAllowedChat cascades', () => {
  it('reports full purge counts when removing a seeded chat', () => {
    seed()
    expect(isChatAllowed(CHAT)).toBe(true)
    expect(getSession(CHAT)).toBe('sess-abc-123')
    expect(getPreferredModel(CHAT)).toBe('claude-sonnet-4-6')
    expect(countMemories(CHAT)).toBe(3)

    const r = removeAllowedChat(CHAT)

    expect(r.removed).toBe(true)
    expect(r.preferencesCleared).toBe(true)
    expect(r.sessionCleared).toBe(true)
    expect(r.memoriesDeleted).toBe(3)
    expect(r.tasksDeleted).toBe(1)

    expect(isChatAllowed(CHAT)).toBe(false)
    expect(getSession(CHAT)).toBeNull()
    expect(getPreferredModel(CHAT)).toBeNull()
    expect(countMemories(CHAT)).toBe(0)
  })

  it('is idempotent and returns all-zero result on a nonexistent chat', () => {
    const r = removeAllowedChat('nope-9999')
    expect(r.removed).toBe(false)
    expect(r.memoriesDeleted).toBe(0)
    expect(r.tasksDeleted).toBe(0)
    expect(r.sessionCleared).toBe(false)
    expect(r.preferencesCleared).toBe(false)
  })

  it('does not touch other chats', () => {
    const OTHER = '888777'
    seed()
    addAllowedChat(OTHER, 'admin', null)
    setSession(OTHER, 'other-sess')
    insertMemories([{ chatId: OTHER, content: 'other fact', sector: 'episodic' }])

    removeAllowedChat(CHAT)

    expect(isChatAllowed(OTHER)).toBe(true)
    expect(getSession(OTHER)).toBe('other-sess')
    expect(countMemories(OTHER)).toBe(1)

    // cleanup
    removeAllowedChat(OTHER)
  })
})
