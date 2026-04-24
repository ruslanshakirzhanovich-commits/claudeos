import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../src/whatsapp/auth-encryption.js'

function key(): Buffer {
  return crypto.randomBytes(32)
}

describe('auth-encryption primitives', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const k = key()
    const pt = Buffer.from('hello, baileys', 'utf8')
    const ct = encrypt(pt, k)
    expect(ct.length).toBe(12 + 16 + pt.length)
    const back = decrypt(ct, k)
    expect(back.toString('utf8')).toBe('hello, baileys')
  })

  it('rejects ciphertext tampered in the body', () => {
    const k = key()
    const ct = encrypt(Buffer.from('secret'), k)
    ct[ct.length - 1] ^= 0x01
    expect(() => decrypt(ct, k)).toThrow(/auth file decryption failed/i)
  })

  it('rejects ciphertext tampered in the auth tag', () => {
    const k = key()
    const ct = encrypt(Buffer.from('secret'), k)
    ct[12] ^= 0x01
    expect(() => decrypt(ct, k)).toThrow(/auth file decryption failed/i)
  })

  it('rejects decryption with a wrong key', () => {
    const k1 = key()
    const k2 = key()
    const ct = encrypt(Buffer.from('secret'), k1)
    expect(() => decrypt(ct, k2)).toThrow(/auth file decryption failed/i)
  })

  it('uses a fresh IV per encryption (nonce-reuse guard)', () => {
    const k = key()
    const a = encrypt(Buffer.from('x'), k)
    const b = encrypt(Buffer.from('x'), k)
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false)
  })
})
