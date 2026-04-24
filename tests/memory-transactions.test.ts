import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

describe('better-sqlite3 transaction semantics (pattern used by db.ts)', () => {
  it('rolls back all writes in a tx if any statement throws', () => {
    const file = path.join(os.tmpdir(), `cc-tx-test-${Date.now()}.db`)
    const db = new BetterSqlite3(file)
    try {
      db.exec(
        `CREATE TABLE memories (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, content TEXT NOT NULL)`,
      )
      const ins = db.prepare(`INSERT INTO memories (chat_id, content) VALUES (?, ?)`)
      const tx = db.transaction((rows: Array<{ chatId: string | null; content: string }>) => {
        for (const r of rows) ins.run(r.chatId, r.content)
      })

      expect(() =>
        tx([
          { chatId: 'ok', content: 'first' },
          { chatId: null, content: 'fails NOT NULL' },
        ]),
      ).toThrow()

      const count = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
      expect(count).toBe(0)
    } finally {
      db.close()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  })

  it('commits all writes when the tx completes cleanly', () => {
    const file = path.join(os.tmpdir(), `cc-tx-test-ok-${Date.now()}.db`)
    const db = new BetterSqlite3(file)
    try {
      db.exec(
        `CREATE TABLE memories (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, content TEXT NOT NULL)`,
      )
      const ins = db.prepare(`INSERT INTO memories (chat_id, content) VALUES (?, ?)`)
      const tx = db.transaction((rows: Array<{ chatId: string; content: string }>) => {
        for (const r of rows) ins.run(r.chatId, r.content)
      })

      tx([
        { chatId: 'a', content: 'one' },
        { chatId: 'a', content: 'two' },
      ])

      const count = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
      expect(count).toBe(2)
    } finally {
      db.close()
      if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  })
})
