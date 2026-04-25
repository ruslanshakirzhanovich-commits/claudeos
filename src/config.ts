import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import * as users from './users.js'
import { discordChatId, whatsappChatId } from './channel.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const PROJECT_ROOT = path.resolve(__dirname, '..')
export const STORE_DIR = path.join(PROJECT_ROOT, 'store')
export const WORKSPACE_DIR = path.join(PROJECT_ROOT, 'workspace')
export const UPLOADS_DIR = path.join(WORKSPACE_DIR, 'uploads')
export const DB_PATH = path.join(STORE_DIR, 'claudeclaw.db')
export const PID_FILE = path.join(STORE_DIR, 'claudeclaw.pid')

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
export const TTS_MAX_CHARS = Math.max(50, Number(env['TTS_MAX_CHARS'] ?? '800') || 800)

const rawAllowed = env['ALLOWED_CHAT_IDS'] ?? env['ALLOWED_CHAT_ID'] ?? ''
export const ALLOWED_CHAT_IDS: readonly string[] = rawAllowed
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const rawAdmin = env['ADMIN_CHAT_IDS'] ?? ''
export const ADMIN_CHAT_IDS: readonly string[] = rawAdmin
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean).length
  ? rawAdmin
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ALLOWED_CHAT_IDS.slice(0, 1)

