import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { isAuthorised, getEffortLevel, setEffortLevel } from '../db.js'
import {
  EFFORT_LEVELS,
  effortLabel,
  effortDescription,
  isEffortLevel,
  type EffortLevel,
} from '../effort.js'

const CALLBACK_PREFIX = 'effort:'
const DEFAULT_CHOICE = 'default'

function buildKeyboard(active: EffortLevel | null): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const level of EFFORT_LEVELS) {
    const label = active === level ? `✓ ${effortLabel(level)}` : effortLabel(level)
    kb.text(label, `${CALLBACK_PREFIX}${level}`).row()
  }
  kb.text(active === null ? '✓ Use bot default' : 'Use bot default', `${CALLBACK_PREFIX}${DEFAULT_CHOICE}`)
  return kb
}

function describeActive(active: EffortLevel | null): string {
  if (active === null) return '<i>bot default</i> (inherits from ~/.claude/settings.json)'
  return `<b>${effortLabel(active)}</b> — ${effortDescription(active)}`
}

function readEffort(chatId: string): EffortLevel | null {
  const raw = getEffortLevel(chatId)
  return isEffortLevel(raw) ? raw : null
}

export function registerEffort(bot: Bot): void {
  bot.command('effort', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const active = readEffort(chatId)
    const lines = [
      '<b>Thinking effort for this chat</b>',
      '',
      `Current: ${describeActive(active)}`,
      '',
      'Higher effort = more reasoning before answering = slower, more expensive, but better on hard tasks.',
    ]
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: buildKeyboard(active) })
  })

  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    if (!data.startsWith(CALLBACK_PREFIX)) {
      await next()
      return
    }
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorised', show_alert: true })
      return
    }
    const choice = data.slice(CALLBACK_PREFIX.length)
    if (choice === DEFAULT_CHOICE) {
      setEffortLevel(chatId, null)
      await ctx.answerCallbackQuery({ text: 'Cleared — using bot default' })
    } else if (isEffortLevel(choice)) {
      setEffortLevel(chatId, choice)
      await ctx.answerCallbackQuery({ text: `Effort: ${effortLabel(choice)}` })
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown level', show_alert: true })
      return
    }
    const active = readEffort(chatId)
    const text = [
      '<b>Thinking effort for this chat</b>',
      '',
      `Current: ${describeActive(active)}`,
    ].join('\n')
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: buildKeyboard(active) })
    } catch {
      /* message uneditable */
    }
  })
}
