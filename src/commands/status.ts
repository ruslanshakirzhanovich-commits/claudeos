import type { Bot } from 'grammy'
import { isAdmin, CLAUDE_MODEL, PREVIEW_ENABLED, WHATSAPP_ENABLED, WHATSAPP_PROVIDER } from '../config.js'
import { isAuthorised, isOpenMode, getSessionMeta, getTtsEnabled, countMemories, getPreferredModel, getEffortLevel } from '../db.js'
import { isEffortLevel, effortLabel, CHAT_DEFAULT_EFFORT } from '../effort.js'
import { voiceCapabilities } from '../voice.js'
import { inflightCount } from '../inflight.js'
import { BOT_VERSION, BOT_COMMIT } from '../version.js'
import { resolveActiveModel } from './models.js'

function formatAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

export function registerStatus(bot: Bot): void {
  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    const userId = ctx.from?.id
    const username = ctx.from?.username ?? ctx.from?.first_name ?? '?'

    const authorised = isAuthorised(chatId)
    const admin = isAdmin(chatId)
    const sessionMeta = authorised ? getSessionMeta(chatId) : null
    const tts = getTtsEnabled(chatId)
    const memories = authorised ? countMemories(chatId) : 0
    const perChatModel = authorised ? getPreferredModel(chatId) : null
    const rawEffort = authorised ? getEffortLevel(chatId) : null
    const effort = isEffortLevel(rawEffort) ? rawEffort : null
    const { id: envModelId, explicit } = resolveActiveModel(CLAUDE_MODEL)
    const modelId = perChatModel ?? envModelId
    const modelSource = perChatModel ? 'this chat' : explicit ? 'env' : 'SDK default'
    const effortLabelText = effort
      ? `${effortLabel(effort)} (/effort)`
      : `${effortLabel(CHAT_DEFAULT_EFFORT)} (default)`
    const caps = voiceCapabilities()
    const role = !authorised ? 'unauthorised' : admin ? 'admin' : 'user'
    const permission = admin ? 'bypassPermissions' : 'plan'

    const sessionLine = sessionMeta
      ? `<code>${sessionMeta.sessionId.slice(0, 8)}…</code> · updated ${formatAgo(sessionMeta.updatedAt)}`
      : '(new on next message)'

    const voiceLine = `${tts ? 'ON' : 'OFF'}${caps.tts ? '' : ' · TTS not configured'}${caps.stt ? '' : ' · STT not configured'}`
    const featuresLine = [
      PREVIEW_ENABLED ? 'preview' : null,
      WHATSAPP_ENABLED ? `whatsapp:${WHATSAPP_PROVIDER}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'none'

    const lines = [
      `🤖 <b>ClaudeClaw</b> v${BOT_VERSION} (${BOT_COMMIT})`,
      `🧠 Model: <code>${modelId}</code> · ${modelSource}`,
      `⚡ Effort: ${effortLabelText}`,
      `👤 Role: ${role}${role !== 'unauthorised' ? ` · ${permission}` : ''}${isOpenMode() ? ' · <b>OPEN MODE</b>' : ''}`,
      `🧵 Session: ${sessionLine}`,
      `📚 Memories: ${memories} for this chat`,
      `🗣 Voice: ${voiceLine}`,
      `🌐 Bot features: ${featuresLine}`,
      `⏳ Inflight agents: ${inflightCount()}`,
      `🆔 Chat: <code>${chatId}</code> · User: <code>${userId ?? '?'}</code> · ${username}`,
    ]

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })
}
