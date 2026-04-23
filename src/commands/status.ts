import type { Bot } from 'grammy'
import { isAdmin, isWhatsAppAuthorised, CLAUDE_MODEL, PREVIEW_ENABLED, WHATSAPP_ENABLED, WHATSAPP_PROVIDER } from '../config.js'
import { isAuthorised, isOpenMode, getSession, getTtsEnabled, countMemories, getPreferredModel, getEffortLevel } from '../db.js'
import { isEffortLevel, effortLabel, CHAT_DEFAULT_EFFORT } from '../effort.js'
import { voiceCapabilities } from '../voice.js'
import { resolveActiveModel } from './models.js'

export function registerStatus(bot: Bot): void {
  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    const userId = ctx.from?.id
    const username = ctx.from?.username ?? ctx.from?.first_name ?? '?'

    const authorised = isAuthorised(chatId)
    const admin = isAdmin(chatId)
    const sessionId = getSession(chatId)
    const tts = getTtsEnabled(chatId)
    const memories = authorised ? countMemories(chatId) : 0
    const perChatModel = authorised ? getPreferredModel(chatId) : null
    const rawEffort = authorised ? getEffortLevel(chatId) : null
    const effort = isEffortLevel(rawEffort) ? rawEffort : null
    const { id: envModelId, explicit } = resolveActiveModel(CLAUDE_MODEL)
    const modelId = perChatModel ?? envModelId
    const modelSource = perChatModel
      ? '/models (this chat)'
      : explicit
        ? 'CLAUDE_MODEL env'
        : 'SDK default'
    const caps = voiceCapabilities()
    void isWhatsAppAuthorised

    const lines = [
      '<b>Session status</b>',
      '',
      `chat id: <code>${chatId}</code>`,
      `user id: <code>${userId ?? '?'}</code>`,
      `username: ${username}`,
      `role: ${admin ? '<b>admin</b> (bypassPermissions)' : authorised ? 'user (plan mode)' : 'unauthorised'}`,
      `open mode: ${isOpenMode() ? 'YES' : 'no'}`,
      '',
      '<b>Model</b>',
      `active: <code>${modelId}</code>`,
      `source: ${modelSource}`,
      `effort: ${effort ? effortLabel(effort) + ' (/effort)' : effortLabel(CHAT_DEFAULT_EFFORT) + ' (bot default)'}`,
      '',
      '<b>Conversation</b>',
      `session: ${sessionId ? `<code>${sessionId.slice(0, 8)}…</code>` : '(new session on next message)'}`,
      `memories stored: ${memories}`,
      '',
      '<b>Features for this chat</b>',
      `voice replies: ${tts ? 'ON' : 'OFF'} (TTS ${caps.tts ? 'configured' : 'not configured'})`,
      `STT: ${caps.stt ? 'configured' : 'not configured'}`,
      '',
      '<b>Bot-wide</b>',
      `preview server: ${PREVIEW_ENABLED ? 'on' : 'off'}`,
      `whatsapp: ${WHATSAPP_ENABLED ? `on (${WHATSAPP_PROVIDER})` : 'off'}`,
    ]

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })
}
