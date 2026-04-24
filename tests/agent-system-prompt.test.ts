import { beforeEach, describe, it, expect, vi } from 'vitest'

const querySpy = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => querySpy(...args),
}))

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp/claudeos-test',
  CLAUDE_MODEL: '',
  AGENT_RETRY_ATTEMPTS: 1,
  AGENT_RETRY_BASE_MS: 1,
  AGENT_MAX_TURNS: 25,
  AGENT_STREAM_TIMEOUT_MS: 60_000,
}))

vi.mock('../src/logger.js', () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l }
  return { logger: l }
})

vi.mock('../src/inflight.js', () => ({
  trackInflight: <T>(p: Promise<T>) => p,
}))

vi.mock('../src/chat-queue.js', () => ({
  runSerialPerChat: <T>(_id: string, fn: () => Promise<T>) => fn(),
}))

vi.mock('../src/metrics.js', () => ({
  recordEvent: () => {},
}))

vi.mock('../src/effort.js', () => ({
  effortToThinkingTokens: (e: string) => (e === 'high' ? 24576 : 8192),
  isEffortLevel: (e: unknown) =>
    typeof e === 'string' && ['low', 'medium', 'high', 'xhigh'].includes(e),
}))

vi.mock('../src/usage.js', () => ({
  recordUsage: () => {},
  recordCompaction: () => {},
}))

function makeEmptyStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', result: 'ok', session_id: 'sess-x' }
    },
  }
}

const { runAgent } = await import('../src/agent.js')

beforeEach(() => {
  querySpy.mockReset()
  querySpy.mockReturnValue(makeEmptyStream())
})

describe('runAgent systemPrompt wiring', () => {
  it('passes CLAUDE.md through settingSources, not duplicated into the user prompt', async () => {
    await runAgent('hello world', { permissionMode: 'plan' })

    expect(querySpy).toHaveBeenCalledTimes(1)
    const call = querySpy.mock.calls[0]![0] as { prompt: string; options: Record<string, unknown> }

    // User prompt stays clean — no injected "You MUST follow these instructions"
    expect(call.prompt).toBe('hello world')
    expect(call.prompt).not.toMatch(/You MUST follow these instructions/)
    expect(call.prompt).not.toMatch(/identity and personality/)

    // settingSources must include 'project' so the SDK picks up CLAUDE.md itself
    expect(call.options['settingSources']).toEqual(expect.arrayContaining(['project']))
  })

  it('uses the claude_code preset so the SDK loads CLAUDE.md into the cached system prompt', async () => {
    await runAgent('hi', { permissionMode: 'plan' })

    const call = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    const sys = call.options['systemPrompt'] as { type: string; preset: string } | undefined
    expect(sys).toBeDefined()
    expect(sys!.type).toBe('preset')
    expect(sys!.preset).toBe('claude_code')
  })

  it('appends the active model instruction to the system prompt instead of the user prompt', async () => {
    await runAgent('hi', { permissionMode: 'plan', model: 'claude-sonnet-4-6' })

    const call = querySpy.mock.calls[0]![0] as { prompt: string; options: Record<string, unknown> }

    // Model hint lives in the system prompt (cacheable), not the user prompt
    expect(call.prompt).toBe('hi')
    expect(call.prompt).not.toMatch(/model id/i)

    const sys = call.options['systemPrompt'] as { append?: string } | undefined
    expect(sys?.append ?? '').toMatch(/claude-sonnet-4-6/)
  })

  it('omits the append when no model override is active', async () => {
    await runAgent('hi', { permissionMode: 'plan' })

    const call = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    const sys = call.options['systemPrompt'] as { append?: string } | undefined
    // Either no append at all, or an empty append — both are fine. Key thing:
    // no garbage model-id string leaks into the cached system prompt when
    // the user hasn't pinned a model.
    if (sys?.append) {
      expect(sys.append).not.toMatch(/model id/i)
    }
  })
})
