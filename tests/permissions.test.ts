import { describe, it, expect } from 'vitest'
import {
  isAdminOf,
  isWhatsAppAuthorisedOf,
  isDiscordUserAdminOf,
  isWhatsAppNumberAdminOf,
} from '../src/config.js'

describe('isAdminOf', () => {
  it('empty admin list denies everyone — never fall back to "allow all"', () => {
    expect(isAdminOf([], '123')).toBe(false)
    expect(isAdminOf([], 123)).toBe(false)
    expect(isAdminOf([], 0)).toBe(false)
  })

  it('matches a known chat id as both string and number', () => {
    expect(isAdminOf(['123', '456'], '123')).toBe(true)
    expect(isAdminOf(['123', '456'], 123)).toBe(true)
    expect(isAdminOf(['123', '456'], '456')).toBe(true)
  })

  it('rejects chat ids not in the admin list', () => {
    expect(isAdminOf(['123'], '999')).toBe(false)
    expect(isAdminOf(['123'], 999)).toBe(false)
  })

  it('treats negative chat ids (group chats) consistently', () => {
    expect(isAdminOf(['-1001'], '-1001')).toBe(true)
    expect(isAdminOf(['-1001'], -1001)).toBe(true)
    expect(isAdminOf(['-1001'], '1001')).toBe(false)
  })

  it('does not do substring matching', () => {
    expect(isAdminOf(['12345'], '1234')).toBe(false)
    expect(isAdminOf(['12345'], '12345678')).toBe(false)
  })
})

describe('isWhatsAppAuthorisedOf', () => {
  it('empty allowlist permits everyone (documented open-mode behavior)', () => {
    expect(isWhatsAppAuthorisedOf([], '491234567')).toBe(true)
    expect(isWhatsAppAuthorisedOf([], '')).toBe(true)
  })

  it('with an allowlist, only listed numbers pass', () => {
    expect(isWhatsAppAuthorisedOf(['491234567'], '491234567')).toBe(true)
    expect(isWhatsAppAuthorisedOf(['491234567'], '15551234567')).toBe(false)
  })
})

describe('isDiscordUserAdminOf', () => {
  it('empty admin list denies everyone — no fallback to allowlist', () => {
    // Intentionally different from Telegram (which falls back to the
    // first ALLOWED_CHAT_ID). Discord runs in open mode by default, so
    // auto-admining "whoever messages first" would be a real footgun.
    expect(isDiscordUserAdminOf([], '987654321')).toBe(false)
  })

  it('matches only exact snowflake strings', () => {
    expect(isDiscordUserAdminOf(['987654321'], '987654321')).toBe(true)
    expect(isDiscordUserAdminOf(['987654321'], '98765432')).toBe(false)
    expect(isDiscordUserAdminOf(['987654321'], '9876543210')).toBe(false)
  })
})

describe('isWhatsAppNumberAdminOf', () => {
  it('empty admin list denies everyone', () => {
    expect(isWhatsAppNumberAdminOf([], '491234567')).toBe(false)
  })

  it('matches listed numbers exactly', () => {
    expect(isWhatsAppNumberAdminOf(['491234567'], '491234567')).toBe(true)
    expect(isWhatsAppNumberAdminOf(['491234567'], '49123456')).toBe(false)
  })
})
