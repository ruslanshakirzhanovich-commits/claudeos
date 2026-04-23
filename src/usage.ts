export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  contextWindow: number
  compactions: number
  updatedAt: number
}

const chatUsage = new Map<string, SessionUsage>()

interface ModelUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  contextWindow: number
}

export function recordUsage(chatId: string, usage: ModelUsageLike): void {
  const prior = chatUsage.get(chatId)
  chatUsage.set(chatId, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheCreateTokens: usage.cacheCreationInputTokens,
    contextWindow: usage.contextWindow || prior?.contextWindow || 0,
    compactions: prior?.compactions ?? 0,
    updatedAt: Date.now(),
  })
}

export function recordCompaction(chatId: string): void {
  const prior = chatUsage.get(chatId)
  if (prior) {
    prior.compactions += 1
    prior.updatedAt = Date.now()
  } else {
    chatUsage.set(chatId, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      contextWindow: 0,
      compactions: 1,
      updatedAt: Date.now(),
    })
  }
}

export function resetUsage(chatId: string): void {
  chatUsage.delete(chatId)
}

export function getUsage(chatId: string): SessionUsage | null {
  return chatUsage.get(chatId) ?? null
}
