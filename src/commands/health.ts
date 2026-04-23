import type { Bot } from 'grammy'
import { isAdmin } from '../config.js'
import { snapshot } from '../metrics.js'
import { inflightCount } from '../inflight.js'

function fmtAgo(ts: number | null): string {
  if (!ts) return 'never'
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

export function registerHealth(bot: Bot): void {
  bot.command('health', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const s = snapshot()
    const c = s.counters
    const errorRate =
      c.agent_success.total + c.agent_error.total === 0
        ? '-'
        : `${((c.agent_error.total * 100) / (c.agent_success.total + c.agent_error.total)).toFixed(1)}%`

    const lines = [
      `<b>ClaudeClaw health</b>`,
      ``,
      `<b>Last hour</b>`,
      `  agent ok: ${c.agent_success.lastHour}`,
      `  agent errors: ${c.agent_error.lastHour}`,
      `  scheduler runs: ${c.scheduler_run.lastHour}`,
      `  scheduler skips: ${c.scheduler_skip.lastHour}`,
      ``,
      `<b>Since boot</b>`,
      `  agent runs: ${c.agent_success.total + c.agent_error.total} (${errorRate} errors)`,
      `  scheduler runs: ${c.scheduler_run.total}`,
      `  scheduler skips: ${c.scheduler_skip.total}`,
      `  backups ok/fail: ${c.backup_ok.total}/${c.backup_fail.total}`,
      `  inflight now: ${inflightCount()}`,
      ``,
      `<b>Recent</b>`,
      `  last backup: ${fmtAgo(s.lastBackupAt)}`,
      `  last crash: ${s.lastCrash ? `${fmtAgo(s.lastCrash.at)} (${s.lastCrash.kind})` : 'none'}`,
    ]

    if (s.lastCrash) {
      lines.push('', `<pre>${s.lastCrash.message.slice(0, 400)}</pre>`)
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })
}
