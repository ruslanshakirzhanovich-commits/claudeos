import { runAgent, type PermissionMode } from './agent.js'
import { getSession, setSession, getEffortLevel, getPreferredModel } from './db.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { CHAT_DEFAULT_EFFORT, isEffortLevel } from './effort.js'
import { tryConsume } from './rate-limit.js'
import { runSerialPerChat } from './chat-queue.js'
import type { Logger } from './logger.js'

export interface ChatTurnInput {
  chatId: string
  // Original user text (used for memory indexing and conversation logging).
  userMessage: string
  // Same text, but wrapped with wrapUntrusted() by the caller. Each
  // channel knows its own envelope shape (telegram_text, discord_message,
  // whatsapp_message) so we don't hardcode that here.
  wrappedUserMessage: string
  permissionMode: PermissionMode
  log: Logger
}

export type ChatTurnResult =
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'ok'; text: string | null }
  | { kind: 'error'; error: Error }

export async function runChatPipeline(input: ChatTurnInput): Promise<ChatTurnResult> {
  const rl = tryConsume(input.chatId)
  if (!rl.ok) {
    input.log.warn({ retryAfterMs: rl.retryAfterMs }, 'rate limited')
    return { kind: 'rate-limited', retryAfterMs: rl.retryAfterMs }
  }
  return runSerialPerChat(input.chatId, async (): Promise<ChatTurnResult> => {
    try {
      const memoryContext = await buildMemoryContext(input.chatId, input.userMessage)
      const messageForAgent = memoryContext
        ? `${memoryContext}\n\n${input.wrappedUserMessage}`
        : input.wrappedUserMessage
      const sessionId = getSession(input.chatId) ?? undefined
      const model = getPreferredModel(input.chatId) ?? undefined
      const storedEffort = getEffortLevel(input.chatId)
      const effort = isEffortLevel(storedEffort) ? storedEffort : CHAT_DEFAULT_EFFORT
      const { text, newSessionId } = await runAgent(messageForAgent, {
        sessionId,
        permissionMode: input.permissionMode,
        log: input.log,
        model,
        effort,
        chatId: input.chatId,
      })
      if (newSessionId && newSessionId !== sessionId) setSession(input.chatId, newSessionId)
      if (text) await saveConversationTurn(input.chatId, input.userMessage, text)
      return { kind: 'ok', text }
    } catch (err) {
      return { kind: 'error', error: err as Error }
    }
  })
}
