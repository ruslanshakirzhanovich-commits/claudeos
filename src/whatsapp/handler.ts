import { isWhatsAppAuthorised, MAX_MESSAGE_LENGTH } from '../config.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../untrusted.js'
import { splitMessage } from '../format.js'
import { rateLimitMessage } from '../rate-limit.js'
import { runChatPipeline } from '../chat-pipeline.js'
import type { WhatsAppMessage, WhatsAppSendReply } from './types.js'

export async function handleWhatsAppMessage(
  msg: WhatsAppMessage,
  send: WhatsAppSendReply,
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

  const wrappedText = wrapUntrusted(text, 'whatsapp_message', { from: number })
  const result = await runChatPipeline({
    chatId: jid,
    userMessage: text,
    wrappedUserMessage: wrappedText,
    // WhatsApp users are non-admin by design — plan mode: Claude can
    // read/reason, cannot execute shell or edit files.
    permissionMode: 'plan',
    log,
  })

  try {
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
  }
}
