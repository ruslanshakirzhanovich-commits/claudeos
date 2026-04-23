import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { verifyBackup } from '../src/db.js'

const scratch: string[] = []

function makeTempDb(): string {
  const file = path.join(os.tmpdir(), `cc-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  scratch.push(file)
  const db = new BetterSqlite3(file)
  db.pragma('foreign_keys = ON')
  db.pragma('user_version = 42')
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE allowed_chats (chat_id TEXT PRIMARY KEY);
  `)
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1')
  db.prepare('INSERT INTO memories (body) VALUES (?)').run('hello')
  db.prepare('INSERT INTO allowed_chats (chat_id) VALUES (?)').run('123')
  db.close()
  return file
}

afterEach(() => {
  while (scratch.length) {
    const f = scratch.pop()
    if (f && fs.existsSync(f)) { try { fs.unlinkSync(f) } catch { /* ignore */ } }
  }
})

describe('verifyBackup', () => {
  it('returns stats for a healthy database', () => {
    const file = makeTempDb()
    const v = verifyBackup(file)
    expect(v.schemaVersion).toBe(42)
    expect(v.sessions).toBe(1)
    expect(v.memories).toBe(1)
    expect(v.allowedChats).toBe(1)
  })

  it('throws on a corrupted database file', () => {
    const file = makeTempDb()
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r+')
    const garbage = Buffer.alloc(256, 0xff)
    fs.writeSync(fd, garbage, 0, garbage.length, Math.floor(size / 2))
    fs.closeSync(fd)

    expect(() => verifyBackup(file)).toThrow()
  })

  it('throws when the file is not a SQLite database', () => {
    const file = path.join(os.tmpdir(), `cc-backup-test-junk-${Date.now()}.txt`)
    scratch.push(file)
    fs.writeFileSync(file, 'this is not a database')
    expect(() => verifyBackup(file)).toThrow()
  })
})
