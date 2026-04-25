import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp',
  CLAUDE_MODEL: '',
  CLAUDE_DEFAULT_EFFORT: '',
  AGENT_RETRY_ATTEMPTS: 1,
  AGENT_RETRY_BASE_MS: 10,
  AGENT_MAX_TURNS: 25,
  AGENT_STREAM_TIMEOUT_MS: 30_000,
  EFFORT_TOKENS_LOW: 2048,
  EFFORT_TOKENS_MEDIUM: 8192,
  EFFORT_TOKENS_HIGH: 24576,
  EFFORT_TOKENS_XHIGH: 65536,
}))

const startTimes: number[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: async function* () {
      startTimes.push(Date.now())
      await new Promise((r) => setTimeout(r, 50))
      yield { type: 'system', subtype: 'init', session_id: 's' }
      yield { type: 'result', result: 'ok' }
    },
  }),
}))

const { runAgent } = await import('../src/agent.js')

describe('runAgent does not self-serialize per chatId', () => {
  it('two parallel calls for the same chatId start within a few ms of each other', async () => {
    startTimes.length = 0

    const [a, b] = await Promise.all([
      runAgent('m1', { permissionMode: 'plan', chatId: 'X' }),
      runAgent('m2', { permissionMode: 'plan', chatId: 'X' }),
    ])

    expect(a.text).toBe('ok')
    expect(b.text).toBe('ok')

    expect(startTimes).toHaveLength(2)
    const delta = Math.abs(startTimes[1]! - startTimes[0]!)
    expect(delta).toBeLessThan(20)
  })
})
