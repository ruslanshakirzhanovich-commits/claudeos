// Per-chat serialization. Two messages from the same chat must not call
// the agent SDK concurrently: both would resume the same session id and
// race to persist a (possibly different) newSessionId via setSession.
// Different chats run independently.

const tails = new Map<string, Promise<unknown>>()

export function runSerialPerChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(chatId) ?? Promise.resolve()
  // Don't let an earlier failure break the chain for later callers.
  const next = prev.catch(() => {}).then(fn)
  // Tail intentionally swallows its own result — it's just a sequencing token.
  const tail: Promise<void> = next.then(
    () => {},
    () => {},
  )
  tails.set(chatId, tail)
  tail.then(() => {
    if (tails.get(chatId) === tail) tails.delete(chatId)
  })
  return next
}

export function chatQueueDepth(): number {
  return tails.size
}

export function resetChatQueuesForTest(): void {
  tails.clear()
}
