import fs from 'node:fs'
import path from 'node:path'
import type { Bot } from 'grammy'
import { parseChangelog } from '../format.js'
import { logger } from '../logger.js'

export function registerVersion(bot: Bot): void {
  bot.command('version', async (ctx) => {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8')
      const entries = parseChangelog(content, 2)
      if (entries.length === 0) {
        await ctx.reply('CHANGELOG unavailable')
        return
      }
      const blocks = entries
        .map((e) => `v${e.version} - ${e.date}\n${e.bullets.map((b) => `- ${b}`).join('\n')}`)
        .join('\n\n')
      await ctx.reply(`ClaudeClaw v${entries[0].version}\n\n${blocks}`)
    } catch (err) {
      logger.error({ err }, 'failed to read CHANGELOG')
      await ctx.reply('CHANGELOG unavailable')
    }
  })
}
