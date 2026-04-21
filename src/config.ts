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
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''

export function isAuthorised(chatId: number | string): boolean {
  if (!ALLOWED_CHAT_ID) return true
  return String(chatId) === ALLOWED_CHAT_ID
}
