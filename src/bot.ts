import fs from 'node:fs'
import path from 'node:path'
import { Bot, type Context, GrammyError, HttpError, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  STORE_DIR,
  isAdmin,
} from './config.js'
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
import { createAndVerifyBackup } from './backup.js'
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

interface ChangelogEntry {
  version: string
  date: string
  bullets: string[]
}

export function parseChangelog(content: string, limit = 2): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null

  for (const line of content.split('\n')) {
    const header = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(.+?)\s*$/)
    if (header) {
      if (current) entries.push(current)
      if (entries.length >= limit) return entries
      current = { version: header[1], date: header[2], bullets: [] }
      continue
    }
    if (current && line.startsWith('- ')) {
      current.bullets.push(line.slice(2).replace(/`/g, '').trim())
    }
  }
  if (current && entries.length < limit) entries.push(current)
  return entries
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
    typingInterval = setInterval(
      () => ctx.replyWithChatAction('typing').catch(() => {}),
      TYPING_REFRESH_MS,
    )

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
    await ctx.reply(`<b>Authorised chats (${rows.length})</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' })
  })

  bot.command('adduser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const parts = (ctx.message?.text ?? '').split(/\s+/)
    const targetId = parts[1]?.trim()
    const note = parts.slice(2).join(' ').trim() || null
    if (!targetId || !/^-?\d+$/.test(targetId)) {
      await ctx.reply('Usage: /adduser &lt;chat_id&gt; [note]', { parse_mode: 'HTML' })
      return
    }
    const added = addAllowedChat(targetId, chatId, note)
    await ctx.reply(added ? `Added ${targetId}.` : `${targetId} was already authorised.`)
  })

  bot.command('removeuser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const targetId = (ctx.message?.text ?? '').split(/\s+/)[1]?.trim()
    if (!targetId || !/^-?\d+$/.test(targetId)) {
      await ctx.reply('Usage: /removeuser &lt;chat_id&gt;', { parse_mode: 'HTML' })
      return
    }
    if (isAdmin(targetId)) {
      await ctx.reply('Cannot remove an admin. Edit ADMIN_CHAT_IDS in .env first.')
      return
    }
    const removed = removeAllowedChat(targetId)
    await ctx.reply(removed ? `Removed ${targetId}.` : `${targetId} was not in the list.`)
  })

  bot.command('ping', async (ctx) => {
    const up = Math.round(process.uptime())
    const d = Math.floor(up / 86400)
    const h = Math.floor((up % 86400) / 3600)
    const m = Math.floor((up % 3600) / 60)
    const s = up % 60
    const uptimeStr = d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
    await ctx.reply(`pong · pid ${process.pid} · uptime ${uptimeStr}`)
  })

  bot.command('stats', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const s = getBotStats()
    const mem = process.memoryUsage()
    const rssMb = (mem.rss / (1024 * 1024)).toFixed(0)
    const heapMb = (mem.heapUsed / (1024 * 1024)).toFixed(0)
    const up = Math.round(process.uptime())
    const d = Math.floor(up / 86400)
    const h = Math.floor((up % 86400) / 3600)
    const m = Math.floor((up % 3600) / 60)
    const uptimeStr = d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`

    const body = [
      `<b>ClaudeClaw stats</b>`,
      ``,
      `<b>Users</b>`,
      `  authorised chats: ${s.allowedChats}`,
      `  chats with memory: ${s.uniqueChatsWithMemories}`,
      ``,
      `<b>Memory</b>`,
      `  total records: ${s.totalMemories}`,
      `  added last 24h: ${s.memoriesLast24h}`,
      ``,
      `<b>Scheduler</b>`,
      `  active tasks: ${s.activeTasks}`,
      `  paused tasks: ${s.pausedTasks}`,
      ``,
      `<b>Process</b>`,
      `  pid: ${process.pid}`,
      `  uptime: ${uptimeStr}`,
      `  memory (RSS / heap): ${rssMb}MB / ${heapMb}MB`,
      `  node: ${process.versions.node}`,
      `  schema version: ${getSchemaVersion()}`,
    ].join('\n')

    await ctx.reply(body, { parse_mode: 'HTML' })
  })

  bot.command('backup', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    try {
      let result
      try {
        result = createAndVerifyBackup()
      } catch (err) {
        await ctx.reply(`Backup failed verification: ${(err as Error).message.slice(0, 200)}`)
        return
      }
      const { path: destPath, sizeBytes, verification: v } = result
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2)
      const verifyLine = ` · verified (schema v${v.schemaVersion}, ${v.sessions} sessions, ${v.memories} memories, ${v.allowedChats} chats)`
      await ctx.reply(`Backup saved: <code>${destPath}</code> (${sizeMb} MB)${verifyLine}`, { parse_mode: 'HTML' })

      const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024
      if (sizeBytes <= TELEGRAM_FILE_LIMIT) {
        try {
          await ctx.replyWithDocument(new InputFile(destPath))
        } catch (err) {
          logger.warn({ err }, 'backup upload to Telegram failed')
          await ctx.reply('(Backup saved locally but upload to Telegram failed — file is on the server.)')
        }
      } else {
        await ctx.reply(`(File >${TELEGRAM_FILE_LIMIT / 1024 / 1024}MB — not uploading to Telegram. Grab from server.)`)
      }
    } catch (err) {
      logger.error({ err }, 'backup failed')
      await ctx.reply(`Backup failed: ${(err as Error).message.slice(0, 200)}`)
    }
  })

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const caps = voiceCapabilities()
    const arg = (ctx.message?.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? 'status'

    if (arg === 'on') {
      if (!caps.tts) {
        await ctx.reply(
          'TTS not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env.',
        )
        return
      }
      setTtsEnabled(chatId, true)
      await ctx.reply('Voice replies: ON')
      return
    }
    if (arg === 'off') {
      setTtsEnabled(chatId, false)
      await ctx.reply('Voice replies: OFF')
      return
    }
    const enabled = getTtsEnabled(chatId)
    const lines = [
      `Voice replies: ${enabled ? 'ON' : 'OFF'}`,
      `TTS available: ${caps.tts ? 'yes' : 'no (ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing)'}`,
      'Usage: /voice on | /voice off | /voice status',
    ]
    await ctx.reply(lines.join('\n'))
  })

  bot.command('version', async (ctx) => {
    try {
      const content = fs.readFileSync(
        path.join(process.cwd(), 'CHANGELOG.md'),
        'utf8',
      )
      const entries = parseChangelog(content, 2)
      if (entries.length === 0) {
        await ctx.reply('CHANGELOG unavailable')
        return
      }
      const blocks = entries
        .map(
          (e) =>
            `v${e.version} - ${e.date}\n${e.bullets.map((b) => `- ${b}`).join('\n')}`,
        )
        .join('\n\n')
      await ctx.reply(`ClaudeClaw v${entries[0].version}\n\n${blocks}`)
    } catch (err) {
      logger.error({ err }, 'failed to read CHANGELOG')
      await ctx.reply('CHANGELOG unavailable')
    }
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

// Silence unused-file warning on fs import in some setups
void fs
