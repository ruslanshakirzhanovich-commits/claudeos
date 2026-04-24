import type { Bot } from 'grammy'
import { isAdmin } from '../config.js'
import {
  listAllowedChats,
  addAllowedChat,
  removeAllowedChat,
  isValidTelegramChatId,
} from '../db.js'

export function registerUserCommands(bot: Bot): void {
  bot.command('listusers', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const rows = listAllowedChats()
    if (!rows.length) {
      await ctx.reply('No authorised chats yet (open mode).')
      return
    }
    const lines = rows.map((r) => {
      const added = new Date(r.added_at).toISOString().slice(0, 10)
      const seen = r.last_seen_at ? new Date(r.last_seen_at).toISOString().slice(0, 10) : 'never'
      const by = r.added_by ? ` by ${r.added_by}` : ''
      const note = r.note ? ` — ${r.note}` : ''
      const adminBadge = isAdmin(r.chat_id) ? ' [admin]' : ''
      return `• <code>${r.chat_id}</code>${adminBadge} (added ${added}${by}, seen ${seen})${note}`
    })
    await ctx.reply(`<b>Authorised chats (${rows.length})</b>\n${lines.join('\n')}`, {
      parse_mode: 'HTML',
    })
  })

  bot.command('adduser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const parts = (ctx.message?.text ?? '').split(/\s+/)
    const targetId = parts[1]?.trim()
    const note = parts.slice(2).join(' ').trim() || null
    if (!targetId || !isValidTelegramChatId(targetId)) {
      await ctx.reply(
        'Usage: /adduser &lt;chat_id&gt; [note]\n\nMust be a Telegram chat id (digits, optional minus). WhatsApp jids are managed separately.',
        { parse_mode: 'HTML' },
      )
      return
    }
    const added = addAllowedChat(targetId, chatId, note)
    await ctx.reply(added ? `Added ${targetId}.` : `${targetId} was already authorised.`)
  })

  bot.command('removeuser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const targetId = (ctx.message?.text ?? '').split(/\s+/)[1]?.trim()
    if (!targetId || !isValidTelegramChatId(targetId)) {
      await ctx.reply('Usage: /removeuser &lt;chat_id&gt;', { parse_mode: 'HTML' })
      return
    }
    if (isAdmin(targetId)) {
      await ctx.reply('Cannot remove an admin. Edit ADMIN_CHAT_IDS in .env first.')
      return
    }
    const r = removeAllowedChat(targetId)
    if (
      !r.removed &&
      r.memoriesDeleted === 0 &&
      !r.sessionCleared &&
      !r.preferencesCleared &&
      r.tasksDeleted === 0
    ) {
      await ctx.reply(`${targetId} was not in the list.`)
      return
    }
    const pieces = [
      r.removed ? 'allowlist' : null,
      r.preferencesCleared ? 'prefs' : null,
      r.sessionCleared ? 'session' : null,
      r.memoriesDeleted > 0 ? `${r.memoriesDeleted} memories` : null,
      r.tasksDeleted > 0 ? `${r.tasksDeleted} tasks` : null,
    ].filter(Boolean)
    await ctx.reply(`Removed ${targetId} — purged: ${pieces.join(', ')}.`)
  })
}
