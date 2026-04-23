import path from 'node:path'
import fs from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Bot } from 'grammy'
import { isAdmin, PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

const execFileAsync = promisify(execFile)

const DEPLOY_LOG = '/tmp/claudeclaw-deploy.log'

async function gitFetch(): Promise<{ ahead: number; remote: string; local: string }> {
  await execFileAsync('git', ['-C', PROJECT_ROOT, 'fetch', 'origin', 'main'])
  const { stdout: local } = await execFileAsync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'HEAD'])
  const { stdout: remote } = await execFileAsync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'origin/main'])
  if (local.trim() === remote.trim()) {
    return { ahead: 0, remote: remote.trim(), local: local.trim() }
  }
  const { stdout: count } = await execFileAsync('git', [
    '-C', PROJECT_ROOT, 'rev-list', '--count', 'HEAD..origin/main',
  ])
  return { ahead: Number(count.trim()) || 0, remote: remote.trim(), local: local.trim() }
}

async function gitLogPreview(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', PROJECT_ROOT, 'log', '--oneline', '--no-decorate', '-10', 'HEAD..origin/main',
    ])
    return stdout.trim()
  } catch {
    return '(no log)'
  }
}

export function registerUpdate(bot: Bot): void {
  bot.command('update', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }

    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1)
    const dryRun = args.includes('--dry') || args.includes('-n')

    let info
    try {
      info = await gitFetch()
    } catch (err) {
      logger.error({ err }, '/update fetch failed')
      await ctx.reply(`git fetch failed: ${(err as Error).message.slice(0, 200)}`)
      return
    }

    if (info.ahead === 0) {
      await ctx.reply(`Already up to date at <code>${info.local.slice(0, 8)}</code>.`, { parse_mode: 'HTML' })
      return
    }

    const preview = await gitLogPreview()
    const header = `${info.ahead} commit${info.ahead === 1 ? '' : 's'} behind origin/main:\n\n<pre>${preview}</pre>`

    if (dryRun) {
      await ctx.reply(`${header}\n\nRun /update without --dry to deploy.`, { parse_mode: 'HTML' })
      return
    }

    await ctx.reply(
      `${header}\n\nDeploying… bot will restart in ~30s. Check /version + /ping after.\nLogs: <code>${DEPLOY_LOG}</code>`,
      { parse_mode: 'HTML' },
    )

    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'deploy.sh')
    // Open log file and bind it to the child's stdout+stderr directly via
    // file descriptors. setsid + detached so the deploy survives systemctl
    // killing this process.
    const logFd = fs.openSync(DEPLOY_LOG, 'w')
    const child = spawn('setsid', ['bash', scriptPath], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
    fs.closeSync(logFd)

    logger.info({ pid: child.pid, log: DEPLOY_LOG }, '/update spawned deploy.sh')
  })
}
