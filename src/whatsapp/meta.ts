import http from 'node:http'
import crypto from 'node:crypto'
import {
  WHATSAPP_META_ACCESS_TOKEN,
  WHATSAPP_META_PHONE_NUMBER_ID,
  WHATSAPP_META_VERIFY_TOKEN,
  WHATSAPP_META_APP_SECRET,
  WHATSAPP_META_WEBHOOK_PORT,
  WHATSAPP_META_GRAPH_VERSION,
  WHATSAPP_META_WEBHOOK_PATH,
} from '../config.js'
import { logger } from '../logger.js'
import { withRetry } from '../retry.js'
import type { WhatsAppClient, WhatsAppMessage, WhatsAppMessageHandler, WhatsAppSendReply } from './types.js'

interface MetaMessageValue {
  messages?: Array<{
    from: string
    id: string
    timestamp: string
    type: string
    text?: { body: string }
  }>
  metadata?: { phone_number_id?: string }
}

interface MetaPayload {
  object?: string
  entry?: Array<{
    id?: string
    changes?: Array<{
      value: MetaMessageValue
      field?: string
    }>
  }>
}

function verifySignature(body: Buffer, signatureHeader: string | undefined): boolean {
  if (!WHATSAPP_META_APP_SECRET) {
    logger.warn('WHATSAPP_META_APP_SECRET not set — skipping signature verification (INSECURE in production)')
    return true
  }
  if (!signatureHeader) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_META_APP_SECRET).update(body).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    return false
  }
}

function extractMessages(payload: MetaPayload): WhatsAppMessage[] {
  const out: WhatsAppMessage[] = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue
      for (const msg of change.value.messages ?? []) {
        if (msg.type !== 'text' || !msg.text?.body) continue
        out.push({
          jid: `${msg.from}@s.whatsapp.net`,
          text: msg.text.body,
          isGroup: false,
          messageId: msg.id,
          timestamp: (Number(msg.timestamp) || Date.now() / 1000) * 1000,
        })
      }
    }
  }
  return out
}

async function sendTextMessage(toJid: string, text: string): Promise<void> {
  if (!WHATSAPP_META_ACCESS_TOKEN || !WHATSAPP_META_PHONE_NUMBER_ID) {
    throw new Error('meta provider: WHATSAPP_META_ACCESS_TOKEN and WHATSAPP_META_PHONE_NUMBER_ID are required')
  }
  const toNumber = toJid.split('@')[0] ?? ''
  const url = `https://graph.facebook.com/${WHATSAPP_META_GRAPH_VERSION}/${encodeURIComponent(WHATSAPP_META_PHONE_NUMBER_ID)}/messages`
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toNumber,
    type: 'text',
    text: { body: text },
  })

  await withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      const err = new Error(`Meta send ${res.status}: ${errText.slice(0, 300)}`)
      ;(err as Error & { status?: number }).status = res.status
      throw err
    }
  }, { label: 'meta-whatsapp-send' })
}

function readBody(req: http.IncomingMessage, limitBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > limitBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createMetaClient(): WhatsAppClient {
  let server: http.Server | null = null
  let msgHandler: WhatsAppMessageHandler | null = null

  async function handleWebhookPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      logger.warn({ err }, 'meta: failed to read webhook body')
      res.writeHead(400).end('Bad Request')
      return
    }

    const signature = (req.headers['x-hub-signature-256'] as string | undefined) ?? undefined
    if (!verifySignature(body, signature)) {
      logger.warn('meta: signature verification failed — rejecting webhook')
      res.writeHead(401).end('Unauthorized')
      return
    }

    // Always 200 ASAP so Meta doesn't retry
    res.writeHead(200).end('OK')

    let payload: MetaPayload
    try {
      payload = JSON.parse(body.toString('utf8')) as MetaPayload
    } catch (err) {
      logger.warn({ err }, 'meta: webhook body is not JSON')
      return
    }

    if (payload.object !== 'whatsapp_business_account') return

    const messages = extractMessages(payload)
    const send: WhatsAppSendReply = async (toJid, text) => sendTextMessage(toJid, text)

    for (const msg of messages) {
      try {
        await msgHandler?.(msg, send)
      } catch (err) {
        logger.error({ err, jid: msg.jid }, 'meta: handler threw')
      }
    }
  }

  return {
    async start() {
      if (!WHATSAPP_META_VERIFY_TOKEN) {
        throw new Error('meta provider: WHATSAPP_META_VERIFY_TOKEN is required')
      }
      server = http.createServer(async (req, res) => {
        const urlPath = (req.url ?? '/').split('?')[0]
        if (urlPath !== WHATSAPP_META_WEBHOOK_PATH) {
          res.writeHead(404).end('Not Found')
          return
        }

        if (req.method === 'GET') {
          // Meta webhook verification handshake
          const url = new URL(req.url ?? '/', 'http://localhost')
          const mode = url.searchParams.get('hub.mode')
          const token = url.searchParams.get('hub.verify_token')
          const challenge = url.searchParams.get('hub.challenge')
          if (mode === 'subscribe' && token === WHATSAPP_META_VERIFY_TOKEN && challenge) {
            logger.info('meta: webhook verification succeeded')
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge)
          } else {
            logger.warn({ mode, tokenMatch: token === WHATSAPP_META_VERIFY_TOKEN }, 'meta: webhook verification rejected')
            res.writeHead(403).end('Forbidden')
          }
          return
        }

        if (req.method === 'POST') {
          await handleWebhookPost(req, res)
          return
        }

        res.writeHead(405).end('Method Not Allowed')
      })

      server.listen(WHATSAPP_META_WEBHOOK_PORT, () => {
        logger.info(
          { port: WHATSAPP_META_WEBHOOK_PORT, path: WHATSAPP_META_WEBHOOK_PATH },
          'meta: webhook server listening (expose via HTTPS reverse proxy)',
        )
      })
    },

    async stop() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        server = null
      }
    },

    onMessage(handler) {
      msgHandler = handler
    },
  }
}
