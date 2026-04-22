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

export function isAdmin(chatId: number | string): boolean {
  if (ADMIN_CHAT_IDS.length === 0) return false
  return ADMIN_CHAT_IDS.includes(String(chatId))
}

export const WHATSAPP_ENABLED = (env['WHATSAPP_ENABLED'] ?? '').trim() === '1'
export const WHATSAPP_PROVIDER = (env['WHATSAPP_PROVIDER'] ?? 'baileys').trim()

const rawWhatsapp = env['ALLOWED_WHATSAPP_NUMBERS'] ?? ''
export const ALLOWED_WHATSAPP_NUMBERS: readonly string[] = rawWhatsapp
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isWhatsAppAuthorised(number: string): boolean {
  if (ALLOWED_WHATSAPP_NUMBERS.length === 0) return true
  return ALLOWED_WHATSAPP_NUMBERS.includes(number)
}
