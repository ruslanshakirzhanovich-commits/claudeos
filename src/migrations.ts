import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import { logger } from './logger.js'

export interface MigrationSeeds {
  // Telegram chat ids (numeric strings) — admin allowlist; allowed_chats is
  // read directly from the legacy table inside the migration.
  adminTelegram?: readonly string[]
  // Discord raw user ids (without 'discord:' prefix)
  allowedDiscord?: readonly string[]
  adminDiscord?: readonly string[]
  // WhatsApp bare numbers or full JIDs
  allowedWhatsapp?: readonly string[]
  adminWhatsapp?: readonly string[]
}

// Set just before runMigrations and read by v8.up(). Module-level so the
// existing Migration interface stays unchanged. runMigrations resets it.
let pendingSeeds: MigrationSeeds = {}

export interface Migration {
  version: number
  name: string
  up: (db: InstanceType<typeof Database>) => void
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          chat_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          topic_key TEXT,
          content TEXT NOT NULL,
          sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
          salience REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memories_chat_accessed
          ON memories(chat_id, accessed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_salience
          ON memories(salience);

        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule TEXT NOT NULL,
          next_run INTEGER NOT NULL,
          last_run INTEGER,
          last_result TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_due
          ON scheduled_tasks(status, next_run);

        CREATE TABLE IF NOT EXISTS chat_preferences (
          chat_id TEXT PRIMARY KEY,
          tts_enabled INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS allowed_chats (
          chat_id TEXT PRIMARY KEY,
          added_at INTEGER NOT NULL,
          added_by TEXT,
          note TEXT
        );
      `)
    },
  },
  {
    version: 2,
    name: 'allowed_chats.last_seen_at',
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(allowed_chats)`).all() as { name: string }[]
      if (!cols.some((c) => c.name === 'last_seen_at')) {
        db.exec(`ALTER TABLE allowed_chats ADD COLUMN last_seen_at INTEGER`)
      }
    },
  },
  {
    version: 3,
    name: 'chat_preferences.preferred_model',
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(chat_preferences)`).all() as { name: string }[]
      if (!cols.some((c) => c.name === 'preferred_model')) {
        db.exec(`ALTER TABLE chat_preferences ADD COLUMN preferred_model TEXT`)
      }
    },
  },
  {
    version: 4,
    name: 'chat_preferences.effort_level',
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(chat_preferences)`).all() as { name: string }[]
      if (!cols.some((c) => c.name === 'effort_level')) {
        db.exec(`ALTER TABLE chat_preferences ADD COLUMN effort_level TEXT`)
      }
    },
  },
  {
    version: 5,
    name: 'chat_preferences.usage_* (cache/context/compactions per last turn)',
    up: (db) => {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(chat_preferences)`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      )
      const additions = [
        ['usage_input_tokens', 'INTEGER'],
        ['usage_output_tokens', 'INTEGER'],
        ['usage_cache_read', 'INTEGER'],
        ['usage_cache_create', 'INTEGER'],
        ['usage_context_window', 'INTEGER'],
        ['usage_compactions', 'INTEGER NOT NULL DEFAULT 0'],
        ['usage_updated_at', 'INTEGER'],
      ]
      for (const [name, type] of additions) {
        if (!cols.has(name)) {
          db.exec(`ALTER TABLE chat_preferences ADD COLUMN ${name} ${type}`)
        }
      }
    },
  },
  {
    version: 6,
    name: 'identity_facts (curated, user-owned)',
    up: (db) => {
      // Curated per-chat facts set explicitly via /remember. Kept out of the
      // `memories` table so they bypass decay/cap and stay bounded in size.
      // fact_normalized is a trimmed+lowercased form used for dedupe only.
      db.exec(`
        CREATE TABLE IF NOT EXISTS identity_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          fact TEXT NOT NULL,
          fact_normalized TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'user',
          created_at INTEGER NOT NULL,
          UNIQUE(chat_id, fact_normalized)
        );
        CREATE INDEX IF NOT EXISTS idx_identity_facts_chat
          ON identity_facts(chat_id, created_at DESC);
      `)
    },
  },
  {
    version: 7,
    name: 'scheduled_tasks.missed_runs and last_missed_at',
    up: (db) => {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      )
      if (!cols.has('missed_runs')) {
        db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN missed_runs INTEGER NOT NULL DEFAULT 0`)
      }
      if (!cols.has('last_missed_at')) {
        db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_missed_at INTEGER`)
      }
    },
  },
  {
    version: 8,
    name: 'users + user_chats',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          is_admin INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_chats (
          chat_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK(channel IN ('telegram','discord','whatsapp')),
          added_at INTEGER NOT NULL,
          added_by TEXT,
          note TEXT,
          last_seen_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_user_chats_user
          ON user_chats(user_id);
      `)

      const now = Date.now()

      function generateUserId(): string {
        // Inline 8-hex generator; matches src/users.ts shape but is duplicated
        // here to avoid importing users.ts (which would cycle through db.ts).
        return 'u_' + crypto.randomBytes(4).toString('hex')
      }

      function ensureUser(displayName: string, createdAt: number): string {
        const userId = generateUserId()
        db.prepare(
          `INSERT INTO users (user_id, display_name, is_admin, created_at)
           VALUES (?, ?, 0, ?)`,
        ).run(userId, displayName, createdAt)
        return userId
      }

      function chatExists(chatId: string): boolean {
        return Boolean(db.prepare('SELECT 1 FROM user_chats WHERE chat_id = ?').get(chatId))
      }

      // 1. Migrate allowed_chats → telegram users
      const legacy = db
        .prepare(`SELECT chat_id, added_at, added_by, note, last_seen_at FROM allowed_chats`)
        .all() as Array<{
        chat_id: string
        added_at: number
        added_by: string | null
        note: string | null
        last_seen_at: number | null
      }>
      for (const r of legacy) {
        if (chatExists(r.chat_id)) continue
        const userId = ensureUser(r.chat_id, r.added_at)
        db.prepare(
          `INSERT INTO user_chats (chat_id, user_id, channel, added_at, added_by, note, last_seen_at)
           VALUES (?, ?, 'telegram', ?, ?, ?, ?)`,
        ).run(r.chat_id, userId, r.added_at, r.added_by, r.note, r.last_seen_at)
      }

      // 2. Seed Discord from env
      for (const raw of pendingSeeds.allowedDiscord ?? []) {
        const chatId = `discord:${raw}`
        if (chatExists(chatId)) continue
        const userId = ensureUser(chatId, now)
        db.prepare(
          `INSERT INTO user_chats (chat_id, user_id, channel, added_at, added_by, note)
           VALUES (?, ?, 'discord', ?, 'env', 'seeded from ALLOWED_DISCORD_USERS')`,
        ).run(chatId, userId, now)
      }

      // 3. Seed WhatsApp from env
      for (const raw of pendingSeeds.allowedWhatsapp ?? []) {
        const chatId = raw.includes('@') ? raw : `${raw}@s.whatsapp.net`
        if (chatExists(chatId)) continue
        const userId = ensureUser(chatId, now)
        db.prepare(
          `INSERT INTO user_chats (chat_id, user_id, channel, added_at, added_by, note)
           VALUES (?, ?, 'whatsapp', ?, 'env', 'seeded from ALLOWED_WHATSAPP_NUMBERS')`,
        ).run(chatId, userId, now)
      }

      // 4. Apply admin flags from envs
      function setAdminByChatId(chatId: string): void {
        db.prepare(
          `UPDATE users SET is_admin = 1
           WHERE user_id = (SELECT user_id FROM user_chats WHERE chat_id = ?)`,
        ).run(chatId)
      }
      for (const id of pendingSeeds.adminTelegram ?? []) setAdminByChatId(id)
      for (const id of pendingSeeds.adminDiscord ?? []) setAdminByChatId(`discord:${id}`)
      for (const raw of pendingSeeds.adminWhatsapp ?? []) {
        setAdminByChatId(raw.includes('@') ? raw : `${raw}@s.whatsapp.net`)
      }

      // 5. Bootstrap admin fallback: if there are users but none is admin,
      // promote the oldest (smallest created_at).
      const adminCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get() as { c: number }
      ).c
      const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      if (adminCount === 0 && userCount > 0) {
        db.prepare(
          `UPDATE users SET is_admin = 1
           WHERE user_id = (SELECT user_id FROM users ORDER BY created_at ASC LIMIT 1)`,
        ).run()
      }
    },
  },
]

export function getCurrentSchemaVersion(db: InstanceType<typeof Database>): number {
  const row = db.pragma('user_version', { simple: true }) as number
  return row
}

export function runMigrations(db: InstanceType<typeof Database>, seeds: MigrationSeeds = {}): void {
  pendingSeeds = seeds
  const current = getCurrentSchemaVersion(db)
  const target = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
  if (current > target) {
    logger.warn({ current, target }, 'DB schema is newer than code knows about — continuing anyway')
    pendingSeeds = {}
    return
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    logger.info({ version: m.version, name: m.name }, 'running migration')
    const tx = db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })
    try {
      tx()
      logger.info({ version: m.version }, 'migration applied')
    } catch (err) {
      logger.error({ err, version: m.version, name: m.name }, 'migration failed')
      pendingSeeds = {}
      throw err
    }
  }
  pendingSeeds = {}
}
