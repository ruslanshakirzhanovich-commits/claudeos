import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, afterAll } from 'vitest'
import { useEncryptedMultiFileAuthState } from '../src/whatsapp/auth-encryption.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-auth-state-'))

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

describe('useEncryptedMultiFileAuthState', () => {
  it('creates fresh creds on first open and persists them through saveCreds', async () => {
    const dir = freshDir()
    const k = key()

    const a = await useEncryptedMultiFileAuthState(dir, k)
    const credsId = a.state.creds.registrationId
    expect(typeof credsId).toBe('number')

    await a.saveCreds()
    const files = fs.readdirSync(dir)
    expect(files).toContain('creds.json.enc')
    expect(files.some((f) => f.endsWith('.json') && !f.endsWith('.json.enc'))).toBe(false)

    const b = await useEncryptedMultiFileAuthState(dir, k)
    expect(b.state.creds.registrationId).toBe(credsId)
  })

  it('persists keys via set() and returns them via get()', async () => {
    const dir = freshDir()
    const k = key()
    const { state } = await useEncryptedMultiFileAuthState(dir, k)

    const preKeyValue = {
      private: Buffer.from([1, 2, 3, 4]),
      public: Buffer.from([5, 6, 7, 8]),
    }
    await state.keys.set({ 'pre-key': { '42': preKeyValue } })

    expect(fs.existsSync(path.join(dir, 'pre-key-42.json.enc'))).toBe(true)

    const got = await state.keys.get('pre-key', ['42'])
    expect(Buffer.isBuffer(got['42']?.private)).toBe(true)
    expect((got['42']!.private as Buffer).equals(preKeyValue.private)).toBe(true)
    expect((got['42']!.public as Buffer).equals(preKeyValue.public)).toBe(true)
  })

  it('removes the file when set() is called with null for a key', async () => {
    const dir = freshDir()
    const k = key()
    const { state } = await useEncryptedMultiFileAuthState(dir, k)
    await state.keys.set({ 'pre-key': { '99': { private: Buffer.from([0xaa]) } as any } })
    expect(fs.existsSync(path.join(dir, 'pre-key-99.json.enc'))).toBe(true)

    await state.keys.set({ 'pre-key': { '99': null as any } })
    expect(fs.existsSync(path.join(dir, 'pre-key-99.json.enc'))).toBe(false)
  })

  it('rejects key ids that would traverse out of the folder', async () => {
    const dir = freshDir()
    const k = key()
    const { state } = await useEncryptedMultiFileAuthState(dir, k)

    await expect(
      state.keys.set({ 'pre-key': { '../../evil': { private: Buffer.from([1]) } as any } }),
    ).rejects.toThrow(/invalid auth key id/i)
  })

  it('returns missing keys as undefined, not throws', async () => {
    const dir = freshDir()
    const k = key()
    const { state } = await useEncryptedMultiFileAuthState(dir, k)
    const got = await state.keys.get('pre-key', ['no-such-id'])
    expect(got['no-such-id']).toBeUndefined()
  })
})
