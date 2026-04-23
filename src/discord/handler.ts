import { isDiscordUserAuthorised } from '../config.js'
import { runAgent } from '../agent.js'
import { getSession, setSession, getEffortLevel, getPreferredModel } from '../db.js'
import { buildMemoryContext, saveConversationTurn } from '../memory.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../untrusted.js'
import { CHAT_DEFAULT_EFFORT, isEffortLevel } from '../effort.js'
import { splitMessage } from '../format.js'
import type { DiscordIncomingMessage, DiscordSendReply } from './types.js'

const CHAT_ID_PREFIX = 'discord:'
const DISCORD_MESSAGE_LIMIT = 2000

export function chatIdForDiscordUser(userId: string): string {
  return CHAT_ID_PREFIX + userId
}

export function chunkForDiscord(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  return splitMessage(text, limit)
}

export async function handleDiscordMessage(
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
): Promise<void> {
  const log = logger.child({ channel: 'discord', userId: msg.userId, isDM: msg.isDM })

  if (!msg.isDM) {
    log.debug('skipping non-DM message (v1: DMs only)')
    return
  }
  if (!isDiscordUserAuthorised(msg.userId)) {
    log.warn({ author: msg.authorTag }, 'unauthorised discord sender')
    return
  }

  log.info({ preview: msg.text.slice(0, 80) }, 'message received')

  const chatId = chatIdForDiscordUser(msg.userId)
  try {
    const memoryContext = await buildMemoryContext(chatId, msg.text)
    const wrappedText = wrapUntrusted(msg.text, 'discord_message', { from: msg.authorTag })
    const messageForAgent = memoryContext ? `${memoryContext}\n\n${wrappedText}` : wrappedText

    const sessionId = getSession(chatId) ?? undefined
    const model = getPreferredModel(chatId) ?? undefined
    const storedEffort = getEffortLevel(chatId)
    const effort = isEffortLevel(storedEffort) ? storedEffort : CHAT_DEFAULT_EFFORT
    // Discord users get plan mode (read/reason, no shell/edits) — same
    // posture as WhatsApp. No ADMIN_DISCORD_USERS concept yet.
    const { text: reply, newSessionId } = await runAgent(messageForAgent, {
      sessionId,
      permissionMode: 'plan',
      log,
      model,
      effort,
      chatId,
    })

    if (newSessionId && newSessionId !== sessionId) setSession(chatId, newSessionId)

    const replyText = reply ?? '(no output)'
    if (reply) await saveConversationTurn(chatId, msg.text, reply)

    for (const chunk of chunkForDiscord(replyText)) {
      await send(msg.channelId, chunk)
    }
  } catch (err) {
    log.error({ err }, 'handleDiscordMessage failed')
    const message = err instanceof Error ? err.message : String(err)
    try {
      await send(msg.channelId, `Error: ${message.slice(0, 500)}`)
    } catch {
      /* ignore */
    }
  }
}
