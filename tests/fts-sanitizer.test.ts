import { describe, it, expect } from 'vitest'
import { sanitizeFtsQuery } from '../src/memory.js'

describe('sanitizeFtsQuery', () => {
  it('builds a prefix-OR query from basic latin tokens', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('hello* OR world*')
  })

  it('accepts two-char Cyrillic tokens (previously silently dropped)', () => {
    const q = sanitizeFtsQuery('что с бд и cs')
    // The important two-char tokens survive; the one-char "с" and "и" don't.
    expect(q).toContain('бд*')
    expect(q).toContain('cs*')
    expect(q).toContain('что*')
  })

  it('drops single-character tokens (would match too much)', () => {
    expect(sanitizeFtsQuery('a b c hello')).toBe('hello*')
  })

  it('strips FTS5 MATCH operators so they cannot break the query', () => {
    // "OR" / "AND" in user input would otherwise combine with our own OR
    // connector and produce a syntax error or unintended grouping.
    expect(sanitizeFtsQuery('red OR blue')).toBe('red* OR blue*')
    expect(sanitizeFtsQuery('foo AND bar')).toBe('foo* OR bar*')
    expect(sanitizeFtsQuery('a NEAR b')).toBe('')
  })

  it('strips punctuation that FTS5 would otherwise reject', () => {
    expect(sanitizeFtsQuery('hello, world!')).toBe('hello* OR world*')
    expect(sanitizeFtsQuery('"quoted"')).toBe('quoted*')
  })

  it('caps at 6 tokens (up from the previous 5) for longer prompts', () => {
    const q = sanitizeFtsQuery('one two three four five six seven eight')
    const parts = q.split(' OR ')
    expect(parts).toHaveLength(6)
  })

  it('returns an empty string when nothing survives sanitization', () => {
    expect(sanitizeFtsQuery('')).toBe('')
    expect(sanitizeFtsQuery('!!! . ? ;')).toBe('')
    expect(sanitizeFtsQuery('a b c')).toBe('')
  })
})
