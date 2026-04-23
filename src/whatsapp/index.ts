import { WHATSAPP_ENABLED, WHATSAPP_PROVIDER } from '../config.js'
import { logger } from '../logger.js'
import { createBaileysClient } from './baileys.js'
import { createMetaClient } from './meta.js'
import { handleWhatsAppMessage } from './handler.js'
import type { WhatsAppClient } from './types.js'

let active: WhatsAppClient | null = null

export async function initWhatsApp(): Promise<WhatsAppClient | null> {
  if (!WHATSAPP_ENABLED) {
    logger.debug('WhatsApp disabled (WHATSAPP_ENABLED != 1)')
    return null
  }

  let client: WhatsAppClient
  switch (WHATSAPP_PROVIDER) {
    case 'baileys':
      client = createBaileysClient()
      break
    case 'meta':
      client = createMetaClient()
      break
    default:
      throw new Error(`Unknown WHATSAPP_PROVIDER: ${WHATSAPP_PROVIDER}`)
  }

  client.onMessage(handleWhatsAppMessage)
  await client.start()
  active = client
  logger.info({ provider: WHATSAPP_PROVIDER }, 'WhatsApp client started')
  return client
}

export async function stopWhatsApp(): Promise<void> {
  if (!active) return
  try {
    await active.stop()
  } catch {
    /* ignore */
  }
  active = null
}

// Non-reply outbound send (scheduler, cross-channel routing). Throws if the
// client isn't running, so the caller can decide whether to skip, retry, or
// annotate the scheduled task as "channel unavailable".
export async function sendToWhatsAppJid(jid: string, text: string): Promise<void> {
  if (!active) throw new Error('WhatsApp client not available (disabled or not yet connected)')
  await active.sendText(jid, text)
}
