export interface WhatsAppMessage {
  jid: string
  text: string
  isGroup: boolean
  messageId: string
  timestamp: number
}

export type WhatsAppSendReply = (jid: string, text: string) => Promise<void>

export type WhatsAppMessageHandler = (
  msg: WhatsAppMessage,
  send: WhatsAppSendReply,
) => Promise<void>

export interface WhatsAppClient {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: WhatsAppMessageHandler): void
}
