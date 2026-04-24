import { afterEach, describe, it, expect, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp',
  CLAUDE_MODEL: '',
  SUMMARIZE_TIMEOUT_MS: 100,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

const queryImpl: { current: (args: unknown) => AsyncIterable<unknown> } = {
  current: (_args: unknown) => makeNeverYieldingStream(),
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryImpl.current(args),
}))

function makeNeverYieldingStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      await new Promise<void>(() => {})
      yield
    },
  }
}

function makeImmediateResultStream(result: string): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'result', result }
    },
  }
}

function makeAbortingStream(): AsyncIterable<unknown> {
  // Honors AbortController on the options by throwing when abort fires.
  return {
    [Symbol.asyncIterator]: async function* () {
      await new Promise<void>((_, reject) => {
        // Listener is installed by summarizeViaAgentSdk via options.abortController
        // For this test we just hang — the abort path is covered via the
        // never-yielding stream + timeout check.
        setTimeout(() => reject(new Error('AbortError')), 100)
      })
      yield
    },
  }
}

const { summarizeViaAgentSdk } = await import('../src/memory-summarize.js')

afterEach(() => {
  queryImpl.current = (_args: unknown) => makeNeverYieldingStream()
})

describe('summarizeViaAgentSdk timeout', () => {
  it('rejects with "summarize timeout" when the stream never yields', async () => {
    queryImpl.current = (_args: unknown) => makeNeverYieldingStream()
    const start = Date.now()
    await expect(summarizeViaAgentSdk('some text')).rejects.toThrow(/summarize timeout/i)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })

  it('returns normally when the stream yields a result inside the timeout', async () => {
    queryImpl.current = (_args: unknown) => makeImmediateResultStream('happy summary')
    const out = await summarizeViaAgentSdk('some text')
    expect(out).toBe('happy summary')
  })

  it('passes an AbortController in options so the SDK can abort the stream', async () => {
    let capturedOptions: any = null
    queryImpl.current = (args: any) => {
      capturedOptions = args.options
      return makeImmediateResultStream('ok')
    }
    await summarizeViaAgentSdk('text')
    expect(capturedOptions.abortController).toBeInstanceOf(AbortController)
  })

  it('still rejects with timeout even if the stream throws AbortError after timer fires', async () => {
    queryImpl.current = (_args: unknown) => makeAbortingStream()
    await expect(summarizeViaAgentSdk('text')).rejects.toThrow(/summarize timeout/i)
  })
})
