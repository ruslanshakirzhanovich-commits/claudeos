import { describe, it, expect } from 'vitest'
import { resolveActiveModel } from '../src/commands/models.js'

describe('resolveActiveModel', () => {
  it('falls back to the first model when env is empty', () => {
    const r = resolveActiveModel('')
    expect(r.explicit).toBe(false)
    expect(r.id).toMatch(/^claude-/)
  })

  it('resolves short aliases case-insensitively', () => {
    expect(resolveActiveModel('opus').id).toBe('claude-opus-4-7')
    expect(resolveActiveModel('OPUS').id).toBe('claude-opus-4-7')
    expect(resolveActiveModel('sonnet').id).toBe('claude-sonnet-4-6')
    expect(resolveActiveModel('haiku').id).toBe('claude-haiku-4-5-20251001')
  })

  it('passes full model ids through verbatim when recognised', () => {
    expect(resolveActiveModel('claude-opus-4-7').id).toBe('claude-opus-4-7')
    expect(resolveActiveModel('claude-opus-4-7').explicit).toBe(true)
  })

  it('passes unknown ids through — do not blow up on a typo', () => {
    const r = resolveActiveModel('claude-experimental-xyz')
    expect(r.id).toBe('claude-experimental-xyz')
    expect(r.explicit).toBe(true)
  })
})
