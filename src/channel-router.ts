import { sendToChat as sendToTelegram } from './bot.js'
import { sendToDiscordUser } from './discord/index.js'
import { sendToWhatsAppJid } from './whatsapp/index.js'

// We store Telegram, Discord, and WhatsApp chats in the same TEXT column.
// The scheduler (and anything else that speaks "chatId") needs to know which
// transport owns each id. Format conventions are channel-native so a raw
// chat_id is self-classifying:
//   Telegram  → signed decimal integer      "110440505", "-1001234"
//   Discord   → "discord:<userSnowflake>"   "discord:110440505123"
//   WhatsApp  → "<number>@s.whatsapp.net"   "491234567@s.whatsapp.net"
const DISCORD_PREFIX = 'discord:'

export type ChannelKind = 'telegram' | 'discord' | 'whatsapp' | 'unknown'

export function classifyChatId(chatId: string): ChannelKind {
  if (chatId.startsWith(DISCORD_PREFIX)) return 'discord'
  if (chatId.includes('@')) return 'whatsapp'
  if (/^-?\d+$/.test(chatId)) return 'telegram'
  return 'unknown'
}

export interface ChannelSenders {
  telegram: (chatId: string, text: string) => Promise<void>
  discord: (userId: string, text: string) => Promise<void>
  whatsapp: (jid: string, text: string) => Promise<void>
}

const DEFAULT_SENDERS: ChannelSenders = {
  telegram: sendToTelegram,
  discord: sendToDiscordUser,
  whatsapp: sendToWhatsAppJid,
}

// Returns a single (chatId, text) function that dispatches to whichever
// channel the chat_id belongs to. If the target channel isn't running,
// the underlying sender throws — the scheduler already wraps sends in a
// try/catch so one offline channel doesn't kill the tick.
export function createChannelRouter(
  senders: ChannelSenders = DEFAULT_SENDERS,
): (chatId: string, text: string) => Promise<void> {
  return async (chatId: string, text: string) => {
    const kind = classifyChatId(chatId)
    if (kind === 'discord') {
      const userId = chatId.slice(DISCORD_PREFIX.length)
      if (!userId) throw new Error(`malformed discord chat_id: ${chatId}`)
      await senders.discord(userId, text)
      return
    }
    if (kind === 'whatsapp') {
      await senders.whatsapp(chatId, text)
      return
    }
    if (kind === 'telegram') {
      await senders.telegram(chatId, text)
      return
    }
    throw new Error(`unroutable chat_id: ${chatId.slice(0, 80)}`)
  }
}
