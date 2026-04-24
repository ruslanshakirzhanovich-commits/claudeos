import fs from 'node:fs'
import path from 'node:path'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import qrcode from 'qrcode'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import {
  loadEncryptionKey,
  migratePlainAuthFiles,
  useEncryptedMultiFileAuthState,
} from './auth-encryption.js'
import type {
  WhatsAppClient,
  WhatsAppMessage,
  WhatsAppMessageHandler,
  WhatsAppSendReply,
} from './types.js'

const AUTH_DIR = path.join(STORE_DIR, 'whatsapp-auth')
const QR_PATH = path.join(STORE_DIR, 'whatsapp-qr.png')
const RECONNECT_DELAY_MS = 3000

type Sock = ReturnType<typeof makeWASocket>

export function createBaileysClient(): WhatsAppClient {
  let sock: Sock | null = null
  let msgHandler: WhatsAppMessageHandler | null = null
  let stopped = false

  function cleanupQr(): void {
    try {
      if (fs.existsSync(QR_PATH)) fs.unlinkSync(QR_PATH)
    } catch (err) {
      logger.warn({ err }, 'baileys: failed to cleanup QR file')
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

    const encKey = loadEncryptionKey()
    const migrated = await migratePlainAuthFiles(AUTH_DIR, encKey)
    if (migrated.migrated > 0) {
      logger.info(migrated, 'baileys: encrypted legacy plain auth files')
    }
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(AUTH_DIR, encKey)
    const { version } = await fetchLatestBaileysVersion()
    logger.info({ version }, 'baileys: starting WhatsApp socket')

    const baileysLogger = pino({ level: 'warn' })

    sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        logger.info('baileys: scan this QR with WhatsApp → Linked devices')
        qrcodeTerminal.generate(qr, { small: true })
        qrcode
          .toFile(QR_PATH, qr, { width: 512 })
          .then(() => logger.info({ path: QR_PATH }, 'baileys: QR saved to file'))
          .catch((err) => logger.warn({ err }, 'baileys: failed to save QR png'))
      }

      if (connection === 'open') {
        logger.info('baileys: connected to WhatsApp')
        cleanupQr()
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined
        const loggedOut = code === DisconnectReason.loggedOut
        logger.warn({ code, loggedOut }, 'baileys: connection closed')
        if (loggedOut) {
          logger.error('baileys: logged out on phone — delete store/whatsapp-auth and re-scan QR')
          cleanupQr()
          return
        }
        if (!stopped) {
          setTimeout(() => {
            connect().catch((err) => logger.error({ err }, 'baileys: reconnect failed'))
          }, RECONNECT_DELAY_MS)
        }
      }
    })

    sock.ev.on('messages.upsert', async (payload) => {
      if (payload.type !== 'notify') return
      for (const msg of payload.messages) {
        if (!msg.message || msg.key.fromMe) continue
        const jid = msg.key.remoteJid
        if (!jid) continue

        const text = msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? ''
        if (!text) continue

        const waMsg: WhatsAppMessage = {
          jid,
          text,
          isGroup: jid.endsWith('@g.us'),
          messageId: msg.key.id ?? '',
          timestamp: (Number(msg.messageTimestamp) || Date.now() / 1000) * 1000,
        }

        const send: WhatsAppSendReply = async (toJid, body) => {
          if (!sock) throw new Error('baileys socket not connected')
          await sock.sendMessage(toJid, { text: body })
        }

        const sendTyping = async (toJid: string) => {
          if (!sock) return
          await sock.sendPresenceUpdate('composing', toJid)
        }

        try {
          await msgHandler?.(waMsg, send, sendTyping)
        } catch (err) {
          logger.error({ err, jid }, 'baileys: message handler threw')
        }
      }
    })
  }

  return {
    async start() {
      stopped = false
      await connect()
    },
    async stop() {
      stopped = true
      cleanupQr()
      try {
        sock?.end(undefined)
      } catch {
        /* ignore */
      }
      sock = null
    },
    onMessage(handler) {
      msgHandler = handler
    },
    async sendText(jid, body) {
      if (!sock) throw new Error('baileys socket not connected')
      await sock.sendMessage(jid, { text: body })
    },
  }
}
