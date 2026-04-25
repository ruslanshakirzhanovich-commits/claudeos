import path from 'node:path'
import { Bot, type Context, GrammyError, HttpError, InputFile } from 'grammy'
import { TELEGRAM_BOT_TOKEN, TYPING_REFRESH_MS, isAdmin } from './config.js'
import { formatForTelegram, splitMessage } from './format.js'
import { nonOverlapping } from './scheduler.js'
import { registerVersion } from './commands/version.js'
import { registerVoice } from './commands/voice.js'
import { registerPing, registerStats } from './commands/stats.js'
import { registerUserCommands } from './commands/users.js'
import { registerBackup } from './commands/backup.js'
import { registerHealth } from './commands/health.js'
import { registerUpdate } from './commands/update.js'
import { registerModels } from './commands/models.js'
import { registerStatus } from './commands/status.js'
import { registerEffort } from './commands/effort.js'
import {
  clearSession,
  countMemories,
  getTtsEnabled,
  setTtsEnabled,
  isAuthorised,
  isOpenMode,
  countAllowedChats,
  getBotStats,
  touchAllowedChat,
  getSchemaVersion,
  addIdentityFact,
  listIdentityFacts,
  removeIdentityFact,
} from './db.js'
import { transcribeAudio, voiceCapabilities, synthesizeSpeech } from './voice.js'
import {
  downloadMedia,
  buildPhotoMessage,
  buildDocumentMessage,
  ensureUploadsDir,
} from './media.js'
import { logger } from './logger.js'
import { withRetry, isTransientError } from './retry.js'
import { trackInflight } from './inflight.js'
import { sendAllChunksOrMark } from './chunked-send.js'
import { addUserChat } from './users.js'
import { wrapUntrusted } from './untrusted.js'
import { resetUsage } from './usage.js'
import { rateLimitMessage } from './rate-limit.js'
import { runChatPipeline } from './chat-pipeline.js'

async function sendOneTelegramChunk(ctx: Context, chunk: string): Promise<void> {
  // First try HTML; on a non-transient HTML error (parser issues), fall
  // back to plain text. Transient HTML errors propagate so the outer
  // sendAllChunksOrMark retry counts them as one failed attempt.
  try {
    await ctx.reply(chunk, { parse_mode: 'HTML' })
  } catch (err) {
    if (isTransientError(err)) throw err
    logger.warn({ err }, 'HTML send failed, falling back to plain text')
    await ctx.reply(chunk)
  }
}

