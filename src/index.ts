import fs from 'node:fs'
import path from 'node:path'
import {
  PROJECT_ROOT,
  PID_FILE,
  STORE_DIR,
  TELEGRAM_BOT_TOKEN,
  DECAY_INTERVAL_MS,
  ADMIN_CHAT_IDS,
  ALLOWED_DISCORD_USERS,
  ADMIN_DISCORD_USERS,
  ALLOWED_WHATSAPP_NUMBERS,
  ADMIN_WHATSAPP_NUMBERS,
  PREVIEW_ENABLED,
  PREVIEW_PORT,
  BACKUP_SCHEDULE_ENABLED,
  BACKUP_INTERVAL_HOURS,
  BACKUP_KEEP,
  MEMORY_SUMMARIZE_ENABLED,
  MEMORY_SUMMARIZE_INTERVAL_HOURS,
  MEMORY_SUMMARIZE_MIN_AGE_DAYS,
  MEMORY_SUMMARIZE_BATCH,
  MEMORY_SUMMARIZE_MIN_BATCH,
  HEALTH_ENABLED,
  HEALTH_HOST,
  HEALTH_PORT,
  WHATSAPP_ENABLED,
  DISCORD_ENABLED,
} from './config.js'
import { initDatabase, isOpenMode, closeDb, getSchemaVersion } from './db.js'
import { startHealthServer, type HealthServer } from './health.js'
import { BOT_VERSION } from './version.js'
import { createPreviewServer, cleanupOldPreviews } from './preview-server.js'
import { logger } from './logger.js'
import { createBot, sendToChat } from './bot.js'
import { publishBotCommands } from './commands-menu.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads, ensureUploadsDir } from './media.js'
import { initScheduler } from './scheduler.js'
import { initWhatsApp, stopWhatsApp } from './whatsapp/index.js'
import { initDiscord, stopDiscord } from './discord/index.js'
import { createChannelRouter } from './channel-router.js'
import { waitForInflight, inflightCount } from './inflight.js'
import { initBackupSchedule } from './backup.js'
import { recordCrash } from './metrics.js'
import { runMemorySummarizeSweep, summarizeViaAgentSdk } from './memory-summarize.js'

