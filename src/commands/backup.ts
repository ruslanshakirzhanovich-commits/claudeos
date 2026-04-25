import type { Bot } from 'grammy'
import { InputFile } from 'grammy'
import { BACKUP_KEEP } from '../config.js'
import { createAndVerifyBackup, rotateBackups } from '../backup.js'
import { logger } from '../logger.js'
import { adminGuard } from './_admin-guard.js'

const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024

export function registerBackup(bot: Bot): void {
  bot.command('backup', async (ctx) => {
    const guard = await adminGuard(ctx)
    if (!guard.ok) return
    try {
      let result
      try {
        result = createAndVerifyBackup()
      } catch (err) {
        await ctx.reply(`Backup failed verification: ${(err as Error).message.slice(0, 200)}`)
        return
      }
      const { path: destPath, sizeBytes, verification: v } = result
      const rotation = rotateBackups(BACKUP_KEEP)
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2)
      const verifyLine = ` · verified (schema v${v.schemaVersion}, ${v.sessions} sessions, ${v.memories} memories, ${v.allowedChats} chats)`
      const rotatedLine =
        rotation.removed > 0 || rotation.failed > 0
          ? ` · pruned ${rotation.removed} old${rotation.failed > 0 ? ` (${rotation.failed} failed)` : ''}`
          : ''
      await ctx.reply(
        `Backup saved: <code>${destPath}</code> (${sizeMb} MB)${verifyLine}${rotatedLine}`,
        { parse_mode: 'HTML' },
      )

      if (sizeBytes <= TELEGRAM_FILE_LIMIT) {
        try {
          await ctx.replyWithDocument(new InputFile(destPath))
        } catch (err) {
          logger.warn({ err }, 'backup upload to Telegram failed')
          await ctx.reply(
            '(Backup saved locally but upload to Telegram failed — file is on the server.)',
          )
        }
      } else {
        await ctx.reply(
          `(File >${TELEGRAM_FILE_LIMIT / 1024 / 1024}MB — not uploading to Telegram. Grab from server.)`,
        )
      }
    } catch (err) {
      logger.error({ err }, 'backup failed')
      await ctx.reply(`Backup failed: ${(err as Error).message.slice(0, 200)}`)
    }
  })
}
