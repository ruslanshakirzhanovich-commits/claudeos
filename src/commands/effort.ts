import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { isAuthorised, getEffortLevel, setEffortLevel } from '../db.js'
import {
  EFFORT_LEVELS,
  effortLabel,
  effortDescription,
  isEffortLevel,
  CHAT_DEFAULT_EFFORT,
  type EffortLevel,
} from '../effort.js'

export const EFFORT_CALLBACK_PREFIX = 'effort:'
export const EFFORT_DEFAULT_CHOICE = 'default'

const CALLBACK_PREFIX = EFFORT_CALLBACK_PREFIX
const DEFAULT_CHOICE = EFFORT_DEFAULT_CHOICE

/**
 * Parse and validate an effort: callback payload. Returns null if not an
 * effort: payload OR if the choice is unrecognised. Hardens against forged
 * payloads writing arbitrary strings into chat_preferences.effort_level.
 */
export function parseEffortCallback(
  data: string | undefined | null,
): { choice: EffortLevel | typeof DEFAULT_CHOICE } | null {
  if (typeof data !== 'string' || !data.startsWith(CALLBACK_PREFIX)) return null
  const choice = data.slice(CALLBACK_PREFIX.length)
  if (choice === DEFAULT_CHOICE) return { choice: DEFAULT_CHOICE }
  if (isEffortLevel(choice)) return { choice }
  return null
}

function buildKeyboard(active: EffortLevel | null): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const level of EFFORT_LEVELS) {
    const label = active === level ? `✓ ${effortLabel(level)}` : effortLabel(level)
    kb.text(label, `${CALLBACK_PREFIX}${level}`).row()
  }
  const defaultLabel = `Use bot default (${effortLabel(CHAT_DEFAULT_EFFORT)})`
  kb.text(active === null ? `✓ ${defaultLabel}` : defaultLabel, `${CALLBACK_PREFIX}${DEFAULT_CHOICE}`)
  return kb
}

function describeActive(active: EffortLevel | null): string {
  if (active === null) {
    return `<b>${effortLabel(CHAT_DEFAULT_EFFORT)}</b> (bot default) — ${effortDescription(CHAT_DEFAULT_EFFORT)}`
  }
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
    const parsed = parseEffortCallback(ctx.callbackQuery.data)
    if (!parsed) {
      if (typeof ctx.callbackQuery.data === 'string' && ctx.callbackQuery.data.startsWith(CALLBACK_PREFIX)) {
        await ctx.answerCallbackQuery({ text: 'Unknown level', show_alert: true })
        return
      }
      await next()
      return
    }
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorised', show_alert: true })
      return
    }
    const choice = parsed.choice
    if (choice === DEFAULT_CHOICE) {
      setEffortLevel(chatId, null)
      await ctx.answerCallbackQuery({ text: 'Cleared — using bot default' })
    } else {
      setEffortLevel(chatId, choice)
      await ctx.answerCallbackQuery({ text: `Effort: ${effortLabel(choice)}` })
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
