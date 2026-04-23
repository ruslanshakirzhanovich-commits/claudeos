import { beforeEach, describe, it, expect } from 'vitest'
import { recordUsage, recordCompaction, resetUsage, getUsage } from '../src/usage.js'

const CHAT = 'test-chat-usage-9999'

beforeEach(() => resetUsage(CHAT))

describe('usage tracker', () => {
  it('stores the most recent turn with cache + context numbers', () => {
    recordUsage(CHAT, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 29_000,
      cacheCreationInputTokens: 3_000,
      contextWindow: 1_000_000,
    })
    const u = getUsage(CHAT)
    expect(u).not.toBeNull()
    expect(u!.cacheReadTokens).toBe(29_000)
    expect(u!.cacheCreateTokens).toBe(3_000)
    expect(u!.contextWindow).toBe(1_000_000)
    expect(u!.compactions).toBe(0)
  })

  it('preserves compactions across recordUsage (state is per-chat)', () => {
    recordCompaction(CHAT)
    recordCompaction(CHAT)
    recordUsage(CHAT, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
    })
    expect(getUsage(CHAT)!.compactions).toBe(2)
  })

  it('recordCompaction creates a zeroed row when no usage has been recorded yet', () => {
    recordCompaction(CHAT)
    const u = getUsage(CHAT)!
    expect(u.compactions).toBe(1)
    expect(u.inputTokens).toBe(0)
    expect(u.cacheReadTokens).toBe(0)
  })

  it('resetUsage clears all state for the chat', () => {
    recordUsage(CHAT, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 1,
      contextWindow: 200_000,
    })
    recordCompaction(CHAT)
    resetUsage(CHAT)
    expect(getUsage(CHAT)).toBeNull()
  })
})
