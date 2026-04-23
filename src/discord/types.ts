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
  // Open (or reuse) the DM channel with `userId` and send `text` there,
  // chunking to respect Discord's 2000-char per-message cap. Throws if
  // the gateway isn't logged in or the user has DMs disabled.
  sendDirect(userId: string, text: string): Promise<void>
}
