import crypto from 'node:crypto'
import { WHATSAPP_AUTH_ENCRYPTION_KEY } from '../config.js'

const IV_LEN = 12
const TAG_LEN = 16
const ALGO = 'aes-256-gcm'

export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`encrypt: key must be 32 bytes, got ${key.length}`)
  }
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

export function decrypt(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`decrypt: key must be 32 bytes, got ${key.length}`)
  }
  if (ciphertext.length < IV_LEN + TAG_LEN) {
    throw new Error('auth file decryption failed: payload too short')
  }
  const iv = ciphertext.subarray(0, IV_LEN)
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const body = ciphertext.subarray(IV_LEN + TAG_LEN)
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('auth file decryption failed')
  }
}

export function loadEncryptionKey(): Buffer {
  if (!WHATSAPP_AUTH_ENCRYPTION_KEY) {
    throw new Error(
      'WHATSAPP_AUTH_ENCRYPTION_KEY is required to start the Baileys provider. ' +
        'Generate one with: openssl rand -base64 32',
    )
  }
  const buf = Buffer.from(WHATSAPP_AUTH_ENCRYPTION_KEY, 'base64')
  if (buf.length !== 32) {
    throw new Error(
      `WHATSAPP_AUTH_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). ` +
        'Generate one with: openssl rand -base64 32',
    )
  }
  return buf
}
