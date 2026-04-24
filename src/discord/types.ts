export interface DiscordIncomingMessage {
  userId: string
  channelId: string
  text: string
  isDM: boolean
  messageId: string
  authorTag: string
}

export type DiscordSendReply = (channelId: string, text: string) => Promise<void>

// Emit a "user is typing" hint in the given channel. Should succeed quickly
// and can be called repeatedly; Discord coalesces. Optional at the handler
// boundary so callers that don't care about typing indicators still work.
export type DiscordSendTyping = (channelId: string) => Promise<void>

export type DiscordMessageHandler = (
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
  sendTyping?: DiscordSendTyping,
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
