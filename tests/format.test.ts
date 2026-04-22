import { describe, it, expect } from 'vitest'
import { formatForTelegram, splitMessage, parseChangelog } from '../src/bot.js'

describe('formatForTelegram', () => {
  it('escapes HTML-special chars in plain text', () => {
    expect(formatForTelegram('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('wraps fenced code in <pre>', () => {
    expect(formatForTelegram('```js\nconst x = 1\n```')).toBe('<pre>const x = 1\n</pre>')
  })

  it('wraps inline code in <code> and escapes inside', () => {
    expect(formatForTelegram('use `a<b>` here')).toBe('use <code>a&lt;b&gt;</code> here')
  })

  it('converts **bold** and _italic_', () => {
    expect(formatForTelegram('**big** _small_')).toBe('<b>big</b> <i>small</i>')
  })

  it('converts markdown links', () => {
    expect(formatForTelegram('[home](https://example.com)')).toBe(
      '<a href="https://example.com">home</a>',
    )
  })

  it('returns empty for empty input', () => {
    expect(formatForTelegram('')).toBe('')
  })
})

describe('splitMessage', () => {
  it('keeps short messages as a single chunk', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('splits on newline boundary when possible', () => {
    const text = 'line1\nline2\nline3'
    const chunks = splitMessage(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).not.toContain('  ')
  })

  it('no chunk exceeds the limit', () => {
    const text = 'a'.repeat(5000)
    const chunks = splitMessage(text, 100)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
  })
})

describe('parseChangelog', () => {
  it('parses the latest N versions', () => {
    const md = `# Changelog

## [1.2.0] - 2026-04-22
- feature a
- feature b

## [1.1.0] - 2026-04-21
- feature c

## [1.0.0] - 2026-04-20
- initial
`
    const entries = parseChangelog(md, 2)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.version).toBe('1.2.0')
    expect(entries[0]?.bullets).toEqual(['feature a', 'feature b'])
    expect(entries[1]?.version).toBe('1.1.0')
  })

  it('returns [] on empty input', () => {
    expect(parseChangelog('', 2)).toEqual([])
  })
})
