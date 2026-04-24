import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  intro,
  outro,
  note,
  text,
  password,
  confirm,
  select,
  spinner,
  isCancel,
  cancel,
  log,
} from '@clack/prompts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
const ENV_PATH = path.join(PROJECT_ROOT, '.env')

const TELEGRAM_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/
const CHAT_ID_RE = /^-?\d+$/

type EnvMap = Record<string, string>

function readEnv(): EnvMap {
  if (!fs.existsSync(ENV_PATH)) return {}
  const out: EnvMap = {}
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function writeEnv(values: EnvMap): void {
  const merged = { ...readEnv(), ...values }
  const lines = Object.entries(merged).map(([k, v]) => {
    const needsQuote = /\s|["'#]/.test(v)
    return needsQuote ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`
  })
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8')
  try {
    fs.chmodSync(ENV_PATH, 0o600)
  } catch {
    /* ignore on filesystems that don't support chmod */
  }
}

function bail(): never {
  cancel('Setup cancelled.')
  process.exit(1)
}

function v<T>(value: T | symbol): T {
  if (isCancel(value)) bail()
  return value as T
}

function notEmpty(label: string) {
  return (s: string) => {
    const t = s.trim()
    if (!t) return `${label} can't be empty.`
    if (t === 'undefined' || t === 'null')
      return `${label} looks like a literal "${t}" — paste the real value.`
    return undefined
  }
}

async function httpGet(
  hostname: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get({ hostname, path: pathname, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      })
      .on('error', reject)
  })
}

async function verifyTelegramToken(token: string): Promise<string> {
  const { status, body } = await httpGet('api.telegram.org', `/bot${token}/getMe`)
  if (status !== 200) throw new Error(`Telegram API ${status}: ${body.slice(0, 200)}`)
  const parsed = JSON.parse(body) as {
    ok: boolean
    result?: { username?: string }
    description?: string
  }
  if (!parsed.ok) throw new Error(parsed.description ?? 'Telegram rejected the token')
  return parsed.result?.username ?? 'unknown'
}

async function verifyElevenLabsKey(key: string): Promise<string> {
  const { status, body } = await httpGet('api.elevenlabs.io', '/v1/user', { 'xi-api-key': key })
  if (status !== 200) throw new Error(`ElevenLabs ${status}: ${body.slice(0, 200)}`)
  const parsed = JSON.parse(body) as { subscription?: { tier?: string }; xi_api_key?: string }
  return parsed.subscription?.tier ?? 'free'
}

async function checkRequirements(): Promise<void> {
  const s = spinner()
  s.start('Checking requirements')

  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    s.stop(`Node.js >= 20 required (found ${process.versions.node})`, 1)
    process.exit(1)
  }

  let claudeLine = 'not found'
  try {
    claudeLine =
      execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || 'present'
  } catch {
    /* optional */
  }

  s.stop(`Node ${process.versions.node} · Claude CLI: ${claudeLine}`)
  if (claudeLine === 'not found') {
    log.warn(
      '`claude` not on PATH. Install from https://claude.com/code and run `claude login` before starting the bot.',
    )
  }
}

async function sectionTelegram(existing: EnvMap): Promise<string> {
  note(
    'Get a token from @BotFather: https://t.me/BotFather → /newbot\nPaste the token below. Format: 123456789:ABC…',
    'Telegram bot',
  )

  if (existing['TELEGRAM_BOT_TOKEN']) {
    const s = spinner()
    s.start('Validating existing TELEGRAM_BOT_TOKEN')
    try {
      const username = await verifyTelegramToken(existing['TELEGRAM_BOT_TOKEN'])
      s.stop(`Existing token still works (bot @${username}) — skipping Telegram section`)
      return existing['TELEGRAM_BOT_TOKEN']
    } catch (err) {
      s.stop(`Existing token no longer valid: ${(err as Error).message}`, 1)
      log.warn('The token in .env was revoked or is invalid. Enter a new one from @BotFather.')
    }
  }

  while (true) {
    const token = v(
      await password({
        message: 'TELEGRAM_BOT_TOKEN',
        mask: '•',
        validate: (s) => {
          if (!s.trim()) return 'Required.'
          if (!TELEGRAM_TOKEN_RE.test(s.trim()))
            return 'Does not look like a bot token (expected `<digits>:<chars>`).'
          return undefined
        },
      }),
    )

    const s = spinner()
    s.start('Verifying token with Telegram')
    try {
      const username = await verifyTelegramToken(token.trim())
      s.stop(`Token valid — bot is @${username}`)
      return token.trim()
    } catch (err) {
      s.stop(`Invalid token: ${(err as Error).message}`, 1)
      const retry = v(await confirm({ message: 'Try another token?', initialValue: true }))
      if (!retry) {
        if (existing['TELEGRAM_BOT_TOKEN']) {
          log.info('Keeping existing TELEGRAM_BOT_TOKEN in .env.')
          return existing['TELEGRAM_BOT_TOKEN']
        }
        bail()
      }
    }
  }
}

