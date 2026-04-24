import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { assertSafeBackupPath } from '../src/db.js'

const ALLOWED = '/var/claudeclaw/store/backups'

describe('assertSafeBackupPath', () => {
  it('accepts a normal backup filename inside the allowed dir', () => {
    expect(() =>
      assertSafeBackupPath(path.join(ALLOWED, 'claudeclaw-2026-04-24T10-11-12.db'), ALLOWED),
    ).not.toThrow()
  })

  it('rejects paths outside the allowed dir', () => {
    expect(() => assertSafeBackupPath('/etc/passwd', ALLOWED)).toThrow(/outside allowed/i)
    expect(() => assertSafeBackupPath('/tmp/backup.db', ALLOWED)).toThrow(/outside allowed/i)
  })

  it('rejects traversal attempts via ..', () => {
    expect(() =>
      assertSafeBackupPath(path.join(ALLOWED, '..', '..', 'etc', 'passwd'), ALLOWED),
    ).toThrow(/outside allowed/i)
  })

  it('rejects filenames with quote characters (SQL injection guard)', () => {
    expect(() => assertSafeBackupPath(path.join(ALLOWED, "evil'.db"), ALLOWED)).toThrow(
      /invalid.*filename/i,
    )
  })

  it('rejects filenames without the .db extension', () => {
    expect(() => assertSafeBackupPath(path.join(ALLOWED, 'plainfile'), ALLOWED)).toThrow(
      /invalid.*filename/i,
    )
  })

  it('rejects shell metacharacters in the filename', () => {
    for (const bad of ['a;b.db', 'a`b.db', 'a$b.db', 'a b.db']) {
      expect(() => assertSafeBackupPath(path.join(ALLOWED, bad), ALLOWED)).toThrow(
        /invalid.*filename/i,
      )
    }
  })

  it('rejects relative paths', () => {
    expect(() => assertSafeBackupPath('backup.db', ALLOWED)).toThrow(/absolute/i)
    expect(() => assertSafeBackupPath('./backup.db', ALLOWED)).toThrow(/absolute/i)
  })
})
