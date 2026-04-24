import {
  isWhatsAppAuthorised,
  isWhatsAppNumberAdmin,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from '../config.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../untrusted.js'
import { splitMessage } from '../format.js'
import { rateLimitMessage } from '../rate-limit.js'
import { runChatPipeline } from '../chat-pipeline.js'
import type { WhatsAppMessage, WhatsAppSendReply, WhatsAppSendTyping } from './types.js'

export async function handleWhatsAppMessage(
  msg: WhatsAppMessage,
  send: WhatsAppSendReply,
  sendTyping?: WhatsAppSendTyping,
): Promise<void> {
  const { jid, text, isGroup } = msg
  const log = logger.child({ channel: 'whatsapp', jid, isGroup })

  if (isGroup) {
    log.debug('skipping group message (v1: private only)')
    return
  }

  const number = jid.split('@')[0] ?? ''
  if (!isWhatsAppAuthorised(number)) {
    log.warn({ number }, 'unauthorised whatsapp sender')
    return
  }

  log.info({ preview: text.slice(0, 80) }, 'message received')

  const typingSafe = sendTyping ? (target: string) => sendTyping(target).catch(() => {}) : undefined
  if (typingSafe) await typingSafe(jid)
  const typingInterval = typingSafe
    ? setInterval(() => void typingSafe(jid), TYPING_REFRESH_MS)
    : null

  try {
    const wrappedText = wrapUntrusted(text, 'whatsapp_message', { from: number })
    const result = await runChatPipeline({
      chatId: jid,
      userMessage: text,
      wrappedUserMessage: wrappedText,
      permissionMode: isWhatsAppNumberAdmin(number) ? 'bypassPermissions' : 'plan',
      log,
    })

    if (result.kind === 'rate-limited') {
      await send(jid, rateLimitMessage(result.retryAfterMs))
      return
    }
    if (result.kind === 'error') {
      log.error({ err: result.error }, 'handleWhatsAppMessage failed')
      const message = result.error.message.slice(0, 500)
      await send(jid, `Error: ${message}`)
      return
    }
    const replyText = result.text ?? '(no output)'
    for (const chunk of splitMessage(replyText, MAX_MESSAGE_LENGTH)) {
      await send(jid, chunk)
    }
  } catch (err) {
    log.error({ err }, 'whatsapp send failed')
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
}
