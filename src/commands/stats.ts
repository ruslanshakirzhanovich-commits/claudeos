import type { Bot } from 'grammy'
import { isAuthorised, getBotStats, getSchemaVersion } from '../db.js'

function formatUptime(seconds: number, short = false): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (short) return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
}

export function registerPing(bot: Bot): void {
  bot.command('ping', async (ctx) => {
    const uptimeStr = formatUptime(Math.round(process.uptime()))
    await ctx.reply(`pong · pid ${process.pid} · uptime ${uptimeStr}`)
  })
}

export function registerStats(bot: Bot): void {
  bot.command('stats', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const s = getBotStats()
    const mem = process.memoryUsage()
    const rssMb = (mem.rss / (1024 * 1024)).toFixed(0)
    const heapMb = (mem.heapUsed / (1024 * 1024)).toFixed(0)
    const uptimeStr = formatUptime(Math.round(process.uptime()), true)

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
}
