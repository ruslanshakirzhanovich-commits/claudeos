import type { Bot } from 'grammy'
import { isAdmin } from '../config.js'
import { listAllowedChats, removeAllowedChat } from '../db.js'
import { addUserChat } from '../users.js'
import { classifyChatId, type ChannelKind } from '../channel.js'

export interface ParsedAddUserArgs {
  chatId: string
  channel: Exclude<ChannelKind, 'unknown'>
  isAdmin: boolean
  existingUserId: string | undefined
  note: string | null
}

export function parseAddUserArgs(args: string[]): ParsedAddUserArgs | null {
  if (args.length === 0) return null
  const chatId = args[0]!.trim()
  if (!chatId) return null
  const channel = classifyChatId(chatId)
  if (channel === 'unknown') return null

  let isAdminFlag = false
  let existingUserId: string | undefined
  let noteParts: string[] = []

  let i = 1
  while (i < args.length) {
    const t = args[i]!
    if (t === '--admin') {
      isAdminFlag = true
      i++
    } else if (t === '--user-id') {
      existingUserId = args[i + 1]
      if (!existingUserId) return null
      i += 2
    } else if (t === '--note') {
      noteParts = args.slice(i + 1)
      break
    } else {
      return null
    }
  }

  return {
    chatId,
    channel,
    isAdmin: isAdminFlag,
    existingUserId,
    note: noteParts.length > 0 ? noteParts.join(' ') : null,
  }
}

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
    const tokens = (ctx.message?.text ?? '').split(/\s+/).slice(1).filter(Boolean)
    const parsed = parseAddUserArgs(tokens)
    if (!parsed) {
      await ctx.reply(
        [
          'Usage:',
          '<code>/adduser &lt;chat_id&gt; [--admin] [--user-id u_xxxxxxxx] [--note &lt;text&gt;]</code>',
          '',
          'chat_id can be:',
          '• Telegram numeric (e.g. <code>123456789</code>)',
          '• Discord (e.g. <code>discord:110440505</code>)',
          '• WhatsApp JID (e.g. <code>15551234567@s.whatsapp.net</code>)',
        ].join('\n'),
        { parse_mode: 'HTML' },
      )
      return
    }

    try {
      const r = addUserChat({
        chatId: parsed.chatId,
        channel: parsed.channel,
        isAdmin: parsed.isAdmin || undefined,
        existingUserId: parsed.existingUserId,
        note: parsed.note ?? undefined,
        addedBy: chatId,
      })
      const verb = r.created ? 'created user' : 'linked to existing user'
      const adminBadge = parsed.isAdmin ? ' [admin]' : ''
      await ctx.reply(`Added ${parsed.chatId}${adminBadge} — ${verb} <code>${r.userId}</code>`, {
        parse_mode: 'HTML',
      })
    } catch (err) {
      await ctx.reply(`Failed: ${(err as Error).message.slice(0, 200)}`)
    }
  })

  bot.command('removeuser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const targetId = (ctx.message?.text ?? '').split(/\s+/)[1]?.trim()
    if (!targetId || classifyChatId(targetId) === 'unknown') {
      await ctx.reply(
        'Usage: <code>/removeuser &lt;chat_id&gt;</code>\n\nAccepts Telegram numeric, Discord, or WhatsApp JID format.',
        { parse_mode: 'HTML' },
      )
      return
    }
    if (isAdmin(targetId)) {
      await ctx.reply('Cannot remove an admin chat. Demote first by editing the user record.')
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
    const lines = [
      `Removed ${targetId}.`,
      `• memories deleted: ${r.memoriesDeleted}`,
      `• tasks deleted: ${r.tasksDeleted}`,
      `• session cleared: ${r.sessionCleared}`,
      `• preferences cleared: ${r.preferencesCleared}`,
    ]
    await ctx.reply(lines.join('\n'))
  })
}
