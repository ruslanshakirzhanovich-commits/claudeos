import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'

// Realistic fixture of the event sequence the Claude Agent SDK emits for a
// single query that involves one tool call and completes with a result. This
// is an e2e-style test for runAgent: it drives the function with a recorded
// stream and verifies the full parse pipeline — session extraction, usage
// aggregation, compaction detection, text extraction, model-usage math —
// without hitting the real SDK or the network.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-e2e-'))
const dbFile = path.join(tmpDir, 'claudeclaw.db')

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: tmpDir,
  STORE_DIR: tmpDir,
  DB_PATH: dbFile,
  CLAUDE_MODEL: '',
  AGENT_RETRY_ATTEMPTS: 1,
  AGENT_RETRY_BASE_MS: 1,
  AGENT_MAX_TURNS: 25,
  AGENT_STREAM_TIMEOUT_MS: 60_000,
}))

const querySpy = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => querySpy(...args),
}))

vi.mock('../src/logger.js', () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l }
  return { logger: l }
})

vi.mock('../src/inflight.js', () => ({ trackInflight: <T>(p: Promise<T>) => p }))
vi.mock('../src/chat-queue.js', () => ({
  runSerialPerChat: <T>(_: string, fn: () => Promise<T>) => fn(),
}))
vi.mock('../src/metrics.js', () => ({ recordEvent: () => {} }))
vi.mock('../src/effort.js', () => ({
  effortToThinkingTokens: () => 8192,
  isEffortLevel: (e: unknown) => typeof e === 'string',
}))

const { initDatabase, closeDb } = await import('../src/db.js')
const { resetUsage, getUsage } = await import('../src/usage.js')
initDatabase()

const { runAgent } = await import('../src/agent.js')

beforeEach(() => {
  resetUsage('chat-e2e')
  querySpy.mockReset()
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// Minimal but realistic subset of the SDK event protocol as emitted by
// @anthropic-ai/claude-agent-sdk v0.1. Shapes follow what agent.ts already
// branches on in production: system init → system compact_boundary → result.
function recordedStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev
    },
  }
}

describe('runAgent — recorded SDK stream e2e', () => {
  it('extracts session_id, text, and model usage from a normal completion', async () => {
    querySpy.mockReturnValue(
      recordedStream([
        { type: 'system', subtype: 'init', session_id: 'sess-abc', model: 'claude-sonnet-4-6' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'partial…' }] } },
        {
          type: 'result',
          result: 'final answer to the user',
          session_id: 'sess-abc',
          modelUsage: {
            'claude-sonnet-4-6': {
              inputTokens: 1_200,
              outputTokens: 380,
              cacheReadInputTokens: 8_500,
              cacheCreationInputTokens: 0,
              contextWindow: 200_000,
            },
          },
        },
      ]),
    )

    const result = await runAgent('hi', { permissionMode: 'plan', chatId: 'chat-e2e' })
    expect(result.text).toBe('final answer to the user')
    expect(result.newSessionId).toBe('sess-abc')

    const usage = getUsage('chat-e2e')!
    expect(usage.inputTokens).toBe(1_200)
    expect(usage.outputTokens).toBe(380)
    expect(usage.cacheReadTokens).toBe(8_500)
    expect(usage.contextWindow).toBe(200_000)
    expect(usage.compactions).toBe(0)
  })

  it('counts compact_boundary events even when the SDK continues afterwards', async () => {
    querySpy.mockReturnValue(
      recordedStream([
        { type: 'system', subtype: 'init', session_id: 'sess-c' },
        { type: 'system', subtype: 'compact_boundary' },
        { type: 'result', result: 'post-compact reply', session_id: 'sess-c' },
      ]),
    )

    const result = await runAgent('long convo', { permissionMode: 'plan', chatId: 'chat-e2e' })
    expect(result.text).toBe('post-compact reply')
    const usage = getUsage('chat-e2e')!
    expect(usage.compactions).toBe(1)
  })

  it('aggregates modelUsage across multiple models reported in one result', async () => {
    querySpy.mockReturnValue(
      recordedStream([
        { type: 'system', subtype: 'init', session_id: 'sess-m' },
        {
          type: 'result',
          result: 'mixed-model reply',
          session_id: 'sess-m',
          modelUsage: {
            'claude-opus-4-7': {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 100_000,
            },
            'claude-haiku-4-5': {
              inputTokens: 40,
              outputTokens: 20,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 200_000,
            },
          },
        },
      ]),
    )

    await runAgent('hi', { permissionMode: 'plan', chatId: 'chat-e2e' })
    const usage = getUsage('chat-e2e')!
    expect(usage.inputTokens).toBe(140) // 100 + 40
    expect(usage.outputTokens).toBe(70) // 50 + 20
    expect(usage.contextWindow).toBe(200_000) // Math.max(100k, 200k)
  })

  it('handles a result where text is wrapped as event.result.result (object form)', async () => {
    querySpy.mockReturnValue(
      recordedStream([
        { type: 'system', subtype: 'init', session_id: 'sess-o' },
        {
          type: 'result',
          result: { result: 'unwrapped from object form', other: 'meta' },
          session_id: 'sess-o',
        },
      ]),
    )

    const result = await runAgent('hi', { permissionMode: 'plan', chatId: 'chat-e2e' })
    expect(result.text).toBe('unwrapped from object form')
  })

  it('returns null text when the stream ends without a result event (stream cut short)', async () => {
    querySpy.mockReturnValue(
      recordedStream([{ type: 'system', subtype: 'init', session_id: 'sess-cut' }]),
    )

    const result = await runAgent('hi', { permissionMode: 'plan', chatId: 'chat-e2e' })
    expect(result.text).toBeNull()
    expect(result.newSessionId).toBe('sess-cut')
  })
})
