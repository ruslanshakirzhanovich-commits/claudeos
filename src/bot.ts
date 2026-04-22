import fs from 'node:fs'
import path from 'node:path'
import { Bot, type Context, GrammyError, HttpError } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_IDS,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  isAuthorised,
} from './config.js'
import { runAgent } from './agent.js'
import { getSession, setSession, clearSession, countMemories } from './db.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { transcribeAudio, voiceCapabilities } from './voice.js'
import {
  downloadMedia,
  buildPhotoMessage,
  buildDocumentMessage,
  ensureUploadsDir,
} from './media.js'
import { logger } from './logger.js'

export function formatForTelegram(text: string): string {
  if (!text) return ''

  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  let work = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push(code)
    return `\u0001CB${idx}\u0001`
  })

  work = work.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(code)
    return `\u0001IC${idx}\u0001`
  })

  work = work
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  work = work
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^\n_]+)__/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^\n*]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^\n_]+)_/g, '$1<i>$2</i>')
    .replace(/~~([^\n~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^\s*[-*+]\s+\[ \]\s+/gm, '☐ ')
    .replace(/^\s*[-*+]\s+\[[xX]\]\s+/gm, '☑ ')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/^-{3,}$/gm, '')
    .replace(/^\*{3,}$/gm, '')

  work = work.replace(/\u0001IC(\d+)\u0001/g, (_m, idx) => {
    const code = inlineCodes[Number(idx)] ?? ''
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<code>${escaped}</code>`
  })
  work = work.replace(/\u0001CB(\d+)\u0001/g, (_m, idx) => {
    const code = codeBlocks[Number(idx)] ?? ''
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre>${escaped}</pre>`
  })

  work = work.replace(/\n{3,}/g, '\n\n')
  return work.trim()
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit)
    if (cut < 0) cut = limit
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).replace(/^\s+/, '')
  }
  if (remaining.length) chunks.push(remaining)
  return chunks
}

async function sendResponse(ctx: Context, text: string): Promise<void> {
  if (!text) {
    await ctx.reply('(no output)')
    return
  }
  const formatted = formatForTelegram(text)
  for (const chunk of splitMessage(formatted)) {
    try {
      await ctx.reply(chunk, { parse_mode: 'HTML' })
    } catch (err) {
      logger.warn({ err }, 'HTML send failed, falling back to plain text')
      try {
        await ctx.reply(chunk)
      } catch (err2) {
        logger.error({ err: err2 }, 'plain text send failed too')
      }
    }
  }
}

function ctxIdentity(ctx: Context): { chatId: string; userId: number | undefined; username: string | undefined } {
  return {
    chatId: String(ctx.chat?.id ?? ''),
    userId: ctx.from?.id,
    username: ctx.from?.username ?? ctx.from?.first_name,
  }
}

async function handleMessage(ctx: Context, rawText: string): Promise<void> {
  const { chatId, userId, username } = ctxIdentity(ctx)
  if (!chatId) return
  const log = logger.child({ chatId, userId, username })

  if (!isAuthorised(chatId)) {
    log.warn('unauthorised chat')
    return
  }

  log.info({ preview: rawText.slice(0, 80) }, 'message received')

  let typingInterval: NodeJS.Timeout | null = null
  try {
    await ctx.replyWithChatAction('typing').catch(() => {})
    typingInterval = setInterval(
      () => ctx.replyWithChatAction('typing').catch(() => {}),
      TYPING_REFRESH_MS,
    )

    const memoryContext = await buildMemoryContext(chatId, rawText)
    const messageForAgent = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText

    const sessionId = getSession(chatId) ?? undefined
    const { text, newSessionId } = await runAgent(messageForAgent, sessionId)

    if (newSessionId && newSessionId !== sessionId) setSession(chatId, newSessionId)

    if (text) await saveConversationTurn(chatId, rawText, text)

    await sendResponse(ctx, text ?? '(no output)')
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
    const authLine = ALLOWED_CHAT_IDS.length
      ? `Auth configured (${ALLOWED_CHAT_IDS.length} chat${ALLOWED_CHAT_IDS.length === 1 ? '' : 's'} allowed).`
      : 'No ALLOWED_CHAT_IDS set yet — add this chat ID to your .env.'
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
      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`)
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
      logger.error({ err: e.description }, 'grammy error')
    } else if (e instanceof HttpError) {
      logger.error({ err: e.message }, 'telegram http error')
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
      await tmpBot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
    } catch {
      await tmpBot.api.sendMessage(chatId, chunk).catch(() => {})
    }
  }
}

// Silence unused-file warning on fs import in some setups
void fs
