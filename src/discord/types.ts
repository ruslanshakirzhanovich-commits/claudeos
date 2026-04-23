export interface DiscordIncomingMessage {
  userId: string
  channelId: string
  text: string
  isDM: boolean
  messageId: string
  authorTag: string
}

export type DiscordSendReply = (channelId: string, text: string) => Promise<void>

export type DiscordMessageHandler = (
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
) => Promise<void>

export interface DiscordClient {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: DiscordMessageHandler): void
}
