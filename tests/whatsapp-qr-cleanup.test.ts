import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-qr-'))
const AUTH_DIR = path.join(tmpStore, 'whatsapp-auth')
const QR_PATH = path.join(tmpStore, 'whatsapp-qr.png')

vi.mock('../src/config.js', () => ({
  STORE_DIR: tmpStore,
  WHATSAPP_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
}))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const connectionHandlers: Array<(u: any) => void> = []
function makeStubSocket() {
  return {
    ev: {
      on: (event: string, handler: (u: any) => void) => {
        if (event === 'connection.update') connectionHandlers.push(handler)
      },
    },
    sendMessage: async () => ({}),
    sendPresenceUpdate: async () => ({}),
    end: () => {},
  }
}

vi.mock('@whiskeysockets/baileys', async () => {
  return {
    default: () => makeStubSocket(),
    makeWASocket: () => makeStubSocket(),
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: async () => ({ version: [0, 0, 0] }),
    BufferJSON: {
      replacer: (_k: string, v: unknown) => v,
      reviver: (_k: string, v: unknown) => v,
    },
    initAuthCreds: () => ({ registrationId: 1 }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (v: unknown) => v } } },
  }
})

vi.mock('qrcode', () => ({
  default: {
    toFile: async (p: string) => {
      await fs.promises.writeFile(p, 'fake-qr')
    },
  },
  toFile: async (p: string) => {
    await fs.promises.writeFile(p, 'fake-qr')
  },
}))
vi.mock('qrcode-terminal', () => ({
  default: { generate: () => {} },
}))

const { createBaileysClient } = await import('../src/whatsapp/baileys.js')

beforeEach(() => {
  connectionHandlers.length = 0
  try {
    fs.unlinkSync(QR_PATH)
  } catch {
    /* ignore */
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true })
})

afterAll(() => {
  try {
    fs.rmSync(tmpStore, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function primeQr(): Promise<void> {
  fs.writeFileSync(QR_PATH, 'fake-qr')
}

describe('baileys QR cleanup', () => {
  it('removes the QR file when stop() is called', async () => {
    const client = createBaileysClient()
    await client.start()
    await primeQr()
    expect(fs.existsSync(QR_PATH)).toBe(true)

    await client.stop()

    expect(fs.existsSync(QR_PATH)).toBe(false)
  })

  it('removes the QR file on loggedOut disconnect', async () => {
    const client = createBaileysClient()
    await client.start()
    await primeQr()

    for (const h of connectionHandlers) {
      h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      })
    }

    expect(fs.existsSync(QR_PATH)).toBe(false)
    await client.stop()
  })

  it('keeps the QR file on a transient (non-loggedOut) disconnect', async () => {
    const client = createBaileysClient()
    await client.start()
    await primeQr()

    for (const h of connectionHandlers) {
      h({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      })
    }

    expect(fs.existsSync(QR_PATH)).toBe(true)
    await client.stop()
  })
})
