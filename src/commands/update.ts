import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Bot } from 'grammy'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { adminGuard } from './_admin-guard.js'

const execFileAsync = promisify(execFile)

// Budget for a deploy-log slice returned via /updatelog. Telegram caps
// messages at 4096 chars, so we leave a comfortable headroom for a header.
const DEPLOY_LOG_MAX_BYTES = 3_500

export function deployLogPath(storeDir: string): string {
  // Lives in store/ (not /tmp/) so it survives the systemd PrivateTmp
  // namespace — the bot previously wrote to /tmp/claudeclaw-deploy.log,
  // which is invisible outside the service's private mount namespace.
  return path.join(storeDir, 'deploy.log')
}

export interface DeployCommand {
  cmd: string
  args: string[]
}

// Wraps deploy.sh in a systemd-run transient scope so the child lives in its
// own cgroup. Without this, `sudo systemctl restart claudeclaw` inside the
// script would kill the entire claudeclaw.service cgroup — including the
// deploy script itself, half-way through its work.
export function buildDeployCommand(scriptPath: string, nowMs: number = Date.now()): DeployCommand {
  return {
    cmd: 'sudo',
    args: [
      'systemd-run',
      '--scope',
      '--collect',
      '--unit',
      `claudeclaw-deploy-${nowMs}`,
      'bash',
      scriptPath,
    ],
  }
}

// Returns the last `maxLines` of deploy.log, capped at DEPLOY_LOG_MAX_BYTES.
// Returns a placeholder string if the log has never been written.
export async function readDeployLogTail(storeDir: string, maxLines: number): Promise<string> {
  const logFile = deployLogPath(storeDir)
  let content: string
  try {
    content = await fsp.readFile(logFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '(no deploy log yet — /update has not been invoked since the last PrivateTmp change)'
    }
    throw err
  }
  const lines = content.replace(/\n+$/, '').split('\n')
  const sliced = lines.slice(-maxLines).join('\n')
  if (sliced.length <= DEPLOY_LOG_MAX_BYTES) return sliced
  // Keep the tail: freshest lines matter most when diagnosing a failed deploy.
  return sliced.slice(sliced.length - DEPLOY_LOG_MAX_BYTES)
}

async function gitFetch(): Promise<{ ahead: number; remote: string; local: string }> {
  await execFileAsync('git', ['-C', PROJECT_ROOT, 'fetch', 'origin', 'main'])
  const { stdout: local } = await execFileAsync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'HEAD'])
  const { stdout: remote } = await execFileAsync('git', [
    '-C',
    PROJECT_ROOT,
    'rev-parse',
    'origin/main',
  ])
  if (local.trim() === remote.trim()) {
    return { ahead: 0, remote: remote.trim(), local: local.trim() }
  }
  const { stdout: count } = await execFileAsync('git', [
    '-C',
    PROJECT_ROOT,
    'rev-list',
    '--count',
    'HEAD..origin/main',
  ])
  return { ahead: Number(count.trim()) || 0, remote: remote.trim(), local: local.trim() }
}

async function gitLogPreview(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      PROJECT_ROOT,
      'log',
      '--oneline',
      '--no-decorate',
      '-10',
      'HEAD..origin/main',
    ])
    return stdout.trim()
  } catch {
    return '(no log)'
  }
}

export function registerUpdate(bot: Bot): void {
  const DEPLOY_LOG = deployLogPath(STORE_DIR)

  bot.command('update', async (ctx) => {
    const guard = await adminGuard(ctx)
    if (!guard.ok) return

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
      await ctx.reply(`Already up to date at <code>${info.local.slice(0, 8)}</code>.`, {
        parse_mode: 'HTML',
      })
      return
    }

    const preview = await gitLogPreview()
    const header = `${info.ahead} commit${info.ahead === 1 ? '' : 's'} behind origin/main:\n\n<pre>${preview}</pre>`

    if (dryRun) {
      await ctx.reply(`${header}\n\nRun /update without --dry to deploy.`, { parse_mode: 'HTML' })
      return
    }

    await ctx.reply(
      `${header}\n\nDeploying… bot will restart in ~30s. Check /version + /ping after.\nLogs: <code>${DEPLOY_LOG}</code> (tail via /updatelog)`,
      { parse_mode: 'HTML' },
    )

    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'deploy.sh')
    const { cmd, args: spawnArgs } = buildDeployCommand(scriptPath)

    // stdout+stderr -> deploy.log via file descriptors. Detached so the
    // deploy survives the Telegram reply-promise resolving.
    const logFd = fs.openSync(DEPLOY_LOG, 'w')
    const child = spawn(cmd, spawnArgs, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
    fs.closeSync(logFd)

    logger.info({ pid: child.pid, log: DEPLOY_LOG }, '/update spawned deploy.sh in scope')
  })

  bot.command('updatelog', async (ctx) => {
    const guard = await adminGuard(ctx)
    if (!guard.ok) return
    const tail = await readDeployLogTail(STORE_DIR, 200)
    await ctx.reply(`<pre>${tail}</pre>`, { parse_mode: 'HTML' }).catch(async () => {
      // Fallback to plain text if the log contains HTML-hostile characters.
      await ctx.reply(tail)
    })
  })
}
