import { Client, Events, GatewayIntentBits, Partials, ChannelType } from 'discord.js'
import { DISCORD_ENABLED, DISCORD_BOT_TOKEN } from '../config.js'
import { logger } from '../logger.js'
import { handleDiscordMessage, chunkForDiscord } from './handler.js'
import type { DiscordClient, DiscordMessageHandler } from './types.js'

let active: DiscordClient | null = null

function createClient(): DiscordClient {
  let client: Client | null = null
  let handler: DiscordMessageHandler | null = null

  return {
    onMessage(h: DiscordMessageHandler) {
      handler = h
    },
    async start() {
      client = new Client({
        // DM-only bot: we need DirectMessages for DM events and
        // MessageContent (privileged) to read their text. Guilds and
        // GuildMessages were unused — their gateway events were skipped
        // in the handler, and GuildMessages becomes a Discord-approval
        // gate once the bot joins 100+ servers.
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        // DMChannel arrives as a partial on first contact — without these,
        // the messageCreate event fires with `channel.type` undefined.
        partials: [Partials.Channel, Partials.Message],
      })

      client.on(Events.ClientReady, (c) => {
        logger.info({ tag: c.user.tag }, 'discord: ready')
      })

      client.on(Events.MessageCreate, async (m) => {
        if (m.author.bot) return
        if (!handler) return
        if (!m.content) return
        try {
          await handler(
            {
              userId: m.author.id,
              channelId: m.channelId,
              text: m.content,
              isDM: m.channel.type === ChannelType.DM,
              messageId: m.id,
              authorTag: m.author.tag,
            },
            async (channelId: string, text: string) => {
              if (!client) return
              const ch = await client.channels.fetch(channelId)
              if (ch && 'send' in ch && typeof (ch as { send?: unknown }).send === 'function') {
                await (ch as { send: (t: string) => Promise<unknown> }).send(text)
              }
            },
          )
        } catch (err) {
          logger.error({ err }, 'discord handler crashed')
        }
      })

      client.on(Events.Error, (err) => {
        logger.error({ err }, 'discord client error')
      })

      await client.login(DISCORD_BOT_TOKEN)
    },
    async stop() {
      try {
        await client?.destroy()
      } catch {
        /* ignore */
      }
      client = null
    },
    async sendDirect(userId, text) {
      if (!client) throw new Error('discord client not logged in')
      const user = await client.users.fetch(userId)
      for (const chunk of chunkForDiscord(text)) {
        await user.send(chunk)
      }
    },
  }
}

export async function initDiscord(): Promise<DiscordClient | null> {
  if (!DISCORD_ENABLED) {
    logger.debug('Discord disabled (DISCORD_ENABLED != 1)')
    return null
  }
  if (!DISCORD_BOT_TOKEN) {
    logger.warn('DISCORD_ENABLED=1 but DISCORD_BOT_TOKEN missing — skipping Discord init')
    return null
  }

  const client = createClient()
  client.onMessage(handleDiscordMessage)
  // Register the wrapper BEFORE awaiting start() so that a SIGTERM
  // arriving during login() still reaches stopDiscord → client.destroy().
  // Without this, `active` stays null until login completes and the
  // gateway connection leaks when the process is killed mid-handshake.
  active = client
  try {
    await client.start()
  } catch (err) {
    active = null
    throw err
  }
  logger.info('Discord client started')
  return client
}

export async function stopDiscord(): Promise<void> {
  if (!active) return
  try {
    await active.stop()
  } catch {
    /* ignore */
  }
  active = null
}

// Non-reply outbound send (scheduler, cross-channel routing). Throws if
// the gateway is disabled or not yet logged in; the caller decides how to
// surface that — scheduled tasks wrap it in their own error handler.
export async function sendToDiscordUser(userId: string, text: string): Promise<void> {
  if (!active) throw new Error('Discord client not available (disabled or not yet connected)')
  await active.sendDirect(userId, text)
}
