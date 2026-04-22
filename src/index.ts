import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT, PID_FILE, STORE_DIR, TELEGRAM_BOT_TOKEN, DECAY_INTERVAL_MS, ALLOWED_CHAT_IDS, PREVIEW_ENABLED, PREVIEW_PORT } from './config.js'
import { initDatabase, seedAllowedChatsFromEnv } from './db.js'
import { createPreviewServer, cleanupOldPreviews } from './preview-server.js'
import { logger } from './logger.js'
import { createBot, sendToChat } from './bot.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads, ensureUploadsDir } from './media.js'
import { initScheduler } from './scheduler.js'
import { initWhatsApp, stopWhatsApp } from './whatsapp/index.js'

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝  (lite)
`

function showBanner(): void {
  const bannerFile = path.join(PROJECT_ROOT, 'banner.txt')
  if (fs.existsSync(bannerFile)) {
    process.stdout.write(fs.readFileSync(bannerFile, 'utf8') + '\n')
  } else {
    process.stdout.write(BANNER + '\n')
  }
}

function ensureDirs(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true })
  ensureUploadsDir()
}

function acquireLock(): void {
  ensureDirs()
  if (fs.existsSync(PID_FILE)) {
    const prevPidRaw = fs.readFileSync(PID_FILE, 'utf8').trim()
    const prevPid = Number(prevPidRaw)
    if (Number.isFinite(prevPid) && prevPid > 0 && prevPid !== process.pid) {
      try {
        process.kill(prevPid, 0)
        logger.warn({ prevPid }, 'killing stale instance before startup')
        try {
          process.kill(prevPid, 'SIGTERM')
        } catch {
          /* ignore */
        }
      } catch {
        logger.info({ prevPid }, 'stale pid file, overwriting')
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
}

function releaseLock(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pidInFile = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
      if (pidInFile === process.pid) fs.unlinkSync(PID_FILE)
    }
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  showBanner()

  if (!TELEGRAM_BOT_TOKEN) {
    process.stderr.write(
      'TELEGRAM_BOT_TOKEN is missing. Run `npm run setup` to configure, or add it to .env manually.\n',
    )
    process.exit(1)
  }

  acquireLock()
  initDatabase()
  const seeded = seedAllowedChatsFromEnv(ALLOWED_CHAT_IDS)
  if (seeded > 0) logger.info({ seeded }, 'seeded allowed_chats from ALLOWED_CHAT_IDS env')

  runDecaySweep()
  const decayTimer = setInterval(runDecaySweep, DECAY_INTERVAL_MS)

  cleanupOldUploads()
  cleanupOldPreviews()

  const bot = createBot()
  const schedulerTimer = initScheduler(async (chatId, text) => sendToChat(chatId, text))

  initWhatsApp().catch((err) => logger.error({ err }, 'WhatsApp init failed (continuing without)'))

  const previewServer = PREVIEW_ENABLED ? createPreviewServer(PREVIEW_PORT) : null

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    clearInterval(decayTimer)
    clearInterval(schedulerTimer)
    try {
      await bot.stop()
    } catch {
      /* ignore */
    }
    await stopWhatsApp()
    if (previewServer) previewServer.close()
    releaseLock()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException')
  })
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandledRejection')
  })

  try {
    logger.info('ClaudeClaw starting — Telegram bot going live')
    await bot.start({
      onStart: (info) => logger.info({ username: info.username }, 'bot online'),
    })
  } catch (err) {
    logger.error({ err }, 'bot failed to start')
    releaseLock()
    process.exit(1)
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal')
  releaseLock()
  process.exit(1)
})
