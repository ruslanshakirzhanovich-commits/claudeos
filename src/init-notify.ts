import { ADMIN_CHAT_IDS } from './config.js'
import { sendToChat } from './bot.js'
import { logger } from './logger.js'
import { recordCrash } from './metrics.js'
import { shouldNotifyCrash } from './crash-dedup.js'

export async function notifyAdminsOnCrash(err: unknown, kind: string): Promise<void> {
  if (!shouldNotifyCrash(kind, err)) return
  const msg = (err as Error)?.stack ?? (err as Error)?.message ?? String(err)
  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await sendToChat(adminId, `⚠️ ${kind}\n\n<pre>${msg.slice(0, 3000)}</pre>`)
    } catch {
      /* alert is best-effort */
    }
  }
}

export async function notifyAdminsOnInitFailure(
  channel: string,
  err: unknown,
): Promise<void> {
  if (!shouldNotifyCrash(`init:${channel}`, err)) return
  const msg = (err as Error)?.message ?? String(err)
  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await sendToChat(
        adminId,
        `⚠️ ${channel} init failed\n\n<pre>${msg.slice(0, 1000)}</pre>\n\nBot is still running on Telegram. Logs have full stack.`,
      )
    } catch {
      /* best-effort */
    }
  }
  logger.error({ err, channel }, 'init failure notified to admins')
  recordCrash(`init:${channel}`, err)
}
