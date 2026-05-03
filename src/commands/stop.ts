import type { Context } from 'grammy'
import { isAuthorised } from '../db.js'

export async function handleStopCommand(
  ctx: Context,
  activeAgents: Map<string, AbortController>,
): Promise<void> {
  const chatId = String(ctx.chat?.id ?? '')
  if (!isAuthorised(chatId)) return
  const ctrl = activeAgents.get(chatId)
  if (!ctrl) {
    await ctx.reply('Ничего не запущено.')
    return
  }
  ctrl.abort()
  await ctx.reply('🛑 Останавливаю...')
}

export function registerStop(
  bot: { command: (cmd: string, handler: (ctx: Context) => Promise<void>) => void },
  activeAgents: Map<string, AbortController>,
): void {
  bot.command('stop', (ctx) => handleStopCommand(ctx, activeAgents))
}
