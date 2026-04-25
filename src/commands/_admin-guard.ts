import type { Context } from 'grammy'
import { isAdmin } from '../config.js'
import { tryConsumeAdmin, rateLimitMessage } from '../rate-limit.js'

export interface AdminGuardOk {
  ok: true
  chatId: string
}
export interface AdminGuardDenied {
  ok: false
}

export async function adminGuard(ctx: Context): Promise<AdminGuardOk | AdminGuardDenied> {
  const chatId = String(ctx.chat?.id ?? '')
  if (!isAdmin(chatId)) {
    await ctx.reply('Admin only.').catch(() => {})
    return { ok: false }
  }
  const rl = tryConsumeAdmin(chatId)
  if (!rl.ok) {
    await ctx.reply(rateLimitMessage(rl.retryAfterMs)).catch(() => {})
    return { ok: false }
  }
  return { ok: true, chatId }
}
