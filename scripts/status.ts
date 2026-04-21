import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m' }
const ok = (s: string) => process.stdout.write(`${C.green}✓${C.reset} ${s}\n`)
const warn = (s: string) => process.stdout.write(`${C.yellow}⚠${C.reset} ${s}\n`)
const bad = (s: string) => process.stdout.write(`${C.red}✗${C.reset} ${s}\n`)
const dim = (s: string) => process.stdout.write(`${C.dim}${s}${C.reset}\n`)

function readEnv(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env')
  const out: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return out
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}

async function httpGetJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (err) {
            reject(err)
          }
        })
      })
      .on('error', reject)
  })
}

async function main(): Promise<void> {
  dim(`ClaudeClaw status — ${new Date().toISOString()}`)
  dim(`Project: ${PROJECT_ROOT}\n`)

  const nv = process.versions.node
  if (Number(nv.split('.')[0]) >= 20) ok(`Node.js ${nv}`)
  else bad(`Node.js ${nv} (need >= 20)`)

  try {
    const v = execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    ok(`Claude CLI: ${v || 'present'}`)
  } catch {
    bad('Claude CLI not on PATH')
  }

  const env = readEnv()

  if (env['TELEGRAM_BOT_TOKEN']) {
    try {
      const r = await httpGetJson(`https://api.telegram.org/bot${env['TELEGRAM_BOT_TOKEN']}/getMe`)
      if (r?.ok) ok(`Telegram bot: @${r.result.username}`)
      else bad(`Telegram getMe failed: ${JSON.stringify(r)}`)
    } catch (err) {
      bad(`Telegram check failed: ${(err as Error).message}`)
    }
  } else {
    bad('TELEGRAM_BOT_TOKEN not set')
  }

  if (env['ALLOWED_CHAT_ID']) ok(`ALLOWED_CHAT_ID configured`)
  else warn('ALLOWED_CHAT_ID not set (bot accepts any chat)')

  if (env['GROQ_API_KEY']) ok('Voice STT: Groq configured')
  else warn('Voice STT: not configured (GROQ_API_KEY missing)')

  const dbPath = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db')
  if (fs.existsSync(dbPath)) {
    const stat = fs.statSync(dbPath)
    ok(`SQLite: ${dbPath} (${(stat.size / 1024).toFixed(1)} KB)`)
    try {
      const Database: any = (await import('better-sqlite3')).default
      const db = new Database(dbPath, { readonly: true })
      const memoryCount = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
      const taskCount = (db.prepare('SELECT COUNT(*) AS c FROM scheduled_tasks').get() as { c: number }).c
      ok(`Memories: ${memoryCount}`)
      ok(`Scheduled tasks: ${taskCount}`)
      db.close()
    } catch (err) {
      warn(`DB read failed: ${(err as Error).message}`)
    }
  } else {
    warn(`SQLite not initialised yet (${dbPath})`)
  }

  if (process.platform === 'darwin') {
    const res = spawnSync('launchctl', ['list', 'com.claudeclaw.app'], { stdio: ['ignore', 'pipe', 'ignore'] })
    if (res.status === 0) ok('launchd service: loaded')
    else warn('launchd service: not loaded')
  } else if (process.platform === 'linux') {
    const res = spawnSync('systemctl', ['--user', 'is-active', 'claudeclaw.service'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const state = (res.stdout?.toString() ?? '').trim()
    if (state === 'active') ok('systemd service: active')
    else warn(`systemd service: ${state || 'not installed'}`)
  }

  const pidFile = path.join(PROJECT_ROOT, 'store', 'claudeclaw.pid')
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    try {
      process.kill(pid, 0)
      ok(`Process: running (pid ${pid})`)
    } catch {
      warn(`Stale PID file: ${pid} (process not alive)`)
    }
  } else {
    warn('No PID file — bot is not running locally')
  }
}

main().catch((err) => {
  bad(`status failed: ${(err as Error).message}`)
  process.exit(1)
})
