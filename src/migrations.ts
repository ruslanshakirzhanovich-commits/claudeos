import type Database from 'better-sqlite3'
import { logger } from './logger.js'

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
      // Data move comes in Task 4, after src/users.ts exists.
    },
  },
]

export function getCurrentSchemaVersion(db: InstanceType<typeof Database>): number {
  const row = db.pragma('user_version', { simple: true }) as number
  return row
}

export function runMigrations(db: InstanceType<typeof Database>): void {
  const current = getCurrentSchemaVersion(db)
  const target = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
  if (current > target) {
    logger.warn({ current, target }, 'DB schema is newer than code knows about — continuing anyway')
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
      throw err
    }
  }
}