async function sendResponse(ctx: Context, text: string): Promise<void> {
  if (!text) {
    await ctx.reply('(no output)').catch(() => {})
    return
  }
  const formatted = formatForTelegram(text)
  await sendAllChunksOrMark(
    splitMessage(formatted),
    (chunk) => sendOneTelegramChunk(ctx, chunk),
    logger,
  )
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

function ctxIdentity(ctx: Context): {
  chatId: string
  userId: number | undefined
  username: string | undefined
} {
  return {
    chatId: String(ctx.chat?.id ?? ''),
    userId: ctx.from?.id,
    username: ctx.from?.username ?? ctx.from?.first_name,
  }
}

async function handleMessage(
  ctx: Context,
  agentInput: string,
  opts: { forceVoice?: boolean; memoryText?: string } = {},
): Promise<void> {
  return trackInflight(handleMessageInner(ctx, agentInput, opts))
}

async function handleMessageInner(
  ctx: Context,
  agentInput: string,
  opts: { forceVoice?: boolean; memoryText?: string } = {},
): Promise<void> {
  const { chatId, userId, username } = ctxIdentity(ctx)
  if (!chatId) return
  const log = logger.child({ chatId, userId, username })

  if (!isAuthorised(chatId)) {
    log.warn('unauthorised chat')
    return
  }

  if (isOpenMode()) {
    warnOpenModeOnce(chatId, userId, username, log)
    // Auto-add the first incoming chat as a new user (auto-promotes to admin
    // because users table is empty in open mode). Subsequent messages from
    // *other* chats will be rejected by isAuthorised above.
    addUserChat({
      chatId,
      channel: 'telegram',
      addedBy: 'open-mode',
      note: `auto-added from ${username ?? 'unknown'}`,
    })
  }

  touchAllowedChat(chatId)
  const memoryText = opts.memoryText ?? agentInput
  log.info({ preview: memoryText.slice(0, 80) }, 'message received')

  await ctx.replyWithChatAction('typing').catch(() => {})
  const sendTyping = nonOverlapping(async () => {
    await ctx.replyWithChatAction('typing').catch(() => {})
  })
  const typingInterval: NodeJS.Timeout = setInterval(sendTyping, TYPING_REFRESH_MS)

  try {
    const result = await runChatPipeline({
      chatId,
      userMessage: memoryText,
      wrappedUserMessage: agentInput,
      permissionMode: isAdmin(chatId) ? 'bypassPermissions' : 'plan',
      log,
    })

    if (result.kind === 'rate-limited') {
      await ctx.reply(rateLimitMessage(result.retryAfterMs)).catch(() => {})
      return
    }
    if (result.kind === 'error') {
      log.error({ err: result.error }, 'handleMessage failed')
      const message = result.error.message.slice(0, 500)
      await ctx.reply(`Error: ${message}`).catch(() => {})
      return
    }

    const text = result.text
    const replyText = text ?? '(no output)'
    const wantVoice = (opts.forceVoice || getTtsEnabled(chatId)) && voiceCapabilities().tts

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
  } finally {
    clearInterval(typingInterval)
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
    const authLine =
      n > 0
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
    resetUsage(chatId)
    await ctx.reply(
      'Session cleared. Starting fresh.\n\n' +
        'Note: long-term memory (facts the bot stored about you) is preserved. ' +
        'To wipe everything including memories, ask an admin to /removeuser then /adduser you again.',
    )
  })

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const total = countMemories(chatId)
    await ctx.reply(`Stored memories for this chat: ${total}`)
  })

  // Curated identity facts — survive decay/cap and are authoritative over
  // anything auto-captured in the recall pool.
  bot.command('remember', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const text = (ctx.match ?? '').toString().trim()
    if (!text) {
      await ctx.reply('Usage: /remember <fact>\n\nExample: /remember I prefer terse answers.')
      return
    }
    try {
      const added = addIdentityFact(chatId, text, 'user')
      await ctx.reply(added ? 'Got it. Added to your identity facts.' : 'Already remembered.')
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown'
      await ctx.reply(`Could not remember: ${msg.slice(0, 200)}`)
    }
  })

  bot.command('facts', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const facts = listIdentityFacts(chatId)
    if (facts.length === 0) {
      await ctx.reply('No identity facts yet. Use /remember <fact> to add one.')
      return
    }
    const lines = facts.map((f) => `#${f.id} — ${f.fact}`)
    await ctx.reply(`Identity facts (${facts.length}):\n\n${lines.join('\n')}`)
  })

  bot.command('forgetfact', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const raw = (ctx.match ?? '').toString().trim()
    const id = Number(raw)
    if (!raw || !Number.isFinite(id) || id <= 0) {
      await ctx.reply('Usage: /forgetfact <id>\n\nUse /facts to see ids.')
      return
    }
    const ok = removeIdentityFact(chatId, id)
    await ctx.reply(ok ? 'Forgotten.' : `No fact #${id} for this chat.`)
  })

  registerUserCommands(bot)

  registerPing(bot)
  registerStats(bot)
  registerHealth(bot)
  registerStatus(bot)
  registerModels(bot)
  registerEffort(bot)

  registerBackup(bot)
  registerUpdate(bot)

  registerVoice(bot)

  registerVersion(bot)

  bot.on('message:text', async (ctx) => {
    const text = ctx.message?.text ?? ''
    if (text.startsWith('/')) return
    const from = ctx.from?.username ?? ctx.from?.first_name ?? String(ctx.from?.id ?? '')
    const wrapped = wrapUntrusted(text, 'telegram_text', { from })
    await handleMessage(ctx, wrapped, { memoryText: text })
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
      await handleMessage(ctx, wrapped, { forceVoice: true, memoryText: transcript })
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
      await handleMessage(ctx, buildPhotoMessage(localPath, caption), {
        memoryText: caption || '[user sent a photo]',
      })
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
      const filename = doc.file_name ?? path.basename(localPath)
      await handleMessage(ctx, buildDocumentMessage(localPath, filename, caption), {
        memoryText: caption || `[user sent a document: ${filename}]`,
      })
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
      await withRetry(() => tmpBot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' }), {
        label: 'tg-send-html',
      })
    } catch (err) {
      if (isTransientError(err)) {
        logger.error({ err, chatId }, 'sendToChat HTML exhausted retries')
        continue
      }
      try {
        await withRetry(() => tmpBot.api.sendMessage(chatId, chunk), { label: 'tg-send-plain' })
      } catch (err2) {
        logger.error({ err: err2, chatId }, 'sendToChat plain failed')
      }
    }
  }
}