const INFLIGHT_DRAIN_TIMEOUT_MS = 30_000

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
  // Pass env-driven seed lists into the v8 migration. Subsequent boots
  // (after v8 is applied) ignore them — DB is the source of truth.
  initDatabase({
    adminTelegram: ADMIN_CHAT_IDS,
    allowedDiscord: ALLOWED_DISCORD_USERS,
    adminDiscord: ADMIN_DISCORD_USERS,
    allowedWhatsapp: ALLOWED_WHATSAPP_NUMBERS,
    adminWhatsapp: ADMIN_WHATSAPP_NUMBERS,
  })

  if (isOpenMode()) {
    logger.warn(
      '⚠️  OPEN MODE: users table is empty — the bot will accept the first ' +
        'message from any chat (auto-promoted to admin). Intended only for ' +
        'first-run bootstrap. Set ALLOWED_CHAT_IDS in .env or use /adduser to close the door.',
    )
  }

  // runDecaySweep is async now (batched cap yields to the event loop).
  // Fire-and-forget is fine for the periodic sweep: errors are already
  // logged inside runDecaySweep, and a failed sweep should not crash the
  // process or block startup.
  void runDecaySweep()
  const decayTimer = setInterval(
    () => void runDecaySweep().catch((err) => logger.error({ err }, 'decay sweep crashed')),
    DECAY_INTERVAL_MS,
  )

  cleanupOldUploads()
  cleanupOldPreviews()

  const bot = createBot()
  void publishBotCommands(bot)
  // Route scheduler sends by chat_id prefix → Telegram / Discord / WhatsApp.
  // Previously hard-wired to sendToChat (Telegram), so scheduled tasks
  // for Discord/WhatsApp chats silently failed at delivery time.
  const schedulerTimer = initScheduler(createChannelRouter())

  initWhatsApp().catch((err) => logger.error({ err }, 'WhatsApp init failed (continuing without)'))
  initDiscord().catch((err) => logger.error({ err }, 'Discord init failed (continuing without)'))

  const previewServer = PREVIEW_ENABLED ? createPreviewServer(PREVIEW_PORT) : null

  const backupTimer = BACKUP_SCHEDULE_ENABLED
    ? initBackupSchedule(BACKUP_INTERVAL_HOURS, BACKUP_KEEP)
    : null
  if (!BACKUP_SCHEDULE_ENABLED) {
    logger.warn('BACKUP_SCHEDULE_ENABLED=0 — automatic backups disabled')
  }

  const startedAt = Date.now()
  let healthServer: HealthServer | null = null
  if (HEALTH_ENABLED) {
    try {
      healthServer = await startHealthServer({
        host: HEALTH_HOST,
        port: HEALTH_PORT,
        source: () => ({
          ok: true,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          version: BOT_VERSION,
          schemaVersion: getSchemaVersion(),
          channels: {
            telegram: TELEGRAM_BOT_TOKEN ? 'ok' : 'disabled',
            discord: DISCORD_ENABLED ? 'ok' : 'disabled',
            whatsapp: WHATSAPP_ENABLED ? 'ok' : 'disabled',
          },
        }),
      })
      logger.info({ host: HEALTH_HOST, port: healthServer.port }, 'health endpoint listening')
    } catch (err) {
      logger.warn({ err }, 'health endpoint failed to start (continuing without)')
    }
  }

  let summarizeTimer: NodeJS.Timeout | null = null
  let summarizeRunning = false
  if (MEMORY_SUMMARIZE_ENABLED) {
    const summarizeCfg = {
      minAgeDays: MEMORY_SUMMARIZE_MIN_AGE_DAYS,
      batch: MEMORY_SUMMARIZE_BATCH,
      minBatch: MEMORY_SUMMARIZE_MIN_BATCH,
    }
    const runSummarize = async (): Promise<void> => {
      if (summarizeRunning) {
        logger.warn('memory summarize sweep skipped — previous run still in flight')
        return
      }
      summarizeRunning = true
      try {
        const result = await runMemorySummarizeSweep(summarizeCfg, summarizeViaAgentSdk)
        logger.info({ ...result }, 'memory summarize sweep complete')
      } catch (err) {
        logger.warn({ err }, 'memory summarize sweep failed')
      } finally {
        summarizeRunning = false
      }
    }
    // First sweep 10 min after start to avoid hammering the SDK during boot,
    // then on the configured interval. Each tick is guarded by the
    // summarizeRunning lock so a slow sweep can't stack up.
    setTimeout(() => void runSummarize(), 10 * 60 * 1000)
    summarizeTimer = setInterval(
      () => void runSummarize(),
      MEMORY_SUMMARIZE_INTERVAL_HOURS * 60 * 60 * 1000,
    )
  }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal, inflight: inflightCount() }, 'shutting down')
    clearInterval(decayTimer)
    clearInterval(schedulerTimer)
    if (backupTimer) clearInterval(backupTimer)
    if (summarizeTimer) clearInterval(summarizeTimer)
    try {
      await bot.stop()
    } catch {
      /* ignore */
    }
    await stopWhatsApp()
    await stopDiscord()
    const remaining = await waitForInflight(INFLIGHT_DRAIN_TIMEOUT_MS)
    if (remaining > 0) {
      logger.warn({ remaining }, 'exiting with inflight work still running')
    }
    if (previewServer) previewServer.close()
    if (healthServer) {
      try {
        await healthServer.stop()
      } catch {
        /* ignore */
      }
    }
    closeDb()
    releaseLock()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  const notifyAdminsOnCrash = async (err: unknown, kind: string) => {
    for (const adminId of ADMIN_CHAT_IDS) {
      try {
        const msg = (err as Error)?.stack ?? (err as Error)?.message ?? String(err)
        await sendToChat(adminId, `⚠️ ${kind}\n\n<pre>${msg.slice(0, 3000)}</pre>`)
      } catch {
        /* ignore — alert is best-effort */
      }
    }
  }
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException')
    recordCrash('uncaughtException', err)
    void notifyAdminsOnCrash(err, 'uncaughtException')
  })
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandledRejection')
    recordCrash('unhandledRejection', err)
    void notifyAdminsOnCrash(err, 'unhandledRejection')
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