async function sectionAuthorization(existing: EnvMap): Promise<string> {
  note(
    'Comma-separated chat IDs that can talk to the bot.\nLeave blank and the bot will let any chat through temporarily — use /chatid to get yours, then re-run this wizard.',
    'Authorization',
  )

  const fallback = existing['ALLOWED_CHAT_IDS'] ?? existing['ALLOWED_CHAT_ID'] ?? ''
  const raw = v(
    await text({
      message: 'ALLOWED_CHAT_IDS',
      placeholder: '110440505,200300400',
      initialValue: fallback,
      validate: (s) => {
        const trimmed = s.trim()
        if (!trimmed) return undefined
        const ids = trimmed
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        for (const id of ids) {
          if (!CHAT_ID_RE.test(id)) return `"${id}" is not a numeric chat ID.`
        }
        return undefined
      },
    }),
  )
  return raw.trim()
}

async function sectionSTT(existing: EnvMap): Promise<string> {
  note(
    'Groq Whisper transcribes voice messages. Free tier is generous.\nGet a key: https://console.groq.com',
    'Voice (STT)',
  )

  const want = v(
    await confirm({
      message: 'Configure Groq now?',
      initialValue: Boolean(existing['GROQ_API_KEY']),
    }),
  )
  if (!want) return existing['GROQ_API_KEY'] ?? ''

  const key = v(
    await password({
      message: 'GROQ_API_KEY' + (existing['GROQ_API_KEY'] ? ' (leave blank to keep existing)' : ''),
      mask: '•',
      validate: (s) => {
        const t = s.trim()
        if (!t && existing['GROQ_API_KEY']) return undefined
        if (!t) return 'Required.'
        if (t === 'undefined' || t === 'null') return `Looks like literal "${t}".`
        return undefined
      },
    }),
  )
  return key.trim() || existing['GROQ_API_KEY'] || ''
}

interface TtsConfig {
  apiKey: string
  voiceId: string
  modelId: string
  maxChars: string
}

async function sectionTTS(existing: EnvMap): Promise<TtsConfig | null> {
  note(
    'ElevenLabs TTS lets the bot reply with voice messages.\nGet a key + pick a voice: https://elevenlabs.io/app/voice-library',
    'Voice replies (TTS)',
  )

  const want = v(
    await confirm({
      message: 'Configure ElevenLabs now?',
      initialValue: Boolean(existing['ELEVENLABS_API_KEY']),
    }),
  )
  if (!want) {
    return existing['ELEVENLABS_API_KEY'] && existing['ELEVENLABS_VOICE_ID']
      ? {
          apiKey: existing['ELEVENLABS_API_KEY'],
          voiceId: existing['ELEVENLABS_VOICE_ID'],
          modelId: existing['ELEVENLABS_MODEL_ID'] ?? 'eleven_multilingual_v2',
          maxChars: existing['TTS_MAX_CHARS'] ?? '800',
        }
      : null
  }

  let apiKey = ''
  while (true) {
    const input = v(
      await password({
        message: 'ELEVENLABS_API_KEY' + (existing['ELEVENLABS_API_KEY'] ? ' (blank to keep)' : ''),
        mask: '•',
        validate: notEmpty('Key'),
      }),
    )
    const candidate = input.trim() || existing['ELEVENLABS_API_KEY'] || ''
    if (!candidate) continue

    const s = spinner()
    s.start('Verifying key with ElevenLabs')
    try {
      const tier = await verifyElevenLabsKey(candidate)
      s.stop(`Key valid — plan: ${tier}`)
      apiKey = candidate
      break
    } catch (err) {
      s.stop(`Invalid key: ${(err as Error).message}`, 1)
      const retry = v(await confirm({ message: 'Try another key?', initialValue: true }))
      if (!retry) return null
    }
  }

  const voiceId = v(
    await text({
      message: 'ELEVENLABS_VOICE_ID',
      placeholder: '21m00Tcm4TlvDq8ikWAM',
      initialValue: existing['ELEVENLABS_VOICE_ID'] ?? '',
      validate: notEmpty('Voice ID'),
    }),
  )

  const modelId = v(
    await select({
      message: 'Model',
      initialValue: existing['ELEVENLABS_MODEL_ID'] ?? 'eleven_multilingual_v2',
      options: [
        { value: 'eleven_multilingual_v2', label: 'eleven_multilingual_v2 (default, balanced)' },
        { value: 'eleven_turbo_v2_5', label: 'eleven_turbo_v2_5 (faster, cheaper)' },
        { value: 'eleven_v3', label: 'eleven_v3 (higher quality)' },
      ],
    }),
  )

  const maxCharsRaw = v(
    await text({
      message: 'TTS_MAX_CHARS (cap per voice reply)',
      placeholder: '800',
      initialValue: existing['TTS_MAX_CHARS'] ?? '800',
      validate: (s) => {
        const n = Number(s.trim())
        if (!Number.isFinite(n) || n < 50) return 'Must be a number >= 50.'
        return undefined
      },
    }),
  )

  return {
    apiKey,
    voiceId: voiceId.trim(),
    modelId: modelId as string,
    maxChars: maxCharsRaw.trim(),
  }
}

