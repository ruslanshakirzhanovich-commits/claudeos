import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { sendAllChunksOrMark } = await import('../src/chunked-send.js')

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
} as any

describe('sendAllChunksOrMark', () => {
  it('sends all chunks in order when send always succeeds', async () => {
    const sent: string[] = []
    const send = vi.fn(async (t: string) => {
      sent.push(t)
    })

    await sendAllChunksOrMark(['a', 'b', 'c'], send, noopLog)

    expect(sent).toEqual(['a', 'b', 'c'])
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('appends a truncation marker when a chunk fails after retries', async () => {
    const sent: string[] = []
    const send = vi.fn(async (t: string) => {
      sent.push(t)
      if (t === 'c2') throw Object.assign(new Error('network dead'), { code: 'ECONNRESET' })
    })

    await sendAllChunksOrMark(['c0', 'c1', 'c2', 'c3', 'c4'], send, noopLog)

    expect(sent.filter((s) => s === 'c0')).toHaveLength(1)
    expect(sent.filter((s) => s === 'c1')).toHaveLength(1)
    expect(sent.filter((s) => s === 'c2')).toHaveLength(3)
    expect(sent.filter((s) => s === 'c3')).toHaveLength(0)
    expect(sent.filter((s) => s === 'c4')).toHaveLength(0)
    const marker = sent.find((s) => /truncated/.test(s))
    expect(marker).toMatch(/3 chunk\(s\) lost/)
  })

  it('swallows a marker-send failure rather than throwing', async () => {
    let attempts = 0
    const send = vi.fn(async (_t: string) => {
      attempts++
      throw Object.assign(new Error('always down'), { code: 'ECONNRESET' })
    })

    await expect(sendAllChunksOrMark(['only'], send, noopLog)).resolves.toBeUndefined()
    expect(attempts).toBe(4)
  })
})
