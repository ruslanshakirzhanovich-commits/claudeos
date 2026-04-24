import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-identity-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({ DB_PATH: dbFile, STORE_DIR: tmpDir }))
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const {
  initDatabase,
  closeDb,
  getDb,
  addIdentityFact,
  listIdentityFacts,
  removeIdentityFact,
  countIdentityFacts,
} = await import('../src/db.js')

initDatabase()

beforeEach(() => {
  getDb().exec('DELETE FROM identity_facts')
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('identity_facts CRUD', () => {
  it('stores a fact for a chat and returns it via listIdentityFacts', () => {
    addIdentityFact('chat-a', 'я программист на TypeScript', 'user')
    const facts = listIdentityFacts('chat-a')
    expect(facts).toHaveLength(1)
    expect(facts[0]?.fact).toBe('я программист на TypeScript')
    expect(facts[0]?.source).toBe('user')
    expect(typeof facts[0]?.id).toBe('number')
  })

  it('scopes facts per chat — facts from chat-a do not leak into chat-b', () => {
    addIdentityFact('chat-a', 'fact a', 'user')
    addIdentityFact('chat-b', 'fact b', 'user')
    expect(listIdentityFacts('chat-a').map((f) => f.fact)).toEqual(['fact a'])
    expect(listIdentityFacts('chat-b').map((f) => f.fact)).toEqual(['fact b'])
  })

  it('rejects duplicate facts for the same chat (case-insensitive, trimmed)', () => {
    expect(addIdentityFact('chat-a', 'I use Linux', 'user')).toBe(true)
    expect(addIdentityFact('chat-a', '  i use linux  ', 'user')).toBe(false)
    expect(listIdentityFacts('chat-a')).toHaveLength(1)
  })

  it('removeIdentityFact by id deletes exactly that row', () => {
    addIdentityFact('chat-a', 'one', 'user')
    addIdentityFact('chat-a', 'two', 'user')
    addIdentityFact('chat-a', 'three', 'user')
    const facts = listIdentityFacts('chat-a')
    const targetId = facts.find((f) => f.fact === 'two')!.id

    expect(removeIdentityFact('chat-a', targetId)).toBe(true)
    const remaining = listIdentityFacts('chat-a')
      .map((f) => f.fact)
      .sort()
    expect(remaining).toEqual(['one', 'three'])
  })

  it('removeIdentityFact returns false when the id does not belong to that chat', () => {
    addIdentityFact('chat-a', 'mine', 'user')
    const id = listIdentityFacts('chat-a')[0]!.id
    // Wrong chat — must refuse so one user cannot delete another user's facts.
    expect(removeIdentityFact('chat-b', id)).toBe(false)
    expect(listIdentityFacts('chat-a')).toHaveLength(1)
  })

  it('countIdentityFacts reports totals per chat', () => {
    addIdentityFact('chat-a', 'one', 'user')
    addIdentityFact('chat-a', 'two', 'user')
    addIdentityFact('chat-b', 'single', 'user')
    expect(countIdentityFacts('chat-a')).toBe(2)
    expect(countIdentityFacts('chat-b')).toBe(1)
    expect(countIdentityFacts('nowhere')).toBe(0)
  })

  it('rejects empty or whitespace-only facts', () => {
    expect(() => addIdentityFact('chat-a', '', 'user')).toThrow()
    expect(() => addIdentityFact('chat-a', '   ', 'user')).toThrow()
  })

  it('caps fact length to a sane limit to prevent abuse', () => {
    const huge = 'x'.repeat(5_000)
    expect(() => addIdentityFact('chat-a', huge, 'user')).toThrow(/too long/i)
  })
})
