import { describe, it, expect, beforeEach, vi } from 'vitest'

const configMock = {
  WHATSAPP_META_ACCESS_TOKEN: '',
  WHATSAPP_META_PHONE_NUMBER_ID: '',
  WHATSAPP_META_VERIFY_TOKEN: '',
  WHATSAPP_META_APP_SECRET: '',
  WHATSAPP_META_WEBHOOK_PORT: 0,
  WHATSAPP_META_GRAPH_VERSION: 'v20.0',
  WHATSAPP_META_WEBHOOK_PATH: '/whatsapp/webhook',
}

vi.mock('../src/config.js', () => ({
  get WHATSAPP_META_ACCESS_TOKEN() {
    return configMock.WHATSAPP_META_ACCESS_TOKEN
  },
  get WHATSAPP_META_PHONE_NUMBER_ID() {
    return configMock.WHATSAPP_META_PHONE_NUMBER_ID
  },
  get WHATSAPP_META_VERIFY_TOKEN() {
    return configMock.WHATSAPP_META_VERIFY_TOKEN
  },
  get WHATSAPP_META_APP_SECRET() {
    return configMock.WHATSAPP_META_APP_SECRET
  },
  get WHATSAPP_META_WEBHOOK_PORT() {
    return configMock.WHATSAPP_META_WEBHOOK_PORT
  },
  get WHATSAPP_META_GRAPH_VERSION() {
    return configMock.WHATSAPP_META_GRAPH_VERSION
  },
  get WHATSAPP_META_WEBHOOK_PATH() {
    return configMock.WHATSAPP_META_WEBHOOK_PATH
  },
}))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

vi.mock('../src/retry.js', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}))

const { createMetaClient } = await import('../src/whatsapp/meta.js')

beforeEach(() => {
  configMock.WHATSAPP_META_APP_SECRET = ''
  configMock.WHATSAPP_META_VERIFY_TOKEN = ''
})

describe('Meta webhook fail-fast', () => {
  it('start() throws when WHATSAPP_META_APP_SECRET is empty', async () => {
    configMock.WHATSAPP_META_APP_SECRET = ''
    configMock.WHATSAPP_META_VERIFY_TOKEN = 'v'
    const client = createMetaClient()
    await expect(client.start()).rejects.toThrow(/WHATSAPP_META_APP_SECRET is required/)
  })

  it('start() throws when WHATSAPP_META_VERIFY_TOKEN is empty (secret is set)', async () => {
    configMock.WHATSAPP_META_APP_SECRET = 'some-secret'
    configMock.WHATSAPP_META_VERIFY_TOKEN = ''
    const client = createMetaClient()
    await expect(client.start()).rejects.toThrow(/WHATSAPP_META_VERIFY_TOKEN is required/)
  })

  it('start() succeeds and binds a server when both are set', async () => {
    configMock.WHATSAPP_META_APP_SECRET = 'abc'
    configMock.WHATSAPP_META_VERIFY_TOKEN = 'def'
    configMock.WHATSAPP_META_WEBHOOK_PORT = 0
    const client = createMetaClient()
    await client.start()
    await client.stop()
  })
})
