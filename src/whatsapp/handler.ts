import { isWhatsAppAuthorised } from '../config.js'
import { runAgent } from '../agent.js'
import { getSession, setSession } from '../db.js'
import { buildMemoryContext, saveConversationTurn } from '../memory.js'
import { logger } from '../logger.js'
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

  try {
    const memoryContext = await buildMemoryContext(jid, text)
    const messageForAgent = memoryContext ? `${memoryContext}\n\n${text}` : text

    const sessionId = getSession(jid) ?? undefined
    const { text: reply, newSessionId } = await runAgent(messageForAgent, sessionId)

    if (newSessionId && newSessionId !== sessionId) setSession(jid, newSessionId)

    const replyText = reply ?? '(no output)'
    if (reply) await saveConversationTurn(jid, text, reply)

    await send(jid, replyText)
  } catch (err) {
    log.error({ err }, 'handleWhatsAppMessage failed')
    const message = err instanceof Error ? err.message : String(err)
    try {
      await send(jid, `Error: ${message.slice(0, 500)}`)
    } catch {
      /* ignore */
    }
  }
}
