import { isWhatsAppAuthorised } from '../config.js'
import { runAgent } from '../agent.js'
import { getSession, setSession, getEffortLevel, getPreferredModel } from '../db.js'
import { buildMemoryContext, saveConversationTurn } from '../memory.js'
import { logger } from '../logger.js'
import { wrapUntrusted } from '../untrusted.js'
import { CHAT_DEFAULT_EFFORT, isEffortLevel } from '../effort.js'
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
    const wrappedText = wrapUntrusted(text, 'whatsapp_message', { from: number })
    const messageForAgent = memoryContext ? `${memoryContext}\n\n${wrappedText}` : wrappedText

    const sessionId = getSession(jid) ?? undefined
    const model = getPreferredModel(jid) ?? undefined
    const storedEffort = getEffortLevel(jid)
    const effort = isEffortLevel(storedEffort) ? storedEffort : CHAT_DEFAULT_EFFORT
    // WhatsApp users are non-admin by design — no ADMIN_WHATSAPP_NUMBERS concept yet.
    // They get `plan` mode: Claude can read/reason, cannot execute shell or edit files.
    const { text: reply, newSessionId } = await runAgent(messageForAgent, { sessionId, permissionMode: 'plan', log, model, effort, chatId: jid })

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
