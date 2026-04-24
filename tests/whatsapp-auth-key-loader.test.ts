import { describe, it, expect, beforeEach, vi } from 'vitest'

const configMock: { WHATSAPP_AUTH_ENCRYPTION_KEY: string } = {
  WHATSAPP_AUTH_ENCRYPTION_KEY: '',
}

vi.mock('../src/config.js', () => ({
  get WHATSAPP_AUTH_ENCRYPTION_KEY() {
    return configMock.WHATSAPP_AUTH_ENCRYPTION_KEY
  },
}))

const { loadEncryptionKey } = await import('../src/whatsapp/auth-encryption.js')

beforeEach(() => {
  configMock.WHATSAPP_AUTH_ENCRYPTION_KEY = ''
})

describe('loadEncryptionKey', () => {
  it('throws a helpful error when the env var is missing', () => {
    configMock.WHATSAPP_AUTH_ENCRYPTION_KEY = ''
    expect(() => loadEncryptionKey()).toThrow(/WHATSAPP_AUTH_ENCRYPTION_KEY is required/)
  })

  it('throws when the base64 decodes to the wrong length', () => {
    configMock.WHATSAPP_AUTH_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64')
    expect(() => loadEncryptionKey()).toThrow(/32 bytes/)
  })

  it('returns a 32-byte Buffer for a valid base64 key', () => {
    const raw = Buffer.alloc(32, 0xab)
    configMock.WHATSAPP_AUTH_ENCRYPTION_KEY = raw.toString('base64')
    const buf = loadEncryptionKey()
    expect(buf.length).toBe(32)
    expect(buf.equals(raw)).toBe(true)
  })
})
