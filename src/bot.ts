import path from 'node:path'
import { Bot, type Context, GrammyError, HttpError, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  TYPING_REFRESH_MS,
  isAdmin,
} from './config.js'
import { formatForTelegram, splitMessage } from './format.js'
import { nonOverlapping } from './scheduler.js'
import { registerVersion } from './commands/version.js'
import { registerVoice } from './commands/voice.js'
import { registerPing, registerStats } from './commands/stats.js'
import { registerUserCommands } from './commands/users.js'
import { registerBackup } from './commands/backup.js'
import { registerHealth } from './commands/health.js'
import { registerModels } from './commands/models.js'
import { registerStatus } from './commands/status.js'
import { runAgent } from './agent.js'
import {
  getSession,
  setSession,
  clearSession,
  countMemories,
  getTtsEnabled,
  setTtsEnabled,
  isAuthorised,
  isOpenMode,
  listAllowedChats,
  addAllowedChat,
  removeAllowedChat,
  countAllowedChats,
  getBotStats,
  touchAllowedChat,
  getSchemaVersion,
} from './db.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import {
  transcribeAudio,
  voiceCapabilities,
  synthesizeSpeech,
} from './voice.js'
import {
  downloadMedia,
  buildPhotoMessage,
  buildDocumentMessage,
  ensureUploadsDir,
} from './media.js'
import { logger } from './logger.js'
import { withRetry, isTransientError } from './retry.js'
import { wrapUntrusted } from './untrusted.js'

async function sendResponse(ctx: Context, text: string): Promise<void> {
  if (!text) {
    await withRetry(() => ctx.reply('(no output)'), { label: 'tg-reply-empty' }).catch(() => {})
    return
  }
  const formatted = formatForTelegram(text)
  for (const chunk of splitMessage(formatted)) {
    try {
      await withRetry(() => ctx.reply(chunk, { parse_mode: 'HTML' }), { label: 'tg-reply-html' })
    } catch (err) {
      if (isTransientError(err)) {
        logger.error({ err }, 'HTML send exhausted retries')
        continue
      }
      logger.warn({ err }, 'HTML send failed, falling back to plain text')
      try {
        await withRetry(() => ctx.reply(chunk), { label: 'tg-reply-plain' })
      } catch (err2) {
        logger.error({ err: err2 }, 'plain text send failed too')
      }
    }
  }
}

const openModeWarnedChats = new Set<string>()
function warnOpenModeOnce(
  chatId: string,
  userId: number | undefined,
  username: string | undefined,
  log: typeof logger,
): void {
  if (openModeWarnedChats.has(chatId)) return
  openModeWarnedChats.add(chatId)
  log.warn(
    { chatId, userId, username },
    'OPEN MODE accepted new chat — set ALLOWED_CHAT_IDS or run /adduser to lock down',
  )
}

function ctxIdentity(ctx: Context): { chatId: string; userId: number | undefined; username: string | undefined } {
  return {
    chatId: String(ctx.chat?.id ?? ''),
    userId: ctx.from?.id,
    username: ctx.from?.username ?? ctx.from?.first_name,
  }
}