interface WhatsAppConfig {
  enabled: boolean
  allowedNumbers: string
}

async function sectionWhatsApp(existing: EnvMap): Promise<WhatsAppConfig> {
  note(
    [
      'Experimental: bridge the bot into WhatsApp via @whiskeysockets/baileys.',
      '⚠  Reverse-engineered client — WhatsApp may ban the number. Use a SECONDARY phone.',
      'On first start you will see a QR in the bot logs — scan it from WhatsApp → Linked devices.',
    ].join('\n'),
    'WhatsApp bridge (optional)',
  )

  const enable = v(
    await confirm({
      message: 'Enable WhatsApp bridge?',
      initialValue: existing['WHATSAPP_ENABLED'] === '1',
    }),
  )
  if (!enable) return { enabled: false, allowedNumbers: existing['ALLOWED_WHATSAPP_NUMBERS'] ?? '' }

  const numbers = v(
    await text({
      message: 'ALLOWED_WHATSAPP_NUMBERS (digits only, comma-separated, blank = allow any)',
      placeholder: '491234567,15551234567',
      initialValue: existing['ALLOWED_WHATSAPP_NUMBERS'] ?? '',
      validate: (s) => {
        const t = s.trim()
        if (!t) return undefined
        for (const n of t
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)) {
          if (!/^\d+$/.test(n)) return `"${n}" is not digits-only.`
        }
        return undefined
      },
    }),
  )
  return { enabled: true, allowedNumbers: numbers.trim() }
}

async function sectionClaudeMd(): Promise<void> {
  const claudeMd = path.join(PROJECT_ROOT, 'CLAUDE.md')
  if (!fs.existsSync(claudeMd)) return

  const open = v(
    await confirm({
      message: 'Open CLAUDE.md (bot personality prompt) in $EDITOR?',
      initialValue: false,
    }),
  )
  if (!open) return

  const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi'
  const res = spawnSync(editor, [claudeMd], { stdio: 'inherit' })
  if (res.status !== 0) log.warn(`Editor exited with status ${res.status ?? '?'}.`)
}

async function sectionBuild(): Promise<void> {
  const nodeModules = path.join(PROJECT_ROOT, 'node_modules')
  if (!fs.existsSync(nodeModules)) {
    const s = spinner()
    s.start('Running npm install')
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: PROJECT_ROOT })
    if (res.status !== 0) {
      s.stop('npm install failed', 1)
      process.exit(1)
    }
    s.stop('Dependencies installed')
  }

  const s = spinner()
  s.start('Building TypeScript')
  const res = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT })
  if (res.status !== 0) {
    s.stop('Build failed — run `npm run build` manually to see errors', 1)
    process.exit(1)
  }
  s.stop('Build complete')
}

async function main(): Promise<void> {
  intro('ClaudeOS setup wizard')

  await checkRequirements()
  const existing = readEnv()
  if (Object.keys(existing).length) {
    log.info(
      `Found existing .env with ${Object.keys(existing).length} keys — values below are pre-filled.`,
    )
  }

  const token = await sectionTelegram(existing)
  const chatIds = await sectionAuthorization(existing)
  const groq = await sectionSTT(existing)
  const tts = await sectionTTS(existing)
  const whatsapp = await sectionWhatsApp(existing)

  const envOut: EnvMap = {
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_CHAT_IDS: chatIds,
    LOG_LEVEL: existing['LOG_LEVEL'] ?? 'info',
    NODE_ENV: existing['NODE_ENV'] ?? 'production',
  }
  if (groq) envOut['GROQ_API_KEY'] = groq
  if (tts) {
    envOut['ELEVENLABS_API_KEY'] = tts.apiKey
    envOut['ELEVENLABS_VOICE_ID'] = tts.voiceId
    envOut['ELEVENLABS_MODEL_ID'] = tts.modelId
    envOut['TTS_MAX_CHARS'] = tts.maxChars
  }
  envOut['WHATSAPP_ENABLED'] = whatsapp.enabled ? '1' : ''
  envOut['WHATSAPP_PROVIDER'] = existing['WHATSAPP_PROVIDER'] ?? 'baileys'
  envOut['ALLOWED_WHATSAPP_NUMBERS'] = whatsapp.allowedNumbers

  writeEnv(envOut)
  log.success('.env saved (chmod 600)')

  await sectionClaudeMd()
  await sectionBuild()

  outro(
    [
      'Done. Next steps:',
      '  • Start the bot in foreground: npm run start',
      '  • Or run as a systemd service: re-run install.sh to wire up claudeclaw.service',
      '  • Message your bot on Telegram and say hi.',
    ].join('\n'),
  )
}

main().catch((err) => {
  log.error(`Setup failed: ${(err as Error).message}`)
  process.exit(1)
})
