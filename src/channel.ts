// Pure channel-id helpers — no dependencies on transport modules. Lives
// separately from channel-router.ts so consumers (users.ts, migrations.ts,
// command parsers) can import without dragging in bot/discord/whatsapp init.

const DISCORD_PREFIX = 'discord:'

export type ChannelKind = 'telegram' | 'discord' | 'whatsapp' | 'unknown'

export function classifyChatId(chatId: string): ChannelKind {
  if (chatId.startsWith(DISCORD_PREFIX)) return 'discord'
  if (chatId.includes('@')) return 'whatsapp'
  if (/^-?\d+$/.test(chatId)) return 'telegram'
  return 'unknown'
}

export function discordChatId(rawUserId: string): string {
  return `discord:${rawUserId}`
}

export function whatsappChatId(rawNumber: string): string {
  return rawNumber.includes('@') ? rawNumber : `${rawNumber}@s.whatsapp.net`
}
