import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { isAuthorised, getPreferredModel, setPreferredModel, clearSession } from '../db.js'
import { resetUsage } from '../usage.js'
import { CLAUDE_MODEL } from '../config.js'

interface ModelEntry {
  id: string
  aliases: string[]
  name: string
  blurb: string
}

export const MODELS: ModelEntry[] = [
  {
    id: 'claude-opus-4-7',
    aliases: ['opus', 'opus-4.7'],
    name: 'Claude Opus 4.7',
    blurb: 'Most capable, highest cost. Best for complex reasoning and long-form coding.',
  },
  {
    id: 'claude-opus-4-6',
    aliases: ['opus-4.6'],
    name: 'Claude Opus 4.6',
    blurb: 'Previous Opus generation. Use when you want to pin to the pre-4.7 behavior.',
  },
  {
    id: 'claude-sonnet-4-6',
    aliases: ['sonnet', 'sonnet-4.6'],
    name: 'Claude Sonnet 4.6',
    blurb: 'Balanced capability and cost. Good default for day-to-day work.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    aliases: ['haiku', 'haiku-4.5'],
    name: 'Claude Haiku 4.5',
    blurb: 'Fastest, lowest cost. Best for simple queries and high-volume tasks.',
  },
]

export const MODEL_CALLBACK_PREFIX = 'model:'
export const MODEL_DEFAULT_CHOICE = 'default'

const CALLBACK_PREFIX = MODEL_CALLBACK_PREFIX
const DEFAULT_CHOICE = MODEL_DEFAULT_CHOICE

/**
 * Returns the parsed callback choice if `data` is a model: payload AND the
 * choice is one we know about. Returns null otherwise. Hardens against
 * forged callback payloads writing arbitrary strings into preferred_model.
 */
export function parseModelCallback(data: string | undefined | null): { choice: string } | null {
  if (typeof data !== 'string' || !data.startsWith(CALLBACK_PREFIX)) return null
  const choice = data.slice(CALLBACK_PREFIX.length)
  if (choice === DEFAULT_CHOICE) return { choice }
  if (MODELS.some((m) => m.id === choice)) return { choice }
  return null
}

export function resolveActiveModel(envValue: string): { id: string; explicit: boolean } {
  if (!envValue) return { id: MODELS[0]!.id, explicit: false }
  const normalized = envValue.toLowerCase()
  for (const m of MODELS) {
    if (m.id === envValue || m.aliases.includes(normalized)) return { id: m.id, explicit: true }
  }
  return { id: envValue, explicit: true }
}

function buildKeyboard(active: string | null): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const m of MODELS) {
    const label = active === m.id ? `✓ ${m.name}` : m.name
    kb.text(label, `${CALLBACK_PREFIX}${m.id}`).row()
  }
  const defaultLabel = active === null ? '✓ Use bot default' : 'Use bot default'
  kb.text(defaultLabel, `${CALLBACK_PREFIX}${DEFAULT_CHOICE}`)
  return kb
}

function describeActive(perChat: string | null): string {
  if (perChat) return `<code>${perChat}</code> (this chat)`
  const { id, explicit } = resolveActiveModel(CLAUDE_MODEL)
  return `<code>${id}</code> ${explicit ? '(CLAUDE_MODEL env)' : '(SDK default)'}`
}

export function registerModels(bot: Bot): void {
  bot.command('models', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const active = getPreferredModel(chatId)
    const text = [
      '<b>Select model for this chat</b>',
      '',
      `Current: ${describeActive(active)}`,
      '',
      'Tap one to switch. "Use bot default" falls back to CLAUDE_MODEL env (or the SDK default).',
    ].join('\n')
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildKeyboard(active) })
  })

  bot.on('callback_query:data', async (ctx, next) => {
    const parsed = parseModelCallback(ctx.callbackQuery.data)
    if (!parsed) {
      if (
        typeof ctx.callbackQuery.data === 'string' &&
        ctx.callbackQuery.data.startsWith(CALLBACK_PREFIX)
      ) {
        await ctx.answerCallbackQuery({ text: 'Unknown model', show_alert: true })
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
    const previous = getPreferredModel(chatId)
    if (choice === DEFAULT_CHOICE) {
      setPreferredModel(chatId, null)
      await ctx.answerCallbackQuery({ text: 'Cleared — using bot default' })
    } else {
      setPreferredModel(chatId, choice)
      const entry = MODELS.find((m) => m.id === choice)
      await ctx.answerCallbackQuery({ text: `Switched to ${entry?.name ?? choice}` })
    }
    // Resumed sessions stick to the original model; start a fresh one
    // so the next turn actually uses the new model.
    const newChoice = choice === DEFAULT_CHOICE ? null : choice
    if (previous !== newChoice) {
      clearSession(chatId)
      resetUsage(chatId)
    }
    const active = getPreferredModel(chatId)
    const text = [
      '<b>Model for this chat</b>',
      '',
      `Current: ${describeActive(active)}`,
      '',
      '<i>Session reset — next message starts a fresh conversation.</i>',
    ].join('\n')
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: buildKeyboard(active) })
    } catch {
      /* message can't be edited (e.g. too old) — answerCallbackQuery above is enough */
    }
  })
}