export function isAdmin(chatId: number | string): boolean {
  return users.isAdminChat(String(chatId))
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

// Retry budget for the Claude Agent SDK call. Retries only fire for transient
// errors (429, 5xx, 529, network resets) and only while the stream has not
// started yet — once the SDK has emitted any event, a tool call may already
// have run, so retrying would be non-idempotent.
export const AGENT_RETRY_ATTEMPTS = readPositiveInt('AGENT_RETRY_ATTEMPTS', 3)
export const AGENT_RETRY_BASE_MS = readPositiveInt('AGENT_RETRY_BASE_MS', 500)

// Hard guards on a single SDK query. maxTurns caps tool-use loops so a
// confused agent can't burn through tokens in bypassPermissions mode.
// STREAM_TIMEOUT_MS aborts a query that connected but never produces any
// event within the window — prevents the worker from hanging forever.
export const AGENT_MAX_TURNS = readPositiveInt('AGENT_MAX_TURNS', 25)
export const AGENT_STREAM_TIMEOUT_MS = readPositiveInt('AGENT_STREAM_TIMEOUT_MS', 120_000)

// Per-chat rate limit (token bucket). Defaults: 10-message burst, then
// one message every 6 seconds sustained (10/min). Set capacity=0 to
// disable entirely.
export const RATE_LIMIT_CAPACITY = Math.max(0, Number(env['RATE_LIMIT_CAPACITY'] ?? '10') || 10)
export const RATE_LIMIT_REFILL_PER_MIN = readPositiveInt('RATE_LIMIT_REFILL_PER_MIN', 10)
// Hard ceiling on how many chat_id buckets we track in memory. Protects
// long-running processes from unbounded Map growth when the chat-id space
// is high-cardinality (public bots, scrapers). LRU evicts the oldest.
export const RATE_LIMIT_MAX_TRACKED = readPositiveInt('RATE_LIMIT_MAX_TRACKED', 10_000)

// Hard cap on how many episodic memories we keep per chat. Prevents the
// DB from growing linearly for the lifetime of the agent. Semantic
// memories are never capped here — they're load-bearing for user
// profile. Set to 0 to disable the cap.
export const MEMORY_EPISODIC_CAP_PER_CHAT = Math.max(
  0,
  Number(env['MEMORY_EPISODIC_CAP_PER_CHAT'] ?? '1000') || 1000,
)

// Guard rails for the episodic cap. Rows at or above this salience are
// never evicted (identity facts the user touches a lot). Rows younger
// than this many hours are also spared — a long-idle chat that suddenly
// receives a new message should not immediately lose the new fact just
// because the older rows happen to have a newer accessed_at.
export const MEMORY_PROTECT_MIN_SALIENCE =
  Number(env['MEMORY_PROTECT_MIN_SALIENCE'] ?? '2.0') || 2.0
export const MEMORY_PROTECT_MIN_AGE_HOURS = readPositiveInt('MEMORY_PROTECT_MIN_AGE_HOURS', 168)
// How many rows to delete per pass in the daily episodic cap sweep. The
// sweep awaits setImmediate between passes so incoming messages aren't
// starved on a multi-thousand-row delete.
export const MEMORY_CAP_BATCH_SIZE = readPositiveInt('MEMORY_CAP_BATCH_SIZE', 500)

// Localhost-only health probe. Use for systemd Watchdog, uptime-kuma, or
// any external liveness monitor. HEALTH_HOST defaults to 127.0.0.1; binding
// to 0.0.0.0 is an explicit opt-in.
export const HEALTH_ENABLED = (env['HEALTH_ENABLED'] ?? '1').trim() !== '0'
export const HEALTH_HOST = (env['HEALTH_HOST'] ?? '127.0.0.1').trim()
export const HEALTH_PORT = Number(env['HEALTH_PORT'] ?? '9090') || 9090

// Episodic-to-semantic consolidation. Off by default: it costs tokens on
// every tick. When on, once per interval we collect a chat's oldest
// episodic rows, fold them into a single semantic summary via the agent
// SDK, and delete the originals in one transaction. MIN_BATCH guards
// against consolidating three trivia lines into a bland summary.
export const MEMORY_SUMMARIZE_ENABLED = (env['MEMORY_SUMMARIZE_ENABLED'] ?? '').trim() === '1'
export const MEMORY_SUMMARIZE_INTERVAL_HOURS = readPositiveInt(
  'MEMORY_SUMMARIZE_INTERVAL_HOURS',
  168,
)
export const MEMORY_SUMMARIZE_MIN_AGE_DAYS = readPositiveInt('MEMORY_SUMMARIZE_MIN_AGE_DAYS', 7)
export const MEMORY_SUMMARIZE_BATCH = readPositiveInt('MEMORY_SUMMARIZE_BATCH', 50)
export const MEMORY_SUMMARIZE_MIN_BATCH = readPositiveInt('MEMORY_SUMMARIZE_MIN_BATCH', 10)

// Hard ceiling on how long one summarizeViaAgentSdk call may run. If the
// stream never produces a result event within this window, we abort —
// protects the 24-hour consolidation sweep from stalling on a single hung
// chat. Mirrors AGENT_STREAM_TIMEOUT_MS for the main agent path.
export const SUMMARIZE_TIMEOUT_MS = readPositiveInt('SUMMARIZE_TIMEOUT_MS', 120_000)

export const BACKUP_SCHEDULE_ENABLED = (env['BACKUP_SCHEDULE_ENABLED'] ?? '1').trim() !== '0'
export const BACKUP_INTERVAL_HOURS = Math.max(1, Number(env['BACKUP_INTERVAL_HOURS'] ?? '24') || 24)
export const BACKUP_KEEP = Math.max(1, Number(env['BACKUP_KEEP'] ?? '7') || 7)

export const PREVIEW_ENABLED = (env['PREVIEW_ENABLED'] ?? '').trim() === '1'
export const PREVIEW_PORT = Number(env['PREVIEW_PORT'] ?? '8080') || 8080
export const PREVIEW_HOST = (env['PREVIEW_HOST'] ?? '').trim()
export const PREVIEW_USER = (env['PREVIEW_USER'] ?? '').trim()
export const PREVIEW_PASSWORD = (env['PREVIEW_PASSWORD'] ?? '').trim()

const LOCALHOST_BINDS = new Set(['127.0.0.1', '::1', 'localhost'])

export function resolvePreviewBind(host: string, password: string): { host: string } {
  const requested = host.trim()
  const effective = requested || '127.0.0.1'
  if (!password && !LOCALHOST_BINDS.has(effective)) {
    throw new Error(
      `PREVIEW_HOST="${effective}" exposes the preview server beyond localhost without PREVIEW_PASSWORD. ` +
        `Set PREVIEW_PASSWORD to enable public binding, or leave PREVIEW_HOST empty for 127.0.0.1.`,
    )
  }
  return { host: effective }
}

export const WHATSAPP_ENABLED = (env['WHATSAPP_ENABLED'] ?? '').trim() === '1'
export const WHATSAPP_PROVIDER = (env['WHATSAPP_PROVIDER'] ?? 'baileys').trim()

export const DISCORD_ENABLED = (env['DISCORD_ENABLED'] ?? '').trim() === '1'
export const DISCORD_BOT_TOKEN = (env['DISCORD_BOT_TOKEN'] ?? '').trim()

const rawDiscord = env['ALLOWED_DISCORD_USERS'] ?? ''
export const ALLOWED_DISCORD_USERS: readonly string[] = rawDiscord
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isDiscordUserAuthorised(userId: string): boolean {
  return users.isAuthorisedChat(discordChatId(userId))
}

// First-boot seed only. Migration v8 reads this once to populate
// users + user_chats. After v8, the database is the source of truth —
// this env var has no effect on runtime auth.
const rawAdminDiscord = env['ADMIN_DISCORD_USERS'] ?? ''
export const ADMIN_DISCORD_USERS: readonly string[] = rawAdminDiscord
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isDiscordUserAdmin(userId: string): boolean {
  return users.isAdminChat(discordChatId(userId))
}

export const WHATSAPP_META_ACCESS_TOKEN = env['WHATSAPP_META_ACCESS_TOKEN'] ?? ''
export const WHATSAPP_META_PHONE_NUMBER_ID = env['WHATSAPP_META_PHONE_NUMBER_ID'] ?? ''
export const WHATSAPP_META_VERIFY_TOKEN = env['WHATSAPP_META_VERIFY_TOKEN'] ?? ''
export const WHATSAPP_META_APP_SECRET = env['WHATSAPP_META_APP_SECRET'] ?? ''
export const WHATSAPP_META_WEBHOOK_PORT =
  Number(env['WHATSAPP_META_WEBHOOK_PORT'] ?? '3001') || 3001
export const WHATSAPP_META_WEBHOOK_PATH = (
  env['WHATSAPP_META_WEBHOOK_PATH'] ?? '/whatsapp/webhook'
).trim()
export const WHATSAPP_META_GRAPH_VERSION = (env['WHATSAPP_META_GRAPH_VERSION'] ?? 'v20.0').trim()

// AES-256-GCM key for Baileys auth-file encryption at rest. Required when
// WHATSAPP_ENABLED=1 and WHATSAPP_PROVIDER=baileys. Must decode (base64) to
// exactly 32 bytes. Generate with:
//   openssl rand -base64 32
// Losing or rotating this key invalidates all saved Signal/Noise state —
// the bot will fail to decrypt on boot, and recovery is to delete
// store/whatsapp-auth/ and re-scan the pairing QR.
export const WHATSAPP_AUTH_ENCRYPTION_KEY = (env['WHATSAPP_AUTH_ENCRYPTION_KEY'] ?? '').trim()

const rawWhatsapp = env['ALLOWED_WHATSAPP_NUMBERS'] ?? ''
export const ALLOWED_WHATSAPP_NUMBERS: readonly string[] = rawWhatsapp
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isWhatsAppAuthorised(number: string): boolean {
  return users.isAuthorisedChat(whatsappChatId(number))
}

// WhatsApp admin list. Same shape as the Discord one — no fallback to
// the allowlist, empty means nobody is an admin.
const rawAdminWhatsApp = env['ADMIN_WHATSAPP_NUMBERS'] ?? ''
export const ADMIN_WHATSAPP_NUMBERS: readonly string[] = rawAdminWhatsApp
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isWhatsAppNumberAdmin(number: string): boolean {
  return users.isAdminChat(whatsappChatId(number))
}
