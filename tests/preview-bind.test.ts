import { describe, it, expect } from 'vitest'
import { resolvePreviewBind } from '../src/config.js'

describe('resolvePreviewBind', () => {
  it('defaults to 127.0.0.1 when PREVIEW_HOST is empty and password is empty', () => {
    expect(resolvePreviewBind('', '')).toEqual({ host: '127.0.0.1' })
  })

  it('accepts explicit loopback hosts without a password', () => {
    expect(resolvePreviewBind('127.0.0.1', '')).toEqual({ host: '127.0.0.1' })
    expect(resolvePreviewBind('localhost', '')).toEqual({ host: 'localhost' })
    expect(resolvePreviewBind('::1', '')).toEqual({ host: '::1' })
  })

  it('refuses to bind publicly without a password', () => {
    expect(() => resolvePreviewBind('0.0.0.0', '')).toThrow(/PREVIEW_PASSWORD/)
    expect(() => resolvePreviewBind('10.0.0.5', '')).toThrow(/PREVIEW_PASSWORD/)
    expect(() => resolvePreviewBind('203.0.113.1', '')).toThrow(/PREVIEW_PASSWORD/)
  })

  it('allows any host once a password is set', () => {
    expect(resolvePreviewBind('0.0.0.0', 'secret')).toEqual({ host: '0.0.0.0' })
    expect(resolvePreviewBind('10.0.0.5', 'secret')).toEqual({ host: '10.0.0.5' })
  })

  it('treats whitespace-only hosts as empty and falls back to loopback', () => {
    expect(resolvePreviewBind('  ', '')).toEqual({ host: '127.0.0.1' })
  })
})
