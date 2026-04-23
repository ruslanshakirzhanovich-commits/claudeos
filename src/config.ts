import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const PROJECT_ROOT = path.resolve(__dirname, '..')
export const STORE_DIR = path.join(PROJECT_ROOT, 'store')
export const WORKSPACE_DIR = path.join(PROJECT_ROOT, 'workspace')
export const UPLOADS_DIR = path.join(WORKSPACE_DIR, 'uploads')
export const DB_PATH = path.join(STORE_DIR, 'claudeclaw.db')
export const PID_FILE = path.join(STORE_DIR, 'claudeclaw.pid')
export const CLAUDE_MD_PATH = path.join(PROJECT_ROOT, 'CLAUDE.md')

export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
export const SCHEDULER_POLL_MS = 60_000
export const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000

const env = readEnvFile()

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''

export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? ''
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? ''
export const ELEVENLABS_MODEL_ID = env['ELEVENLABS_MODEL_ID'] ?? 'eleven_multilingual_v2'
export const TTS_MAX_CHARS = Math.max(
  50,
  Number(env['TTS_MAX_CHARS'] ?? '800') || 800,
)

const rawAllowed = env['ALLOWED_CHAT_IDS'] ?? env['ALLOWED_CHAT_ID'] ?? ''
export const ALLOWED_CHAT_IDS: readonly string[] = rawAllowed
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const rawAdmin = env['ADMIN_CHAT_IDS'] ?? ''
export const ADMIN_CHAT_IDS: readonly string[] = (rawAdmin
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean).length
  ? rawAdmin.split(',').map((s) => s.trim()).filter(Boolean)
  : ALLOWED_CHAT_IDS.slice(0, 1))

export function isAdminOf(admins: readonly string[], chatId: number | string): boolean {
  if (admins.length === 0) return false
  return admins.includes(String(chatId))
}

export function isAdmin(chatId: number | string): boolean {
  return isAdminOf(ADMIN_CHAT_IDS, chatId)
}

export const CLAUDE_MODEL = (env['CLAUDE_MODEL'] ?? '').trim()
export const CLAUDE_DEFAULT_EFFORT = (env['CLAUDE_DEFAULT_EFFORT'] ?? '').trim().toLowerCase()

// Override the default thinking-token budgets for low/medium/high/xhigh.
// Anthropic does not publish canonical numbers for an "effort" tier system —
// these defaults are heuristic and chosen to span 4× steps from a quick reply
// up to a deep reasoning pass. Power users can tune them without rebuilding.
function readPositiveInt(name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
export const EFFORT_TOKENS_LOW = readPositiveInt('EFFORT_TOKENS_LOW', 2_048)
export const EFFORT_TOKENS_MEDIUM = readPositiveInt('EFFORT_TOKENS_MEDIUM', 8_192)
export const EFFORT_TOKENS_HIGH = readPositiveInt('EFFORT_TOKENS_HIGH', 24_576)
export const EFFORT_TOKENS_XHIGH = readPositiveInt('EFFORT_TOKENS_XHIGH', 65_536)

export const BACKUP_SCHEDULE_ENABLED = (env['BACKUP_SCHEDULE_ENABLED'] ?? '1').trim() !== '0'
export const BACKUP_INTERVAL_HOURS = Math.max(1, Number(env['BACKUP_INTERVAL_HOURS'] ?? '24') || 24)
export const BACKUP_KEEP = Math.max(1, Number(env['BACKUP_KEEP'] ?? '7') || 7)

export const PREVIEW_ENABLED = (env['PREVIEW_ENABLED'] ?? '').trim() === '1'
export const PREVIEW_PORT = Number(env['PREVIEW_PORT'] ?? '8080') || 8080
export const PREVIEW_HOST = (env['PREVIEW_HOST'] ?? '').trim()
export const PREVIEW_USER = (env['PREVIEW_USER'] ?? '').trim()
export const PREVIEW_PASSWORD = (env['PREVIEW_PASSWORD'] ?? '').trim()

export const WHATSAPP_ENABLED = (env['WHATSAPP_ENABLED'] ?? '').trim() === '1'
export const WHATSAPP_PROVIDER = (env['WHATSAPP_PROVIDER'] ?? 'baileys').trim()

export const DISCORD_ENABLED = (env['DISCORD_ENABLED'] ?? '').trim() === '1'
export const DISCORD_BOT_TOKEN = (env['DISCORD_BOT_TOKEN'] ?? '').trim()

const rawDiscord = env['ALLOWED_DISCORD_USERS'] ?? ''
export const ALLOWED_DISCORD_USERS: readonly string[] = rawDiscord
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isDiscordUserAuthorisedOf(allowed: readonly string[], userId: string): boolean {
  if (allowed.length === 0) return true
  return allowed.includes(userId)
}

export function isDiscordUserAuthorised(userId: string): boolean {
  return isDiscordUserAuthorisedOf(ALLOWED_DISCORD_USERS, userId)
}

export const WHATSAPP_META_ACCESS_TOKEN = env['WHATSAPP_META_ACCESS_TOKEN'] ?? ''
export const WHATSAPP_META_PHONE_NUMBER_ID = env['WHATSAPP_META_PHONE_NUMBER_ID'] ?? ''
export const WHATSAPP_META_VERIFY_TOKEN = env['WHATSAPP_META_VERIFY_TOKEN'] ?? ''
export const WHATSAPP_META_APP_SECRET = env['WHATSAPP_META_APP_SECRET'] ?? ''
export const WHATSAPP_META_WEBHOOK_PORT = Number(env['WHATSAPP_META_WEBHOOK_PORT'] ?? '3001') || 3001
export const WHATSAPP_META_WEBHOOK_PATH = (env['WHATSAPP_META_WEBHOOK_PATH'] ?? '/whatsapp/webhook').trim()
export const WHATSAPP_META_GRAPH_VERSION = (env['WHATSAPP_META_GRAPH_VERSION'] ?? 'v20.0').trim()

const rawWhatsapp = env['ALLOWED_WHATSAPP_NUMBERS'] ?? ''
export const ALLOWED_WHATSAPP_NUMBERS: readonly string[] = rawWhatsapp
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isWhatsAppAuthorisedOf(allowed: readonly string[], number: string): boolean {
  if (allowed.length === 0) return true
  return allowed.includes(number)
}

export function isWhatsAppAuthorised(number: string): boolean {
  return isWhatsAppAuthorisedOf(ALLOWED_WHATSAPP_NUMBERS, number)
}
