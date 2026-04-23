import type { Bot } from 'grammy'
import { isAuthorised } from '../db.js'
import { CLAUDE_MODEL } from '../config.js'

interface ModelEntry {
  id: string
  aliases: string[]
  name: string
  blurb: string
}

const MODELS: ModelEntry[] = [
  {
    id: 'claude-opus-4-7',
    aliases: ['opus', 'opus-4.7'],
    name: 'Claude Opus 4.7',
    blurb: 'Most capable, highest cost. Best for complex reasoning and long-form coding.',
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

export function resolveActiveModel(envValue: string): { id: string; explicit: boolean } {
  if (!envValue) return { id: MODELS[0]!.id, explicit: false }
  const normalized = envValue.toLowerCase()
  for (const m of MODELS) {
    if (m.id === envValue || m.aliases.includes(normalized)) return { id: m.id, explicit: true }
  }
  return { id: envValue, explicit: true }
}

export function registerModels(bot: Bot): void {
  bot.command('models', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const { id: activeId, explicit } = resolveActiveModel(CLAUDE_MODEL)
    const lines = [
      '<b>Available Claude models</b>',
      '',
    ]
    for (const m of MODELS) {
      const marker = m.id === activeId ? ' ← current' : ''
      lines.push(`<b>${m.name}</b>${marker}`)
      lines.push(`  id: <code>${m.id}</code>`)
      lines.push(`  aliases: ${m.aliases.join(', ')}`)
      lines.push(`  ${m.blurb}`)
      lines.push('')
    }
    lines.push(
      explicit
        ? `Active via CLAUDE_MODEL=${CLAUDE_MODEL}`
        : 'No CLAUDE_MODEL env set — using SDK default.',
    )
    lines.push('To override: set CLAUDE_MODEL in .env and restart the bot.')
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })
}
