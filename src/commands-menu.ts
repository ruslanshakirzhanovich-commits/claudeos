import type { Bot } from 'grammy'

interface BotCommand {
  command: string
  description: string
}
import { ADMIN_CHAT_IDS } from './config.js'
import { logger } from './logger.js'

const BASE_COMMANDS: BotCommand[] = [
  { command: 'status', description: 'Session state: model, effort, session, role' },
  { command: 'models', description: 'Switch Claude model (inline menu)' },
  { command: 'effort', description: 'Switch thinking budget (Low/Medium/High/Extra high)' },
  { command: 'voice', description: 'Toggle voice replies (TTS)' },
  { command: 'memory', description: 'Stored memory count for this chat' },
  { command: 'newchat', description: 'Reset conversation session' },
  { command: 'version', description: 'Show bot version and changelog' },
  { command: 'ping', description: 'Check bot is alive' },
  { command: 'chatid', description: 'Show this chat id' },
  { command: 'start', description: 'Bot greeting' },
]

const ADMIN_COMMANDS: BotCommand[] = [
  ...BASE_COMMANDS,
  { command: 'stats', description: 'Bot-wide stats (memories, tasks, chats)' },
  { command: 'health', description: 'Metrics + recent crashes (admin)' },
  { command: 'listusers', description: 'List authorised chats (admin)' },
  { command: 'adduser', description: 'Authorise a chat id (admin)' },
  { command: 'removeuser', description: 'Revoke a chat id (admin)' },
  { command: 'backup', description: 'Manual DB backup (admin)' },
]

export async function publishBotCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(BASE_COMMANDS)
    for (const adminId of ADMIN_CHAT_IDS) {
      try {
        await bot.api.setMyCommands(ADMIN_COMMANDS, {
          scope: { type: 'chat', chat_id: Number(adminId) },
        })
      } catch (err) {
        logger.warn({ err, adminId }, 'failed to publish admin commands for chat')
      }
    }
    logger.info(
      { base: BASE_COMMANDS.length, adminExtra: ADMIN_COMMANDS.length - BASE_COMMANDS.length, admins: ADMIN_CHAT_IDS.length },
      'bot commands published',
    )
  } catch (err) {
    logger.warn({ err }, 'publishBotCommands failed (bot will still work without a command menu)')
  }
}