async function handleMessage(
  ctx: Context,
  rawText: string,
  opts: { forceVoice?: boolean } = {},
): Promise<void> {
  const { chatId, userId, username } = ctxIdentity(ctx)
  if (!chatId) return
  const log = logger.child({ chatId, userId, username })

  if (!isAuthorised(chatId)) {
    log.warn('unauthorised chat')
    return
  }

  if (isOpenMode()) warnOpenModeOnce(chatId, userId, username, log)

  touchAllowedChat(chatId)
  log.info({ preview: rawText.slice(0, 80) }, 'message received')

  let typingInterval: NodeJS.Timeout | null = null
  try {
    await ctx.replyWithChatAction('typing').catch(() => {})
    const sendTyping = nonOverlapping(async () => {
      await ctx.replyWithChatAction('typing').catch(() => {})
    })
    typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS)

    const memoryContext = await buildMemoryContext(chatId, rawText)
    const messageForAgent = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText

    const sessionId = getSession(chatId) ?? undefined
    const permissionMode = isAdmin(chatId) ? 'bypassPermissions' : 'plan'
    const { text, newSessionId } = await runAgent(messageForAgent, { sessionId, permissionMode, log })

    if (newSessionId && newSessionId !== sessionId) setSession(chatId, newSessionId)

    if (text) await saveConversationTurn(chatId, rawText, text)

    const replyText = text ?? '(no output)'
    const wantVoice =
      (opts.forceVoice || getTtsEnabled(chatId)) && voiceCapabilities().tts

    if (wantVoice && text) {
      try {
        await ctx.replyWithChatAction('record_voice').catch(() => {})
        const { audio, truncated } = await synthesizeSpeech(text)
        await ctx.replyWithVoice(new InputFile(audio, 'voice.ogg'))
        if (truncated) {
          await sendResponse(ctx, text)
        }
      } catch (err) {
        log.warn({ err }, 'TTS failed, falling back to text')
        await sendResponse(ctx, replyText)
      }
    } else {
      await sendResponse(ctx, replyText)
    }
  } catch (err) {
    log.error({ err }, 'handleMessage failed')
    const msg = err instanceof Error ? err.message : String(err)
    try {
      await ctx.reply(`Error: ${msg.slice(0, 500)}`)
    } catch {
      /* ignore */
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
}

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Run `npm run setup` first.')
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)

  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    const n = countAllowedChats()
    const authLine = n > 0
      ? `Auth configured (${n} chat${n === 1 ? '' : 's'} allowed).`
      : 'No authorised chats — message this chat ID to the admin to get whitelisted.'
    await ctx.reply(`ClaudeClaw online. Chat ID: ${chatId}\n\n${authLine}`)
  })

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Chat ID: ${String(ctx.chat?.id)}`)
  })

  bot.command(['newchat', 'forget'], async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    clearSession(chatId)
    await ctx.reply('Session cleared. Starting fresh.')
  })

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const total = countMemories(chatId)
    await ctx.reply(`Stored memories for this chat: ${total}`)
  })

  registerUserCommands(bot)

  registerPing(bot)
  registerStats(bot)
  registerHealth(bot)
  registerStatus(bot)
  registerModels(bot)

  registerBackup(bot)

  registerVoice(bot)

  registerVersion(bot)

  bot.on('message:text', async (ctx) => {
    const text = ctx.message?.text ?? ''
    if (text.startsWith('/')) return
    await handleMessage(ctx, text)
  })

  bot.on('message:voice', async (ctx) => {
    const { chatId, userId, username } = ctxIdentity(ctx)
    const log = logger.child({ chatId, userId, username })
    if (!isAuthorised(chatId)) {
      log.warn('unauthorised chat (voice)')
      return
    }
    if (!voiceCapabilities().stt) {
      await ctx.reply('Voice transcription is not configured (GROQ_API_KEY missing).')
      return
    }
    try {
      ensureUploadsDir()
      const fileId = ctx.message?.voice?.file_id
      if (!fileId) return
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, fileId, `voice_${Date.now()}.oga`)
      const transcript = await transcribeAudio(localPath)
      if (!transcript) {
        await ctx.reply('(voice transcription returned empty)')
        return
      }
      await ctx.reply(`Heard: "${transcript.slice(0, 200)}"`).catch(() => {})
      const wrapped = wrapUntrusted(transcript, 'voice_transcript', { source: 'groq-whisper' })
      await handleMessage(ctx, wrapped, { forceVoice: true })
    } catch (err) {
      log.error({ err }, 'voice handler failed')
      await ctx.reply(`Voice error: ${(err as Error).message}`).catch(() => {})
    }
  })

  bot.on('message:photo', async (ctx) => {
    const { chatId, userId, username } = ctxIdentity(ctx)
    const log = logger.child({ chatId, userId, username })
    if (!isAuthorised(chatId)) {
      log.warn('unauthorised chat (photo)')
      return
    }
    try {
      const photos = ctx.message?.photo
      if (!photos?.length) return
      const largest = photos[photos.length - 1]!
      const localPath = await downloadMedia(
        TELEGRAM_BOT_TOKEN,
        largest.file_id,
        `photo_${Date.now()}.jpg`,
      )
      const caption = ctx.message?.caption ?? ''
      await handleMessage(ctx, buildPhotoMessage(localPath, caption))
    } catch (err) {
      log.error({ err }, 'photo handler failed')
      await ctx.reply(`Photo error: ${(err as Error).message}`).catch(() => {})
    }
  })

  bot.on('message:document', async (ctx) => {
    const { chatId, userId, username } = ctxIdentity(ctx)
    const log = logger.child({ chatId, userId, username })
    if (!isAuthorised(chatId)) {
      log.warn('unauthorised chat (document)')
      return
    }
    try {
      const doc = ctx.message?.document
      if (!doc) return
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name)
      const caption = ctx.message?.caption ?? ''
      await handleMessage(
        ctx,
        buildDocumentMessage(localPath, doc.file_name ?? path.basename(localPath), caption),
      )
    } catch (err) {
      log.error({ err }, 'document handler failed')
      await ctx.reply(`Document error: ${(err as Error).message}`).catch(() => {})
    }
  })

  bot.catch((err) => {
    const e = err.error
    if (e instanceof GrammyError) {
      logger.error({ err: e, code: e.error_code }, 'grammy error')
    } else if (e instanceof HttpError) {
      logger.error({ err: e }, 'telegram http error')
    } else {
      logger.error({ err: e }, 'unknown bot error')
    }
  })

  return bot
}

export async function sendToChat(chatId: string, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set')
  const tmpBot = new Bot(TELEGRAM_BOT_TOKEN)
  const formatted = formatForTelegram(text)
  for (const chunk of splitMessage(formatted)) {
    try {
      await withRetry(
        () => tmpBot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' }),
        { label: 'tg-send-html' },
      )
    } catch (err) {
      if (isTransientError(err)) {
        logger.error({ err, chatId }, 'sendToChat HTML exhausted retries')
        continue
      }
      try {
        await withRetry(
          () => tmpBot.api.sendMessage(chatId, chunk),
          { label: 'tg-send-plain' },
        )
      } catch (err2) {
        logger.error({ err: err2, chatId }, 'sendToChat plain failed')
      }
    }
  }
}

