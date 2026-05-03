import { isDiscordUserAuthorised, isDiscordUserAdmin, TYPING_REFRESH_MS } from '../config.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../untrusted.js'
import { splitMessage } from '../format.js'
import { rateLimitMessage } from '../rate-limit.js'
import { runChatPipeline } from '../chat-pipeline.js'
import { trackInflight } from '../inflight.js'
import { sendAllChunksOrMark } from '../chunked-send.js'
import { isOpenMode, addUserChat } from '../users.js'
import { DiscordStreamer } from './discord-streamer.js'
import type { DiscordIncomingMessage, DiscordSendReply, DiscordSendTyping, DiscordStreamingCallbacks } from './types.js'

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
  streaming?: DiscordStreamingCallbacks,
): Promise<void> {
  return trackInflight(handleDiscordMessageInner(msg, send, sendTyping, streaming))
}

async function handleDiscordMessageInner(
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
  sendTyping?: DiscordSendTyping,
  streaming?: DiscordStreamingCallbacks,
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
  // Open-mode auto-add: same behaviour as Telegram's handleMessage.
  if (isOpenMode()) {
    log.warn({ author: msg.authorTag }, 'OPEN MODE accepted new discord chat')
    addUserChat({
      chatId,
      channel: 'discord',
      addedBy: 'open-mode',
      note: `auto-added from ${msg.authorTag}`,
    })
  }
  log.info({ preview: msg.text.slice(0, 80) }, 'message received')

  const typingSafe = sendTyping ? (id: string) => sendTyping(id).catch(() => {}) : undefined
  if (typingSafe) await typingSafe(msg.channelId)

  const permissionMode = isDiscordUserAdmin(msg.userId) ? 'bypassPermissions' : 'plan'
  const wrappedText = wrapUntrusted(msg.text, 'discord_message', { from: msg.authorTag })

  // Streaming path when callbacks are available
  if (streaming) {
    const abortController = new AbortController()
    const channelProxy = {
      send: async (text: string) => {
        const m = await streaming.sendReturning(msg.channelId, text)
        return { edit: m.edit }
      },
    }
    const streamer = new DiscordStreamer()
    await streamer.start(channelProxy as any)

    try {
      const result = await runChatPipeline({
        chatId,
        userMessage: msg.text,
        wrappedUserMessage: wrappedText,
        permissionMode,
        log,
        onTextDelta: (d) => streamer.onText(d),
        onToolUse: () => streamer.onToolUse(),
        abortController,
      })
      if (result.kind === 'rate-limited') {
        await streamer.finalize(null)
        await streaming.sendNew(msg.channelId, rateLimitMessage(result.retryAfterMs))
        return
      }
      if (result.kind === 'error') {
        log.error({ err: result.error }, 'handleDiscordMessage failed')
        await streamer.finalize(null)
        await streaming.sendNew(msg.channelId, `Error: ${result.error.message.slice(0, 500)}`)
        return
      }
      await streamer.finalize(result.text)
    } catch (err) {
      if (abortController.signal.aborted) {
        await streamer.finalize(null, true)
      } else {
        log.error({ err }, 'discord streaming failed')
        await streamer.finalize(null)
        await streaming.sendNew(msg.channelId, `Error: ${(err as Error).message?.slice(0, 500) ?? 'Unknown error'}`)
      }
    }
    return
  }

  // Non-streaming fallback
  // Discord's typing indicator lasts ~10s. Refresh on the same cadence as
  // Telegram uses so long agent responses keep showing "typing…" instead of
  // the UI falling silent. Errors are swallowed — if we can't emit typing,
  // the user still gets the reply.
  const typingInterval = typingSafe
    ? setInterval(() => void typingSafe(msg.channelId), TYPING_REFRESH_MS)
    : null

  try {
    const result = await runChatPipeline({
      chatId,
      userMessage: msg.text,
      wrappedUserMessage: wrappedText,
      permissionMode,
      log,
    })
    if (result.kind === 'rate-limited') {
      await send(msg.channelId, rateLimitMessage(result.retryAfterMs))
      return
    }
    if (result.kind === 'error') {
      log.error({ err: result.error }, 'handleDiscordMessage failed')
      await send(msg.channelId, `Error: ${result.error.message.slice(0, 500)}`)
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
