import crypto from 'node:crypto'

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
