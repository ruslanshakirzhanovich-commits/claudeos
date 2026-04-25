import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rot-'))
const STORE_DIR = path.join(tmpRoot, 'store')

vi.mock('../src/config.js', () => ({
  STORE_DIR,
}))

const warnSpy = vi.fn()
vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: (...a: unknown[]) => warnSpy(...a),
    error: () => {},
    debug: () => {},
  },
}))

vi.mock('../src/db.js', () => ({
  backupDatabase: () => {},
  verifyBackup: () => ({ schemaVersion: 7, sessions: 0, memories: 0, allowedChats: 0 }),
}))

vi.mock('../src/metrics.js', () => ({ recordEvent: () => {} }))

const { rotateBackups, backupsDir } = await import('../src/backup.js')

beforeEach(() => {
  warnSpy.mockClear()
  fs.rmSync(backupsDir(), { recursive: true, force: true })
  fs.mkdirSync(backupsDir(), { recursive: true })
})

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function seed(name: string, mtimeOffsetMs: number): string {
  const p = path.join(backupsDir(), name)
  fs.writeFileSync(p, 'fake')
  const t = Date.now() - mtimeOffsetMs
  fs.utimesSync(p, new Date(t), new Date(t))
  return p
}

describe('rotateBackups RotationResult', () => {
  it('returns counts when all deletions succeed', () => {
    seed('claudeclaw-2026-04-22T01-00-00.db', 3000)
    seed('claudeclaw-2026-04-23T01-00-00.db', 2000)
    seed('claudeclaw-2026-04-24T01-00-00.db', 1000)
    seed('claudeclaw-2026-04-25T01-00-00.db', 0)

    const res = rotateBackups(1)

    expect(res).toEqual({ requested: 3, removed: 3, failed: 0 })
    expect(fs.readdirSync(backupsDir())).toEqual(['claudeclaw-2026-04-25T01-00-00.db'])
  })

  it('counts failures separately and warns on each', () => {
    seed('claudeclaw-2026-04-22T01-00-00.db', 3000)
    seed('claudeclaw-2026-04-23T01-00-00.db', 2000)
    seed('claudeclaw-2026-04-24T01-00-00.db', 1000)
    seed('claudeclaw-2026-04-25T01-00-00.db', 0)

    const realUnlink = fs.unlinkSync
    let nthCall = 0
    const stub = vi.spyOn(fs, 'unlinkSync').mockImplementation((p: any) => {
      nthCall++
      if (nthCall === 1 || nthCall === 3) {
        const e = new Error('EACCES') as Error & { code: string }
        e.code = 'EACCES'
        throw e
      }
      return realUnlink(p)
    })
    try {
      const res = rotateBackups(1)
      expect(res).toEqual({ requested: 3, removed: 1, failed: 2 })
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      stub.mockRestore()
    }
  })
})
