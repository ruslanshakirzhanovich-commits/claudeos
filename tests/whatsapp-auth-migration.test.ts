import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, afterAll, vi } from 'vitest'

const warnSpy = vi.fn()
vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    debug: () => {},
  },
}))

const { migratePlainAuthFiles, decrypt } = await import('../src/whatsapp/auth-encryption.js')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-auth-mig-'))

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function freshDir(): string {
  return fs.mkdtempSync(path.join(tmpRoot, 'dir-'))
}

function key(): Buffer {
  return crypto.randomBytes(32)
}

describe('migratePlainAuthFiles', () => {
  it('encrypts every plain .json file and removes the originals', async () => {
    const dir = freshDir()
    const k = key()
    fs.writeFileSync(path.join(dir, 'creds.json'), '{"reg":1}', 'utf8')
    fs.writeFileSync(path.join(dir, 'pre-key-1.json'), '{"x":"y"}', 'utf8')
    fs.writeFileSync(path.join(dir, 'pre-key-2.json'), '{"x":"z"}', 'utf8')

    const res = await migratePlainAuthFiles(dir, k)

    expect(res).toEqual({ migrated: 3, alreadyEncrypted: 0 })
    const names = fs.readdirSync(dir).sort()
    expect(names).toEqual(['creds.json.enc', 'pre-key-1.json.enc', 'pre-key-2.json.enc'].sort())

    const ct = fs.readFileSync(path.join(dir, 'creds.json.enc'))
    const pt = decrypt(ct, k)
    expect(pt.toString('utf8')).toBe('{"reg":1}')
  })

  it('is idempotent: second run with no plain files returns alreadyEncrypted', async () => {
    const dir = freshDir()
    const k = key()
    fs.writeFileSync(path.join(dir, 'creds.json'), '{"reg":1}', 'utf8')
    await migratePlainAuthFiles(dir, k)
    const res = await migratePlainAuthFiles(dir, k)
    expect(res).toEqual({ migrated: 0, alreadyEncrypted: 1 })
  })

  it('when both plain and encrypted siblings exist, keeps encrypted and removes plain', async () => {
    const dir = freshDir()
    const k = key()
    fs.writeFileSync(path.join(dir, 'creds.json'), '{"plain":true}', 'utf8')
    fs.writeFileSync(path.join(dir, 'creds.json.enc'), Buffer.from('fake'), 'utf8')

    const res = await migratePlainAuthFiles(dir, k)

    expect(fs.existsSync(path.join(dir, 'creds.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'creds.json.enc'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'creds.json.enc')).toString('utf8')).toBe('fake')
    expect(res.alreadyEncrypted).toBeGreaterThanOrEqual(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('partial'))
  })

  it('noops on empty directory', async () => {
    const dir = freshDir()
    const k = key()
    const res = await migratePlainAuthFiles(dir, k)
    expect(res).toEqual({ migrated: 0, alreadyEncrypted: 0 })
  })
})
