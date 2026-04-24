export interface WhatsAppMessage {
  jid: string
  text: string
  isGroup: boolean
  messageId: string
  timestamp: number
}

export type WhatsAppSendReply = (jid: string, text: string) => Promise<void>

// "User is typing" presence hint toward the given jid. Implementations that
// can't express this (e.g. WhatsApp Cloud/Meta API) can simply omit the
// callback — the handler treats it as optional.
export type WhatsAppSendTyping = (jid: string) => Promise<void>

export type WhatsAppMessageHandler = (
  msg: WhatsAppMessage,
  send: WhatsAppSendReply,
  sendTyping?: WhatsAppSendTyping,
) => Promise<void>

export interface WhatsAppClient {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: WhatsAppMessageHandler): void
  // Outbound path used by the scheduler (and any other non-reply sender)
  // when the target chat_id is a WhatsApp jid. Throws if the transport
  // is not currently available (e.g. baileys socket not connected).
  sendText(jid: string, text: string): Promise<void>
}
