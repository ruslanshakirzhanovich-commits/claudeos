import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { execSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

const ok = (msg: string) => process.stdout.write(`${C.green}✓${C.reset} ${msg}\n`)
const warn = (msg: string) => process.stdout.write(`${C.yellow}⚠${C.reset} ${msg}\n`)
const fail = (msg: string) => process.stdout.write(`${C.red}✗${C.reset} ${msg}\n`)
const info = (msg: string) => process.stdout.write(`${C.cyan}→${C.reset} ${msg}\n`)
const header = (msg: string) =>
  process.stdout.write(`\n${C.bold}${C.magenta}── ${msg} ──${C.reset}\n\n`)

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
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
`

function writeEnv(values: Record<string, string>): void {
  const envPath = path.join(PROJECT_ROOT, '.env')
  let existing: Record<string, string> = {}
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const k = trimmed.slice(0, eq).trim()
      let v = trimmed.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      existing[k] = v
    }
  }
  const merged = { ...existing, ...values }
  const lines = Object.entries(merged).map(([k, v]) => {
    const needsQuote = /\s|["'#]/.test(v)
    return needsQuote ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`
  })
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8')
}

async function checkRequirements(): Promise<void> {
  header('Checking requirements')

  const nodeVersion = process.versions.node
  const major = Number(nodeVersion.split('.')[0])
  if (major < 20) {
    fail(`Node.js >= 20 required. You have ${nodeVersion}.`)
    process.exit(1)
  }
  ok(`Node.js ${nodeVersion}`)

  try {
    const out = execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    ok(`Claude CLI: ${out || 'present'}`)
  } catch {
    warn('`claude` CLI not found on PATH. Install it from https://claude.com/code and run `claude login` before continuing.')
  }

  const nodeModules = path.join(PROJECT_ROOT, 'node_modules')
  if (!fs.existsSync(nodeModules)) {
    info('Running `npm install` (first-time setup)…')
    const res = spawnSync('npm', ['install'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
    if (res.status !== 0) {
      fail('npm install failed.')
      process.exit(1)
    }
  } else {
    ok('node_modules present')
  }

  info('Building TypeScript (`npm run build`)…')
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
  if (build.status !== 0) {
    fail('Build failed. Fix errors above and re-run `npm run setup`.')
    process.exit(1)
  }
  ok('Build complete')
}

async function collectConfig(rl: readline.Interface): Promise<Record<string, string>> {
  header('Configuration')

  info('Get a Telegram bot token from @BotFather: https://t.me/BotFather → /newbot')
  const telegramToken = (await rl.question('TELEGRAM_BOT_TOKEN: ')).trim()
  if (!telegramToken) {
    fail('TELEGRAM_BOT_TOKEN is required.')
    process.exit(1)
  }

  process.stdout.write('\n')
  info('Voice transcription uses Groq Whisper. Key is free at https://console.groq.com')
  info('Leave blank to disable voice transcription.')
  const groqKey = (await rl.question('GROQ_API_KEY (optional): ')).trim()

  const values: Record<string, string> = { TELEGRAM_BOT_TOKEN: telegramToken }
  if (groqKey) values['GROQ_API_KEY'] = groqKey
  writeEnv(values)
  ok('.env written')
  return values
}

async function personaliseClaudeMd(rl: readline.Interface): Promise<void> {
  header('Personalise CLAUDE.md')
  info('CLAUDE.md is your assistant\'s system prompt. I\'ll open it in your editor.')
  const answer = (await rl.question('Open CLAUDE.md now? [Y/n]: ')).trim().toLowerCase()
  if (answer && answer !== 'y' && answer !== 'yes') {
    warn('Skipped. You can edit CLAUDE.md manually any time.')
    return
  }
  const editor = process.env['EDITOR'] || process.env['VISUAL'] || (process.platform === 'win32' ? 'notepad' : 'vi')
  const res = spawnSync(editor, [path.join(PROJECT_ROOT, 'CLAUDE.md')], { stdio: 'inherit' })
  if (res.status === 0) ok('CLAUDE.md saved')
  else warn('Editor exited with a non-zero status.')
}

function installService(): void {
  header('Install as background service')
  const platform = process.platform
  if (platform === 'darwin') {
    installLaunchd()
  } else if (platform === 'linux') {
    installSystemd()
  } else if (platform === 'win32') {
    info('On Windows, install PM2 globally:')
    info('  npm install -g pm2')
    info('Then start ClaudeClaw:')
    info(`  pm2 start "node ${path.join(PROJECT_ROOT, 'dist', 'index.js')}" --name claudeclaw`)
    info('  pm2 save && pm2 startup')
  } else {
    warn(`Unknown platform: ${platform}. Start manually with: npm run start`)
  }
}

function installLaunchd(): void {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claudeclaw.app.plist')
  const nodePath = execSync('which node').toString().trim() || '/usr/local/bin/node'
  const scriptPath = path.join(PROJECT_ROOT, 'dist', 'index.js')

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claudeclaw.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/claudeclaw.log</string>
  <key>StandardErrorPath</key><string>/tmp/claudeclaw.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
`
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.writeFileSync(plistPath, plist)
  ok(`Wrote ${plistPath}`)

  try {
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' })
    const res = spawnSync('launchctl', ['load', plistPath], { stdio: 'inherit' })
    if (res.status === 0) {
      ok('Service loaded and running. Logs: /tmp/claudeclaw.log')
    } else {
      warn('launchctl load failed. Load manually:')
      warn(`  launchctl load ${plistPath}`)
    }
  } catch (err) {
    warn(`launchctl error: ${(err as Error).message}`)
  }
}

function installSystemd(): void {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, 'claudeclaw.service')
  const nodePath = execSync('which node').toString().trim() || '/usr/bin/node'
  const scriptPath = path.join(PROJECT_ROOT, 'dist', 'index.js')

  const unit = `[Unit]
Description=ClaudeClaw — Telegram ↔ Claude Code bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${nodePath} ${scriptPath}
Restart=always
RestartSec=10
StandardOutput=append:/tmp/claudeclaw.log
StandardError=append:/tmp/claudeclaw.log

[Install]
WantedBy=default.target
`
  fs.mkdirSync(unitDir, { recursive: true })
  fs.writeFileSync(unitPath, unit)
  ok(`Wrote ${unitPath}`)

  try {
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    spawnSync('systemctl', ['--user', 'enable', 'claudeclaw.service'], { stdio: 'inherit' })
    const res = spawnSync('systemctl', ['--user', 'start', 'claudeclaw.service'], {
      stdio: 'inherit',
    })
    if (res.status === 0) {
      ok('Service enabled and started. Logs: /tmp/claudeclaw.log')
      info('Tip: `loginctl enable-linger $USER` lets the service keep running when logged out.')
    } else {
      warn('systemctl start failed — check `systemctl --user status claudeclaw.service`.')
    }
  } catch (err) {
    warn(`systemctl error: ${(err as Error).message}`)
  }
}

async function captureChatId(rl: readline.Interface): Promise<void> {
  header('Get your Chat ID')
  info('Open Telegram and send /chatid to your bot. The bot will echo your chat ID back.')
  info('Paste it here and I\'ll save it to .env as ALLOWED_CHAT_ID so only you can use the bot.')
  const chatId = (await rl.question('ALLOWED_CHAT_ID (or leave blank to skip): ')).trim()
  if (!chatId) {
    warn('Skipped. The bot will accept ANY chat until ALLOWED_CHAT_ID is set in .env.')
    return
  }
  if (!/^-?\d+$/.test(chatId)) {
    warn(`That does not look like a Telegram chat ID (expected digits, maybe negative). Saved anyway.`)
  }
  writeEnv({ ALLOWED_CHAT_ID: chatId })
  ok(`ALLOWED_CHAT_ID saved to .env`)

  const platform = process.platform
  if (platform === 'darwin') {
    spawnSync('launchctl', ['unload', path.join(os.homedir(), 'Library/LaunchAgents/com.claudeclaw.app.plist')], { stdio: 'ignore' })
    spawnSync('launchctl', ['load', path.join(os.homedir(), 'Library/LaunchAgents/com.claudeclaw.app.plist')], { stdio: 'inherit' })
    ok('Service reloaded with new chat ID.')
  } else if (platform === 'linux') {
    spawnSync('systemctl', ['--user', 'restart', 'claudeclaw.service'], { stdio: 'inherit' })
    ok('Service restarted with new chat ID.')
  }
}

async function main(): Promise<void> {
  process.stdout.write(BANNER + '\n')
  process.stdout.write(`${C.dim}Setup wizard — about 5 minutes.${C.reset}\n`)

  await checkRequirements()

  const rl = readline.createInterface({ input, output })
  try {
    await collectConfig(rl)
    await personaliseClaudeMd(rl)
    installService()
    await captureChatId(rl)

    header('Done')
    ok(`ClaudeClaw is installed at ${PROJECT_ROOT}`)
    info('Quick reference:')
    info('  npm run start          — run in foreground (dev)')
    info('  npm run status         — check health')
    info('  npm run schedule list  — manage scheduled tasks')
    info(`  Logs                   — /tmp/claudeclaw.log`)
    info('  Message your bot on Telegram and say hi.')
  } finally {
    rl.close()
  }
}

void spawn // keep import for future hot-start hooks
main().catch((err) => {
  fail(`Setup failed: ${(err as Error).message}`)
  process.exit(1)
})
