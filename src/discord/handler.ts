import { isDiscordUserAuthorised, isDiscordUserAdmin, TYPING_REFRESH_MS } from '../config.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../untrusted.js'
import { splitMessage } from '../format.js'
import { rateLimitMessage } from '../rate-limit.js'
import { runChatPipeline } from '../chat-pipeline.js'
import { trackInflight } from '../inflight.js'
import { sendAllChunksOrMark } from '../chunked-send.js'
import type { DiscordIncomingMessage, DiscordSendReply, DiscordSendTyping } from './types.js'

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
  sendTyping?: DiscordSendTyping,
): Promise<void> {
  return trackInflight(handleDiscordMessageInner(msg, send, sendTyping))
}

async function handleDiscordMessageInner(
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
  sendTyping?: DiscordSendTyping,
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

  const chatId = chatIdForDiscordUser(msg.userId)
  log.info({ preview: msg.text.slice(0, 80) }, 'message received')

  // Discord's typing indicator lasts ~10s. Refresh on the same cadence as
  // Telegram uses so long agent responses keep showing "typing…" instead of
  // the UI falling silent. Errors are swallowed — if we can't emit typing,
  // the user still gets the reply.
  const typingSafe = sendTyping ? (id: string) => sendTyping(id).catch(() => {}) : undefined
  if (typingSafe) await typingSafe(msg.channelId)
  const typingInterval = typingSafe
    ? setInterval(() => void typingSafe(msg.channelId), TYPING_REFRESH_MS)
    : null

  try {
    const wrappedText = wrapUntrusted(msg.text, 'discord_message', { from: msg.authorTag })
    const result = await runChatPipeline({
      chatId,
      userMessage: msg.text,
      wrappedUserMessage: wrappedText,
      permissionMode: isDiscordUserAdmin(msg.userId) ? 'bypassPermissions' : 'plan',
      log,
    })

    if (result.kind === 'rate-limited') {
      await send(msg.channelId, rateLimitMessage(result.retryAfterMs))
      return
    }
    if (result.kind === 'error') {
      log.error({ err: result.error }, 'handleDiscordMessage failed')
      const message = result.error.message.slice(0, 500)
      await send(msg.channelId, `Error: ${message}`)
      return
    }
    const replyText = result.text ?? '(no output)'
    await sendAllChunksOrMark(chunkForDiscord(replyText), (text) => send(msg.channelId, text), log)
  } catch (err) {
    log.error({ err }, 'discord send failed')
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
}
