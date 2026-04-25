# Cross-channel identity foundation (stages 1+2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the database foundation for unified cross-channel user identity: introduce `users` and `user_chats` tables (migration v8), centralize all auth logic in `src/users.ts`, and rewire Telegram/Discord/WhatsApp auth checks through one DB-backed lookup. Memory, `/link`, and rate-limit-by-user are deferred to follow-up specs.

**Architecture:** Migration v8 creates the new schema and migrates data from the legacy `allowed_chats` table plus the `ALLOWED_*` / `ADMIN_*` env vars. A new `src/users.ts` module owns reads/writes against the new tables. The existing public APIs in `src/db.ts` (`isAuthorised`, `addAllowedChat`, `removeAllowedChat`, `listAllowedChats`, `touchAllowedChat`, `countAllowedChats`, `isChatAllowed`, `isOpenMode`) become thin wrappers. Same for `src/config.ts` channel-specific helpers. Open-mode auto-adds the first incoming chat as a new user (auto-promoted to admin if no admins exist).

**Tech Stack:** TypeScript (strict), better-sqlite3 + WAL, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-25-cross-channel-identity-foundation-design.md`

---

## File Structure

**Create:**
- `src/users.ts` — owns `users` + `user_chats` reads and writes
- `tests/users-lookup.test.ts` — `users.ts` core API
- `tests/migration-v8.test.ts` — migration data move + bootstrap fallback
- `tests/channel-router-helpers.test.ts` — `discordChatId`, `whatsappChatId`
- `tests/auth-matrix-unified.test.ts` — Telegram/Discord/WhatsApp through one lookup
- `tests/adduser-command.test.ts` — cross-channel `/adduser` flags

**Modify:**
- `src/migrations.ts` — append migration v8 (schema + data + bootstrap)
- `src/channel-router.ts` — add `discordChatId`, `whatsappChatId` helpers
- `src/db.ts` — wrap `isAuthorised`, `isAdmin`, `addAllowedChat`, `removeAllowedChat`, `listAllowedChats`, `touchAllowedChat`, `countAllowedChats`, `isChatAllowed`, `isOpenMode` to delegate to `users.ts`. Delete `seedAllowedChatsFromEnv`.
- `src/config.ts` — `isAdmin`, `isDiscordUserAuthorised`, `isDiscordUserAdmin`, `isWhatsAppAuthorised`, `isWhatsAppNumberAdmin` become DB-backed wrappers. Delete `isAdminOf`, `isDiscordUserAuthorisedOf`, `isDiscordUserAdminOf`, `isWhatsAppAuthorisedOf`, `isWhatsAppNumberAdminOf` helpers.
- `src/bot.ts` — open-mode auto-add hook in `handleMessage` and `warnOpenModeOnce` lifted to a shared module (or kept local; see Task 8).
- `src/discord/handler.ts`, `src/whatsapp/handler.ts` — open-mode auto-add hook.
- `src/index.ts` — remove `seedAllowedChatsFromEnv` call.
- `src/commands/users.ts` — `/adduser` accepts cross-channel ids + flags; `/removeuser` accepts any format.
- `tests/permissions.test.ts` — rewrite using DB-backed setup.
- `tests/chat-id-validation.test.ts` — adjust if it relied on the now-relaxed `removeAllowedChat` Telegram guard.
- `tests/remove-chat.test.ts` — extend to cover user deletion when last chat removed.
- `tests/handler-inflight.test.ts` — mock pattern updated (no more `*Of` exports).

---

## Task 1: Migration v8 schema

**Files:**
- Modify: `src/migrations.ts`

- [ ] **Step 1: Append v8 with schema only**

In `src/migrations.ts`, append to the `MIGRATIONS` array (after the v7 entry):

```typescript
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
      // Data move comes in Task 3, after src/users.ts exists.
    },
  },
```

- [ ] **Step 2: Smoke-run on a fresh DB**

```bash
rm -f /tmp/cc-v8-smoke.db
npx tsx -e "
import Database from 'better-sqlite3'
import { runMigrations } from './src/migrations.ts'
const db = new Database('/tmp/cc-v8-smoke.db')
db.pragma('journal_mode = WAL')
runMigrations(db)
console.log('user_version =', db.pragma('user_version', { simple: true }))
const tables = db.prepare(\`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\`).all()
console.log(tables.map(t => t.name).join(','))
" 2>&1 | grep -v INFO
rm -f /tmp/cc-v8-smoke.db*
```

Expected: `user_version = 8`, table list includes `users` and `user_chats`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/migrations.ts
git commit -m "feat(migrations): v8 schema for users and user_chats

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `src/users.ts` core API + lookup tests

**Files:**
- Create: `src/users.ts`
- Create: `tests/users-lookup.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/users-lookup.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-users-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpRoot,
}))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb } = await import('../src/db.js')
const {
  generateUserId,
  getUserByChat,
  countUsers,
  isOpenMode,
  isAuthorisedChat,
  isAdminChat,
  addUserChat,
  removeUserChat,
  touchUserChat,
} = await import('../src/users.ts')

initDatabase()

beforeEach(() => {
  getDb().exec('DELETE FROM user_chats; DELETE FROM users;')
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('users.ts', () => {
  it('generateUserId returns u_ + 8 hex', () => {
    const id = generateUserId()
    expect(id).toMatch(/^u_[0-9a-f]{8}$/)
  })

  it('isOpenMode true when users empty, false after addUserChat', () => {
    expect(isOpenMode()).toBe(true)
    expect(countUsers()).toBe(0)
    addUserChat({ chatId: '12345', channel: 'telegram' })
    expect(isOpenMode()).toBe(false)
    expect(countUsers()).toBe(1)
  })

  it('addUserChat creates a new user when no existingUserId given', () => {
    const r = addUserChat({ chatId: '12345', channel: 'telegram' })
    expect(r.created).toBe(true)
    const lookup = getUserByChat('12345')
    expect(lookup?.userId).toBe(r.userId)
    expect(lookup?.channel).toBe('telegram')
    expect(lookup?.isAdmin).toBe(true) // bootstrap: first user
  })

  it('addUserChat with existingUserId links to existing user, no new user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    const b = addUserChat({
      chatId: 'discord:222',
      channel: 'discord',
      existingUserId: a.userId,
    })
    expect(b.created).toBe(false)
    expect(b.userId).toBe(a.userId)
    expect(getUserByChat('discord:222')?.userId).toBe(a.userId)
  })

  it('addUserChat second user is not admin by default (only first auto-promotes)', () => {
    addUserChat({ chatId: '11111', channel: 'telegram' })
    const b = addUserChat({ chatId: '22222', channel: 'telegram' })
    expect(getUserByChat('22222')?.isAdmin).toBe(false)
    // first user remains admin
    expect(getUserByChat('11111')?.isAdmin).toBe(true)
    void b
  })

  it('addUserChat respects explicit isAdmin: false on the very first user', () => {
    addUserChat({ chatId: '11111', channel: 'telegram', isAdmin: false })
    expect(getUserByChat('11111')?.isAdmin).toBe(false)
  })

  it('isAuthorisedChat: true in open mode (any chat); membership-based otherwise', () => {
    expect(isAuthorisedChat('any')).toBe(true)
    addUserChat({ chatId: '11111', channel: 'telegram' })
    expect(isAuthorisedChat('11111')).toBe(true)
    expect(isAuthorisedChat('99999')).toBe(false)
  })

  it('isAdminChat reflects users.is_admin via the chat lookup', () => {
    addUserChat({ chatId: '11111', channel: 'telegram' })
    expect(isAdminChat('11111')).toBe(true)
    addUserChat({ chatId: '22222', channel: 'telegram' })
    expect(isAdminChat('22222')).toBe(false)
  })

  it('removeUserChat with last chat deletes the user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    const r = removeUserChat('11111')
    expect(r.removed).toBe(true)
    expect(r.userDeleted).toBe(true)
    expect(getUserByChat('11111')).toBeNull()
    // Confirm user row gone
    const row = getDb()
      .prepare('SELECT 1 FROM users WHERE user_id = ?')
      .get(a.userId)
    expect(row).toBeUndefined()
  })

  it('removeUserChat with multiple chats keeps the user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    addUserChat({ chatId: 'discord:222', channel: 'discord', existingUserId: a.userId })
    const r = removeUserChat('11111')
    expect(r.removed).toBe(true)
    expect(r.userDeleted).toBe(false)
    expect(getUserByChat('discord:222')?.userId).toBe(a.userId)
  })

  it('touchUserChat updates last_seen_at', () => {
    addUserChat({ chatId: '11111', channel: 'telegram' })
    const before = getDb()
      .prepare('SELECT last_seen_at FROM user_chats WHERE chat_id = ?')
      .get('11111') as { last_seen_at: number | null }
    expect(before.last_seen_at).toBeNull()
    touchUserChat('11111')
    const after = getDb()
      .prepare('SELECT last_seen_at FROM user_chats WHERE chat_id = ?')
      .get('11111') as { last_seen_at: number }
    expect(after.last_seen_at).toBeGreaterThan(0)
  })

  it('addUserChat rejects mismatched channel/format', () => {
    expect(() =>
      addUserChat({ chatId: '12345', channel: 'discord' }),
    ).toThrow(/channel.*mismatch|format/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- users-lookup`
Expected: FAIL — module `src/users.ts` not found.

- [ ] **Step 3: Implement `src/users.ts`**

Create `src/users.ts`:

```typescript
import crypto from 'node:crypto'
import { getDb } from './db.js'
import { classifyChatId, type ChannelKind } from './channel-router.js'
import { logger } from './logger.js'

export interface UserLookup {
  userId: string
  isAdmin: boolean
  channel: ChannelKind
}

export interface AddUserChatOpts {
  chatId: string
  channel: ChannelKind
  existingUserId?: string
  isAdmin?: boolean
  addedBy?: string
  note?: string
  displayName?: string
}

export interface AddUserChatResult {
  userId: string
  created: boolean
}

export interface RemoveUserChatResult {
  removed: boolean
  userDeleted: boolean
  memoriesDeleted: number
  tasksDeleted: number
  sessionCleared: boolean
  preferencesCleared: boolean
}

export function generateUserId(): string {
  return 'u_' + crypto.randomBytes(4).toString('hex')
}

export function countUsers(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM users')
    .get() as { c: number }
  return row.c
}

export function isOpenMode(): boolean {
  return countUsers() === 0
}

export function getUserByChat(chatId: string): UserLookup | null {
  const row = getDb()
    .prepare(
      `SELECT u.user_id AS userId, u.is_admin AS isAdmin, c.channel AS channel
       FROM user_chats c JOIN users u ON u.user_id = c.user_id
       WHERE c.chat_id = ?`,
    )
    .get(chatId) as
    | { userId: string; isAdmin: number; channel: ChannelKind }
    | undefined
  if (!row) return null
  return { userId: row.userId, isAdmin: row.isAdmin === 1, channel: row.channel }
}

export function isAuthorisedChat(chatId: string): boolean {
  if (isOpenMode()) return true
  return getUserByChat(chatId) !== null
}

export function isAdminChat(chatId: string): boolean {
  return getUserByChat(chatId)?.isAdmin === true
}

export function addUserChat(opts: AddUserChatOpts): AddUserChatResult {
  const detected = classifyChatId(opts.chatId)
  if (detected !== opts.channel) {
    throw new Error(
      `addUserChat: channel mismatch — chat_id ${opts.chatId.slice(0, 80)} parsed as ${detected}, declared as ${opts.channel}`,
    )
  }

  const db = getDb()
  const now = Date.now()

  const tx = db.transaction((): AddUserChatResult => {
    let userId = opts.existingUserId
    let created = false
    if (!userId) {
      // Bootstrap: if there are no users yet and isAdmin is not explicitly false,
      // promote this user to admin.
      const existingCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      const shouldAutoAdmin = existingCount === 0 && opts.isAdmin !== false
      const isAdmin = opts.isAdmin ?? shouldAutoAdmin
      userId = generateUserId()
      db.prepare(
        `INSERT INTO users (user_id, display_name, is_admin, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(userId, opts.displayName ?? opts.chatId, isAdmin ? 1 : 0, now)
      created = true
      if (shouldAutoAdmin) {
        logger.warn({ userId }, 'bootstrap admin: promoted first user')
      }
      logger.info(
        { userId, channel: opts.channel, chatId: opts.chatId, addedBy: opts.addedBy },
        'user created',
      )
    } else {
      // If isAdmin is provided and user exists, update the flag.
      if (typeof opts.isAdmin === 'boolean') {
        db.prepare('UPDATE users SET is_admin = ? WHERE user_id = ?').run(
          opts.isAdmin ? 1 : 0,
          userId,
        )
      }
    }

    db.prepare(
      `INSERT INTO user_chats (chat_id, user_id, channel, added_at, added_by, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(opts.chatId, userId, opts.channel, now, opts.addedBy ?? null, opts.note ?? null)

    return { userId, created }
  })

  return tx()
}

export function removeUserChat(chatId: string): RemoveUserChatResult {
  const db = getDb()

  const tx = db.transaction((): RemoveUserChatResult => {
    const before = db
      .prepare('SELECT user_id FROM user_chats WHERE chat_id = ?')
      .get(chatId) as { user_id: string } | undefined

    const chat = db.prepare('DELETE FROM user_chats WHERE chat_id = ?').run(chatId)
    const prefs = db.prepare('DELETE FROM chat_preferences WHERE chat_id = ?').run(chatId)
    const session = db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
    const memories = db.prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId)
    const tasks = db.prepare('DELETE FROM scheduled_tasks WHERE chat_id = ?').run(chatId)

    let userDeleted = false
    if (before) {
      const remaining = (
        db.prepare('SELECT COUNT(*) AS c FROM user_chats WHERE user_id = ?').get(before.user_id) as
          | { c: number }
      ).c
      if (remaining === 0) {
        db.prepare('DELETE FROM users WHERE user_id = ?').run(before.user_id)
        userDeleted = true
        logger.info({ userId: before.user_id }, 'user removed (last chat deleted)')
      }
    }

    return {
      removed: Number(chat.changes) > 0,
      userDeleted,
      memoriesDeleted: Number(memories.changes),
      tasksDeleted: Number(tasks.changes),
      sessionCleared: Number(session.changes) > 0,
      preferencesCleared: Number(prefs.changes) > 0,
    }
  })

  return tx()
}

export function touchUserChat(chatId: string): void {
  getDb()
    .prepare('UPDATE user_chats SET last_seen_at = ? WHERE chat_id = ?')
    .run(Date.now(), chatId)
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run test -- users-lookup`
Expected: all 11 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/users.ts tests/users-lookup.test.ts
git commit -m "feat(users): users.ts core API for cross-channel identity

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Channel chat-id helpers

**Files:**
- Modify: `src/channel-router.ts`
- Create: `tests/channel-router-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/channel-router-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { discordChatId, whatsappChatId } from '../src/channel-router.js'

describe('channel chat-id helpers', () => {
  it('discordChatId prefixes a raw user id', () => {
    expect(discordChatId('110440505')).toBe('discord:110440505')
  })

  it('whatsappChatId expands a bare number to a JID', () => {
    expect(whatsappChatId('15551234567')).toBe('15551234567@s.whatsapp.net')
  })

  it('whatsappChatId leaves a JID unchanged', () => {
    expect(whatsappChatId('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- channel-router-helpers`
Expected: FAIL — exports not found.

- [ ] **Step 3: Add the helpers**

Open `src/channel-router.ts` and append:

```typescript
export function discordChatId(rawUserId: string): string {
  return `discord:${rawUserId}`
}

export function whatsappChatId(rawNumber: string): string {
  return rawNumber.includes('@') ? rawNumber : `${rawNumber}@s.whatsapp.net`
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run test -- channel-router-helpers`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channel-router.ts tests/channel-router-helpers.test.ts
git commit -m "feat(channel-router): discordChatId and whatsappChatId helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Migration v8 data move

**Files:**
- Modify: `src/migrations.ts`
- Create: `tests/migration-v8.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/migration-v8.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig8-'))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

vi.mock('../src/config.js', () => ({
  ALLOWED_CHAT_IDS: ['111', '222'],
  ADMIN_CHAT_IDS: ['111'],
  ALLOWED_DISCORD_USERS: ['d-aaa'],
  ADMIN_DISCORD_USERS: [],
  ALLOWED_WHATSAPP_NUMBERS: ['15551234567'],
  ADMIN_WHATSAPP_NUMBERS: [],
}))

const { runMigrations, MIGRATIONS } = await import('../src/migrations.js')

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function freshDb(name: string): InstanceType<typeof Database> {
  const file = path.join(tmpRoot, name)
  try {
    fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  return db
}

describe('migration v8', () => {
  it('seeds users from existing allowed_chats and env lists', () => {
    const db = freshDb('seed.db')
    try {
      // Run v1..v7 first
      const v7Idx = MIGRATIONS.findIndex((m) => m.version === 7)
      const upTov7 = MIGRATIONS.slice(0, v7Idx + 1)
      const v7Pragma = db.transaction(() => {
        for (const m of upTov7) m.up(db)
        db.pragma('user_version = 7')
      })
      v7Pragma()

      // Seed legacy allowed_chats with ALLOWED_CHAT_IDS-equivalent rows (the
      // test's mocked ALLOWED_CHAT_IDS isn't auto-applied; we hand-insert).
      const now = Date.now()
      db.prepare(
        `INSERT INTO allowed_chats (chat_id, added_at, added_by, note, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('111', now - 1000, 'env', 'first', null)
      db.prepare(
        `INSERT INTO allowed_chats (chat_id, added_at, added_by, note, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('222', now, 'env', null, null)

      // Now run remaining migrations (v8)
      runMigrations(db)

      const users = db.prepare('SELECT user_id, display_name, is_admin FROM users ORDER BY created_at').all() as Array<{
        user_id: string
        display_name: string
        is_admin: number
      }>
      // 2 from allowed_chats + 1 Discord + 1 WhatsApp = 4 users
      expect(users).toHaveLength(4)

      const userChats = db.prepare('SELECT chat_id, channel FROM user_chats ORDER BY chat_id').all() as Array<{
        chat_id: string
        channel: string
      }>
      const chatIds = userChats.map((c) => c.chat_id).sort()
      expect(chatIds).toEqual(
        ['111', '15551234567@s.whatsapp.net', '222', 'discord:d-aaa'].sort(),
      )

      // ADMIN_CHAT_IDS = ['111'] → user owning '111' is admin
      const admin111 = db
        .prepare(
          `SELECT u.is_admin FROM users u JOIN user_chats c ON c.user_id = u.user_id
           WHERE c.chat_id = '111'`,
        )
        .get() as { is_admin: number }
      expect(admin111.is_admin).toBe(1)
    } finally {
      db.close()
    }
  })

  it('bootstrap admin fallback: promotes oldest user when no admin envs set', async () => {
    const db = freshDb('bootstrap.db')
    try {
      // Re-mock with empty admin envs
      vi.resetModules()
      vi.doMock('../src/logger.js', () => ({
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      }))
      vi.doMock('../src/config.js', () => ({
        ALLOWED_CHAT_IDS: [],
        ADMIN_CHAT_IDS: [],
        ALLOWED_DISCORD_USERS: ['d1', 'd2'],
        ADMIN_DISCORD_USERS: [],
        ALLOWED_WHATSAPP_NUMBERS: [],
        ADMIN_WHATSAPP_NUMBERS: [],
      }))
      const { runMigrations: rm } = await import('../src/migrations.js')

      rm(db)

      const adminCount = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get() as {
        c: number
      }).c
      expect(adminCount).toBe(1)

      // Oldest user (smallest created_at)
      const oldest = db
        .prepare('SELECT user_id, is_admin FROM users ORDER BY created_at ASC LIMIT 1')
        .get() as { user_id: string; is_admin: number }
      expect(oldest.is_admin).toBe(1)
    } finally {
      db.close()
    }
  })

  it('empty env + empty allowed_chats: users table stays empty', async () => {
    const db = freshDb('empty.db')
    try {
      vi.resetModules()
      vi.doMock('../src/logger.js', () => ({
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      }))
      vi.doMock('../src/config.js', () => ({
        ALLOWED_CHAT_IDS: [],
        ADMIN_CHAT_IDS: [],
        ALLOWED_DISCORD_USERS: [],
        ADMIN_DISCORD_USERS: [],
        ALLOWED_WHATSAPP_NUMBERS: [],
        ADMIN_WHATSAPP_NUMBERS: [],
      }))
      const { runMigrations: rm } = await import('../src/migrations.js')
      rm(db)

      const cnt = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      expect(cnt).toBe(0)
    } finally {
      db.close()
    }
  })

  it('idempotent: reset user_version=7 and re-run is a no-op for v8', async () => {
    const db = freshDb('idempotent.db')
    try {
      vi.resetModules()
      vi.doMock('../src/logger.js', () => ({
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      }))
      vi.doMock('../src/config.js', () => ({
        ALLOWED_CHAT_IDS: [],
        ADMIN_CHAT_IDS: [],
        ALLOWED_DISCORD_USERS: ['d-once'],
        ADMIN_DISCORD_USERS: [],
        ALLOWED_WHATSAPP_NUMBERS: [],
        ADMIN_WHATSAPP_NUMBERS: [],
      }))
      const { runMigrations: rm } = await import('../src/migrations.js')

      rm(db)
      const before = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      expect(before).toBe(1)

      // Reset and run again: data move should not duplicate (it checks
      // existence before inserting per chat_id).
      db.pragma('user_version = 7')
      rm(db)
      const after = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
      expect(after).toBe(1)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- migration-v8`
Expected: FAIL — v8 only has the schema; no data is moved yet.

- [ ] **Step 3: Add data move to v8.up()**

In `src/migrations.ts`, replace the `version: 8` migration with:

```typescript
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

      // Lazy-import config to avoid circular dependency at module load.
      // The migration runs at startup time after config has been set up.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('./config.js') as {
        ADMIN_CHAT_IDS: readonly string[]
        ALLOWED_DISCORD_USERS: readonly string[]
        ADMIN_DISCORD_USERS: readonly string[]
        ALLOWED_WHATSAPP_NUMBERS: readonly string[]
        ADMIN_WHATSAPP_NUMBERS: readonly string[]
      }

      const now = Date.now()

      function generateUserId(): string {
        // Simple hex generator inline to avoid importing src/users.ts here
        // (which would create a cycle). 8 hex chars from a CSPRNG source.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const c = require('node:crypto') as typeof import('node:crypto')
        return 'u_' + c.randomBytes(4).toString('hex')
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
        return Boolean(
          db.prepare('SELECT 1 FROM user_chats WHERE chat_id = ?').get(chatId),
        )
      }

      // 1. Migrate allowed_chats → telegram users
      const legacy = db
        .prepare(
          `SELECT chat_id, added_at, added_by, note, last_seen_at FROM allowed_chats`,
        )
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
      for (const raw of config.ALLOWED_DISCORD_USERS) {
        const chatId = `discord:${raw}`
        if (chatExists(chatId)) continue
        const userId = ensureUser(chatId, now)
        db.prepare(
          `INSERT INTO user_chats (chat_id, user_id, channel, added_at, added_by, note)
           VALUES (?, ?, 'discord', ?, 'env', 'seeded from ALLOWED_DISCORD_USERS')`,
        ).run(chatId, userId, now)
      }

      // 3. Seed WhatsApp from env
      for (const raw of config.ALLOWED_WHATSAPP_NUMBERS) {
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
      for (const id of config.ADMIN_CHAT_IDS) setAdminByChatId(id)
      for (const id of config.ADMIN_DISCORD_USERS) setAdminByChatId(`discord:${id}`)
      for (const raw of config.ADMIN_WHATSAPP_NUMBERS) {
        setAdminByChatId(raw.includes('@') ? raw : `${raw}@s.whatsapp.net`)
      }

      // 5. Bootstrap admin fallback: if there are users but none is admin,
      // promote the oldest (smallest created_at).
      const adminCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get() as { c: number }
      ).c
      const userCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
      ).c
      if (adminCount === 0 && userCount > 0) {
        db.prepare(
          `UPDATE users SET is_admin = 1
           WHERE user_id = (SELECT user_id FROM users ORDER BY created_at ASC LIMIT 1)`,
        ).run()
      }
    },
  },
```

The `require('./config.js')` is a deliberate runtime import to avoid the static-import cycle (`migrations.ts` → `config.ts` → fine; but `users.ts` → `db.ts` → `migrations.ts` → `users.ts` would loop if migrations imported users statically). Migration runs at startup after env is parsed.

- [ ] **Step 4: Run migration tests**

Run: `npm run test -- migration-v8`
Expected: 4 tests pass.

- [ ] **Step 5: Run the existing migration suite**

Run: `npm run test -- migrations-idempotent`
Expected: existing idempotency tests still pass with v8 added (the test resets `user_version=0` and re-runs all migrations; v8's `chatExists` guard makes data move idempotent).

- [ ] **Step 6: Commit**

```bash
git add src/migrations.ts tests/migration-v8.test.ts
git commit -m "feat(migrations): v8 data move from allowed_chats and env seeds

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `db.ts` wrappers

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Replace existing functions with wrappers**

Open `src/db.ts`. Add the import at the top:

```typescript
import * as users from './users.js'
import { classifyChatId, discordChatId, whatsappChatId } from './channel-router.js'
```

Replace the existing implementations:

`isAuthorised`:
```typescript
export function isAuthorised(chatId: number | string): boolean {
  return users.isAuthorisedChat(String(chatId))
}
```

`isOpenMode`:
```typescript
export function isOpenMode(): boolean {
  return users.isOpenMode()
}
```

`isChatAllowed`:
```typescript
export function isChatAllowed(chatId: string): boolean {
  return users.getUserByChat(chatId) !== null
}
```

`countAllowedChats` (counts chats, not users):
```typescript
export function countAllowedChats(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM user_chats')
    .get() as { c: number }
  return row.c
}
```

`addAllowedChat` (Telegram-only legacy guard preserved):
```typescript
export function addAllowedChat(
  chatId: string,
  addedBy: string | null,
  note: string | null,
): boolean {
  if (!isValidTelegramChatId(chatId)) {
    throw new Error(`addAllowedChat: not a Telegram chat id: ${chatId.slice(0, 80)}`)
  }
  // If already present, no-op (legacy behaviour: ON CONFLICT DO NOTHING).
  if (isChatAllowed(chatId)) return false
  users.addUserChat({
    chatId,
    channel: 'telegram',
    addedBy: addedBy ?? undefined,
    note: note ?? undefined,
  })
  return true
}
```

`removeAllowedChat`:
```typescript
export function removeAllowedChat(chatId: string): RemoveChatResult {
  const r = users.removeUserChat(chatId)
  return {
    removed: r.removed,
    memoriesDeleted: r.memoriesDeleted,
    tasksDeleted: r.tasksDeleted,
    sessionCleared: r.sessionCleared,
    preferencesCleared: r.preferencesCleared,
  }
}
```

`touchAllowedChat`:
```typescript
export function touchAllowedChat(chatId: string): void {
  users.touchUserChat(chatId)
}
```

`listAllowedChats` (project new schema back into legacy shape):
```typescript
export function listAllowedChats(): AllowedChatRow[] {
  return getDb()
    .prepare(
      `SELECT c.chat_id AS chat_id, c.added_at AS added_at, c.added_by AS added_by,
              c.note AS note, c.last_seen_at AS last_seen_at
       FROM user_chats c
       ORDER BY c.added_at ASC`,
    )
    .all() as AllowedChatRow[]
}
```

Delete `seedAllowedChatsFromEnv` entirely. Migration v8 handles seeding; runtime callers no longer need it.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the existing test suite**

Run: `npm run test`
Expected: most tests still pass. Some auth/permissions/chat-id tests may fail because they relied on `*Of` helpers or legacy semantics — those are fixed in Tasks 7 and 10.

If `users-lookup` and `migration-v8` tests still pass, the wrapper layer is consistent. Specific failures in Telegram/Discord auth tests are expected pre-Task-7.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts
git commit -m "refactor(db): auth wrappers delegate to users.ts; remove seedAllowedChatsFromEnv

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `config.ts` wrappers + remove `*Of` helpers

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the import at the top of `src/config.ts`**

```typescript
import * as users from './users.js'
import { discordChatId, whatsappChatId } from './channel-router.js'
```

- [ ] **Step 2: Replace `isAdmin` / `isAdminOf`**

Find the block:

```typescript
export function isAdminOf(admins: readonly string[], chatId: number | string): boolean {
  if (admins.length === 0) return false
  return admins.includes(String(chatId))
}

export function isAdmin(chatId: number | string): boolean {
  return isAdminOf(ADMIN_CHAT_IDS, chatId)
}
```

Replace with:

```typescript
export function isAdmin(chatId: number | string): boolean {
  return users.isAdminChat(String(chatId))
}
```

(`isAdminOf` deleted.)

- [ ] **Step 3: Replace Discord auth helpers**

Find the Discord block (`isDiscordUserAuthorisedOf` through `isDiscordUserAdmin`). Replace with:

```typescript
export function isDiscordUserAuthorised(userId: string): boolean {
  return users.isAuthorisedChat(discordChatId(userId))
}

export function isDiscordUserAdmin(userId: string): boolean {
  return users.isAdminChat(discordChatId(userId))
}
```

Delete `isDiscordUserAuthorisedOf` and `isDiscordUserAdminOf`.

- [ ] **Step 4: Replace WhatsApp auth helpers**

Find the WhatsApp block (`isWhatsAppAuthorisedOf` through `isWhatsAppNumberAdmin`). Replace with:

```typescript
export function isWhatsAppAuthorised(number: string): boolean {
  return users.isAuthorisedChat(whatsappChatId(number))
}

export function isWhatsAppNumberAdmin(number: string): boolean {
  return users.isAdminChat(whatsappChatId(number))
}
```

Delete `isWhatsAppAuthorisedOf` and `isWhatsAppNumberAdminOf`.

- [ ] **Step 5: Annotate env-listed allowlists as seed-only**

Above the `ALLOWED_DISCORD_USERS`, `ADMIN_DISCORD_USERS`, `ALLOWED_WHATSAPP_NUMBERS`, `ADMIN_WHATSAPP_NUMBERS` exports, add a comment:

```typescript
// First-boot seeds only. Migration v8 reads these once to populate the
// users + user_chats tables. After v8, the database is the source of
// truth — these env vars have no effect on runtime auth.
```

The same comment for `ALLOWED_CHAT_IDS` and `ADMIN_CHAT_IDS`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: TypeScript will flag unresolved imports in tests that used `*Of` (handler-inflight.test.ts, permissions.test.ts). Fixed in Task 7.

If typecheck is clean for `src/`, proceed. If errors are only in `tests/`, that's expected.

Run: `npx tsc --noEmit src/*.ts src/**/*.ts 2>&1 | grep -E "^src/"`

This restricts the check to `src/`. Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts
git commit -m "refactor(config): channel auth helpers delegate to users.ts; drop *Of helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update tests that used `*Of` helpers

**Files:**
- Modify: `tests/permissions.test.ts`
- Modify: `tests/handler-inflight.test.ts`

- [ ] **Step 1: Read `tests/permissions.test.ts`**

Run: `cat /root/claudeos-dev/tests/permissions.test.ts`

Identify what each test was verifying with `*Of` helpers (membership-based checks against an explicit array).

- [ ] **Step 2: Rewrite `tests/permissions.test.ts` against the DB-backed API**

Replace the file body with this template (adjust to match the original assertions):

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perms-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<any>('../src/config.js')
  return { ...actual, DB_PATH: dbFile, STORE_DIR: tmpRoot }
})

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb } = await import('../src/db.js')
const { addUserChat } = await import('../src/users.js')
const config = await import('../src/config.js')

initDatabase()

beforeEach(() => {
  getDb().exec('DELETE FROM user_chats; DELETE FROM users;')
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('Telegram isAdmin', () => {
  it('returns false for non-member chats', () => {
    addUserChat({ chatId: '111', channel: 'telegram', isAdmin: false })
    expect(config.isAdmin('999')).toBe(false)
  })

  it('returns true for admin members', () => {
    addUserChat({ chatId: '111', channel: 'telegram', isAdmin: true })
    expect(config.isAdmin('111')).toBe(true)
  })
})

describe('Discord isDiscordUserAdmin', () => {
  it('false for non-member', () => {
    addUserChat({ chatId: 'discord:aaa', channel: 'discord', isAdmin: false })
    expect(config.isDiscordUserAdmin('zzz')).toBe(false)
  })

  it('true for admin member', () => {
    addUserChat({ chatId: 'discord:aaa', channel: 'discord', isAdmin: true })
    expect(config.isDiscordUserAdmin('aaa')).toBe(true)
  })
})

describe('WhatsApp isWhatsAppNumberAdmin', () => {
  it('false for non-member', () => {
    addUserChat({ chatId: '15551234567@s.whatsapp.net', channel: 'whatsapp', isAdmin: false })
    expect(config.isWhatsAppNumberAdmin('15559999999')).toBe(false)
  })

  it('true for admin member', () => {
    addUserChat({ chatId: '15551234567@s.whatsapp.net', channel: 'whatsapp', isAdmin: true })
    expect(config.isWhatsAppNumberAdmin('15551234567')).toBe(true)
  })
})

describe('Discord isDiscordUserAuthorised', () => {
  it('open mode allows everyone', () => {
    expect(config.isDiscordUserAuthorised('any')).toBe(true)
  })

  it('strict mode rejects non-members', () => {
    addUserChat({ chatId: 'discord:aaa', channel: 'discord' })
    expect(config.isDiscordUserAuthorised('aaa')).toBe(true)
    expect(config.isDiscordUserAuthorised('zzz')).toBe(false)
  })
})

describe('WhatsApp isWhatsAppAuthorised', () => {
  it('open mode allows everyone', () => {
    expect(config.isWhatsAppAuthorised('15551234567')).toBe(true)
  })

  it('strict mode rejects non-members', () => {
    addUserChat({ chatId: '15551234567@s.whatsapp.net', channel: 'whatsapp' })
    expect(config.isWhatsAppAuthorised('15551234567')).toBe(true)
    expect(config.isWhatsAppAuthorised('15559999999')).toBe(false)
  })
})
```

- [ ] **Step 3: Update `tests/handler-inflight.test.ts`**

The mocked module currently exports `*Of` helpers. Find the `vi.mock('../src/config.js', ...)` block and remove the `*Of` lines. Keep only the public surface (`isDiscordUserAuthorised: () => true`, etc.). The handlers don't call `*Of` anymore.

Final config mock should be:

```typescript
vi.mock('../src/config.js', () => ({
  TYPING_REFRESH_MS: 4000,
  MAX_MESSAGE_LENGTH: 4096,
  isDiscordUserAuthorised: () => true,
  isDiscordUserAdmin: () => false,
  isWhatsAppAuthorised: () => true,
  isWhatsAppNumberAdmin: () => false,
}))
```

- [ ] **Step 4: Run the affected tests**

Run: `npm run test -- permissions handler-inflight`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/permissions.test.ts tests/handler-inflight.test.ts
git commit -m "test: rewrite permissions tests against DB-backed users API

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Open-mode auto-add in handlers

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/discord/handler.ts`
- Modify: `src/whatsapp/handler.ts`

- [ ] **Step 1: Telegram — auto-add in `handleMessage`**

Open `src/bot.ts`. Find the `handleMessage` body where it currently does:

```typescript
  if (!isAuthorised(chatId)) {
    log.warn('unauthorised chat')
    return
  }

  if (isOpenMode()) warnOpenModeOnce(chatId, userId, username, log)

  touchAllowedChat(chatId)
```

Replace with:

```typescript
  if (!isAuthorised(chatId)) {
    log.warn('unauthorised chat')
    return
  }

  if (isOpenMode()) {
    warnOpenModeOnce(chatId, userId, username, log)
    // Auto-add the first incoming chat as a new user (auto-promotes to admin
    // because countUsers() === 0 in open mode). Subsequent messages from
    // *other* chats will be rejected by isAuthorised above.
    const { addUserChat } = await import('./users.js')
    addUserChat({
      chatId,
      channel: 'telegram',
      addedBy: 'open-mode',
      note: `auto-added from ${username ?? 'unknown'}`,
    })
  }

  touchAllowedChat(chatId)
```

The dynamic import keeps `bot.ts` from a static cycle if any future change pulls users.ts further into it. If this file already statically imports `users.ts` elsewhere (it doesn't today), promote to a top-level import.

- [ ] **Step 2: Discord — auto-add in `handleDiscordMessageInner`**

Open `src/discord/handler.ts`. Inside `handleDiscordMessageInner`, after the `isDiscordUserAuthorised` check (around line 32):

```typescript
  if (!isDiscordUserAuthorised(msg.userId)) {
    log.warn({ author: msg.authorTag }, 'unauthorised discord sender')
    return
  }

  const chatId = chatIdForDiscordUser(msg.userId)
```

Add right before the `chatId` line:

```typescript
  // Open-mode auto-add: same behaviour as Telegram's handleMessage.
  const { isOpenMode } = await import('../users.js')
  const { addUserChat } = await import('../users.js')
  if (isOpenMode()) {
    log.warn({ author: msg.authorTag }, 'OPEN MODE accepted new discord chat')
    addUserChat({
      chatId: chatIdForDiscordUser(msg.userId),
      channel: 'discord',
      addedBy: 'open-mode',
      note: `auto-added from ${msg.authorTag}`,
    })
  }
```

- [ ] **Step 3: WhatsApp — auto-add in `handleWhatsAppMessageInner`**

Open `src/whatsapp/handler.ts`. Inside `handleWhatsAppMessageInner`, after the `isWhatsAppAuthorised` check:

```typescript
  if (!isWhatsAppAuthorised(number)) {
    log.warn({ number }, 'unauthorised whatsapp sender')
    return
  }
```

Add immediately after:

```typescript
  const { isOpenMode } = await import('../users.js')
  const { addUserChat } = await import('../users.js')
  if (isOpenMode()) {
    log.warn({ number }, 'OPEN MODE accepted new whatsapp chat')
    addUserChat({
      chatId: jid,
      channel: 'whatsapp',
      addedBy: 'open-mode',
      note: `auto-added from ${number}`,
    })
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the suite**

Run: `npm run test`
Expected: all green. The `tests/handler-inflight.test.ts` mock for `runChatPipeline` short-circuits early; the auto-add path runs but on a test DB it's a no-op (open mode is true if the test DB is empty, which it is).

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts src/discord/handler.ts src/whatsapp/handler.ts
git commit -m "feat(handlers): open-mode auto-add for all three channels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `/adduser` cross-channel + flags

**Files:**
- Modify: `src/commands/users.ts`
- Create: `tests/adduser-command.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/adduser-command.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-adduser-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<any>('../src/config.js')
  return { ...actual, DB_PATH: dbFile, STORE_DIR: tmpRoot }
})
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb } = await import('../src/db.js')
const { addUserChat, getUserByChat } = await import('../src/users.js')
const { parseAddUserArgs } = await import('../src/commands/users.js')

initDatabase()

beforeEach(() => {
  getDb().exec('DELETE FROM user_chats; DELETE FROM users;')
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('parseAddUserArgs', () => {
  it('parses a Telegram numeric chat id', () => {
    const r = parseAddUserArgs(['12345'])
    expect(r).toEqual({
      chatId: '12345',
      channel: 'telegram',
      isAdmin: false,
      existingUserId: undefined,
      note: null,
    })
  })

  it('parses a Discord chat id with --admin', () => {
    const r = parseAddUserArgs(['discord:abc', '--admin'])
    expect(r).toEqual({
      chatId: 'discord:abc',
      channel: 'discord',
      isAdmin: true,
      existingUserId: undefined,
      note: null,
    })
  })

  it('parses a WhatsApp jid with --user-id', () => {
    const r = parseAddUserArgs(['15551234567@s.whatsapp.net', '--user-id', 'u_abcd1234'])
    expect(r).toEqual({
      chatId: '15551234567@s.whatsapp.net',
      channel: 'whatsapp',
      isAdmin: false,
      existingUserId: 'u_abcd1234',
      note: null,
    })
  })

  it('parses a note', () => {
    const r = parseAddUserArgs(['12345', '--note', 'my', 'phone'])
    expect(r?.note).toBe('my phone')
  })

  it('returns null on unknown format', () => {
    expect(parseAddUserArgs(['notvalid'])).toBeNull()
  })

  it('returns null on missing args', () => {
    expect(parseAddUserArgs([])).toBeNull()
  })
})

describe('/adduser end-to-end', () => {
  it('creates a Discord user via the command flow', () => {
    const args = parseAddUserArgs(['discord:dx1', '--admin'])
    expect(args).not.toBeNull()
    addUserChat({
      chatId: args!.chatId,
      channel: args!.channel,
      isAdmin: args!.isAdmin,
      existingUserId: args!.existingUserId,
      note: args!.note ?? undefined,
      addedBy: 'admin',
    })
    expect(getUserByChat('discord:dx1')?.isAdmin).toBe(true)
  })

  it('links a second chat to an existing user', () => {
    const a = addUserChat({ chatId: '11111', channel: 'telegram' })
    const args = parseAddUserArgs(['discord:dx2', '--user-id', a.userId])
    expect(args).not.toBeNull()
    const r = addUserChat({
      chatId: args!.chatId,
      channel: args!.channel,
      existingUserId: args!.existingUserId,
      addedBy: 'admin',
    })
    expect(r.userId).toBe(a.userId)
    expect(r.created).toBe(false)
  })
})
```

- [ ] **Step 2: Implement `parseAddUserArgs` and rewire `/adduser`**

Replace `src/commands/users.ts` with the following body (preserves `/listusers` and `/removeuser`, adds `parseAddUserArgs`, expands `/adduser`):

```typescript
import type { Bot } from 'grammy'
import { isAdmin } from '../config.js'
import { listAllowedChats, removeAllowedChat } from '../db.js'
import { addUserChat } from '../users.js'
import { classifyChatId, type ChannelKind } from '../channel-router.js'

export interface ParsedAddUserArgs {
  chatId: string
  channel: ChannelKind
  isAdmin: boolean
  existingUserId: string | undefined
  note: string | null
}

export function parseAddUserArgs(args: string[]): ParsedAddUserArgs | null {
  if (args.length === 0) return null
  const chatId = args[0]!.trim()
  if (!chatId) return null
  const channel = classifyChatId(chatId)
  if (channel === 'unknown') return null

  let isAdminFlag = false
  let existingUserId: string | undefined
  let noteParts: string[] = []

  let i = 1
  while (i < args.length) {
    const t = args[i]!
    if (t === '--admin') {
      isAdminFlag = true
      i++
    } else if (t === '--user-id') {
      existingUserId = args[i + 1]
      if (!existingUserId) return null
      i += 2
    } else if (t === '--note') {
      noteParts = args.slice(i + 1)
      break
    } else {
      // unknown flag; reject to avoid silent typos
      return null
    }
  }

  return {
    chatId,
    channel,
    isAdmin: isAdminFlag,
    existingUserId,
    note: noteParts.length > 0 ? noteParts.join(' ') : null,
  }
}

export function registerUserCommands(bot: Bot): void {
  bot.command('listusers', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const rows = listAllowedChats()
    if (!rows.length) {
      await ctx.reply('No authorised chats yet (open mode).')
      return
    }
    const lines = rows.map((r) => {
      const added = new Date(r.added_at).toISOString().slice(0, 10)
      const seen = r.last_seen_at ? new Date(r.last_seen_at).toISOString().slice(0, 10) : 'never'
      const by = r.added_by ? ` by ${r.added_by}` : ''
      const note = r.note ? ` — ${r.note}` : ''
      const adminBadge = isAdmin(r.chat_id) ? ' [admin]' : ''
      return `• <code>${r.chat_id}</code>${adminBadge} (added ${added}${by}, seen ${seen})${note}`
    })
    await ctx.reply(`<b>Authorised chats (${rows.length})</b>\n${lines.join('\n')}`, {
      parse_mode: 'HTML',
    })
  })

  bot.command('adduser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const tokens = (ctx.message?.text ?? '').split(/\s+/).slice(1).filter(Boolean)
    const parsed = parseAddUserArgs(tokens)
    if (!parsed) {
      await ctx.reply(
        [
          'Usage:',
          '<code>/adduser &lt;chat_id&gt; [--admin] [--user-id u_xxxxxxxx] [--note &lt;text&gt;]</code>',
          '',
          'chat_id can be:',
          '• Telegram numeric (e.g. <code>123456789</code>)',
          '• Discord (e.g. <code>discord:110440505</code>)',
          '• WhatsApp JID (e.g. <code>15551234567@s.whatsapp.net</code>)',
        ].join('\n'),
        { parse_mode: 'HTML' },
      )
      return
    }

    try {
      const r = addUserChat({
        chatId: parsed.chatId,
        channel: parsed.channel,
        isAdmin: parsed.isAdmin || undefined,
        existingUserId: parsed.existingUserId,
        note: parsed.note ?? undefined,
        addedBy: chatId,
      })
      const verb = r.created ? 'created user' : 'linked to existing user'
      const adminBadge = parsed.isAdmin ? ' [admin]' : ''
      await ctx.reply(
        `Added ${parsed.chatId}${adminBadge} — ${verb} <code>${r.userId}</code>`,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      await ctx.reply(`Failed: ${(err as Error).message.slice(0, 200)}`)
    }
  })

  bot.command('removeuser', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAdmin(chatId)) {
      await ctx.reply('Admin only.')
      return
    }
    const targetId = (ctx.message?.text ?? '').split(/\s+/)[1]?.trim()
    if (!targetId || classifyChatId(targetId) === 'unknown') {
      await ctx.reply(
        'Usage: <code>/removeuser &lt;chat_id&gt;</code>\n\nAccepts Telegram numeric, Discord, or WhatsApp JID format.',
        { parse_mode: 'HTML' },
      )
      return
    }
    if (isAdmin(targetId)) {
      await ctx.reply('Cannot remove an admin chat. Demote first by editing the user record.')
      return
    }
    const r = removeAllowedChat(targetId)
    if (
      !r.removed &&
      r.memoriesDeleted === 0 &&
      !r.sessionCleared &&
      !r.preferencesCleared &&
      r.tasksDeleted === 0
    ) {
      await ctx.reply(`${targetId} was not in the list.`)
      return
    }
    const lines = [
      `Removed ${targetId}.`,
      `• memories deleted: ${r.memoriesDeleted}`,
      `• tasks deleted: ${r.tasksDeleted}`,
      `• session cleared: ${r.sessionCleared}`,
      `• preferences cleared: ${r.preferencesCleared}`,
    ]
    await ctx.reply(lines.join('\n'))
  })
}
```

The only structural changes from the previous file: `parseAddUserArgs` is exported, `/adduser` accepts cross-channel ids and flags, `/removeuser` no longer hard-rejects non-Telegram ids.

- [ ] **Step 3: Run the test**

Run: `npm run test -- adduser-command`
Expected: 8 tests pass.

- [ ] **Step 4: Run full suite**

Run: `npm run test`
Expected: green except possibly `chat-id-validation.test.ts` and `remove-chat.test.ts` — fixed in Task 10.

- [ ] **Step 5: Commit**

```bash
git add src/commands/users.ts tests/adduser-command.test.ts
git commit -m "feat(commands): /adduser cross-channel + --admin/--user-id/--note flags

Also relax /removeuser to accept any chat id format. /listusers
unchanged in shape, but now reads from user_chats via db.ts wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Update remaining tests

**Files:**
- Modify: `tests/chat-id-validation.test.ts`
- Modify: `tests/remove-chat.test.ts`

- [ ] **Step 1: Read both files**

Run: `cat tests/chat-id-validation.test.ts tests/remove-chat.test.ts`

- [ ] **Step 2: Adjust `chat-id-validation.test.ts`**

The test verifies `isValidTelegramChatId` and `addAllowedChat`'s Telegram-only guard. Both still exist (Telegram-only on the `addAllowedChat` wrapper is preserved). The test should still pass without changes. Run it:

Run: `npm run test -- chat-id-validation`
Expected: pass.

If it fails because `seedAllowedChatsFromEnv` was tested here too: remove that section. The function is gone.

- [ ] **Step 3: Adjust `remove-chat.test.ts`**

The test verifies `removeAllowedChat`'s effect on memories, tasks, sessions, prefs. All preserved by the wrapper. Should still pass.

The new behaviour — when the last chat is removed the user is also deleted — is not yet asserted. Append:

```typescript
import { addUserChat, getUserByChat } from '../src/users.js'
// ... within an existing describe block or a new one ...

describe('removeAllowedChat user-cascade', () => {
  it('deletes the user when its last chat is removed', () => {
    addUserChat({ chatId: '12345', channel: 'telegram' })
    expect(getUserByChat('12345')).not.toBeNull()
    removeAllowedChat('12345')
    expect(getUserByChat('12345')).toBeNull()
  })
})
```

- [ ] **Step 4: Run both tests**

Run: `npm run test -- chat-id-validation remove-chat`
Expected: green.

- [ ] **Step 5: Commit (only if changes)**

```bash
git add tests/chat-id-validation.test.ts tests/remove-chat.test.ts
git commit -m "test: adjust chat-id-validation and remove-chat for users.ts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Remove `seedAllowedChatsFromEnv` call from `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Find the call**

Run: `grep -n "seedAllowedChatsFromEnv" /root/claudeos-dev/src/index.ts`
Expected: one hit (line ~127) plus the import (line ~29).

- [ ] **Step 2: Remove import and call**

Delete the import line that includes `seedAllowedChatsFromEnv`. If it's part of a block import, remove just that name from the destructure.

Delete the line `const seeded = seedAllowedChatsFromEnv(ALLOWED_CHAT_IDS)` and any subsequent log line that references `seeded`. The migration handles all seeding now; runtime startup should not duplicate.

If `ALLOWED_CHAT_IDS` is no longer used in `index.ts` after this removal, also remove its import.

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck && npm run test`
Expected: no errors, all green.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor(index): remove seedAllowedChatsFromEnv call (handled by v8 migration)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Full verification

- [ ] **Step 1: Run the full check pipeline**

Run: `npm run check`
Expected: typecheck, lint, format:check, vitest all green.

If prettier flags any modified files, run `npx prettier --write <files>` and commit:

```bash
git add -u
git commit -m "style: prettier format

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Smoke-test on a fresh DB with seed data**

```bash
cat > smoke-tmp.ts <<'EOF'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'))
  const file = path.join(tmp, 'db.sqlite')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')

  // Seed an allowed_chats row before migrations run
  // (simulates upgrade from a v7 prod DB)
  // Note: tables don't exist yet; we have to run v1..v7 first
  const { runMigrations, MIGRATIONS } = await import('./src/migrations.js')
  const v7 = MIGRATIONS.findIndex(m => m.version === 7)
  const upTo7 = MIGRATIONS.slice(0, v7 + 1)
  const t = db.transaction(() => {
    for (const m of upTo7) m.up(db)
    db.pragma('user_version = 7')
  })
  t()
  db.prepare(
    "INSERT INTO allowed_chats (chat_id, added_at, added_by, note) VALUES (?, ?, ?, ?)"
  ).run('100200300', Date.now() - 1000, 'env', 'pre-existing')

  // Now run v8
  runMigrations(db)
  console.log('user_version =', db.pragma('user_version', { simple: true }))
  const users = db.prepare('SELECT user_id, display_name, is_admin FROM users').all()
  console.log('users:', JSON.stringify(users, null, 2))
  const chats = db.prepare('SELECT chat_id, user_id, channel FROM user_chats').all()
  console.log('user_chats:', JSON.stringify(chats, null, 2))

  fs.rmSync(tmp, { recursive: true, force: true })
}
main().catch(console.error)
EOF
npx tsx smoke-tmp.ts 2>&1 | grep -v "INFO\|WARN" | tail -20
rm -f smoke-tmp.ts
```

Expected output:
- `user_version = 8`
- `users:` array with one entry, `is_admin: 1` (bootstrap fallback fired because admin envs are empty in this smoke run)
- `user_chats:` one entry with `chat_id: '100200300'`, `channel: 'telegram'`

- [ ] **Step 3: Verify `runAgent` callsites unchanged from previous spec**

Run: `grep -rn "runAgent(" /root/claudeos-dev/src/ | grep -v "function runAgent\|export.*runAgent"`
Expected: exactly two — `chat-pipeline.ts` and `scheduler.ts`. Confirms this spec didn't accidentally touch the previous fix.

- [ ] **Step 4: Final commit if anything was fixed**

If steps 1-3 surfaced fixes:

```bash
git add -A
git commit -m "fix: issues found during final verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:**
- Schema migration v8 → Tasks 1, 4 ✔
- Data move from `allowed_chats` + env seeds + admin flags + bootstrap fallback → Task 4 ✔
- `src/users.ts` API → Task 2 ✔
- `parseChatId` / channel helpers → Task 3 (extends `channel-router.ts`) ✔
- `db.ts` wrappers preserve public API → Task 5 ✔
- `config.ts` wrappers + delete `*Of` → Task 6 ✔
- Test rewrites for removed `*Of` → Task 7 ✔
- Open-mode auto-add → Task 8 ✔
- `/adduser` cross-channel + flags → Task 9 ✔
- `/removeuser` accepts any format → Task 9 ✔
- `seedAllowedChatsFromEnv` removed → Task 11 ✔
- Existing test adjustments → Task 10 ✔

**Type consistency:**
- `AddUserChatOpts`/`AddUserChatResult`/`RemoveUserChatResult` defined in Task 2, consumed identically in Tasks 5, 8, 9.
- `ChannelKind` from `channel-router.ts` used uniformly.
- `parseAddUserArgs` returns `ParsedAddUserArgs | null` shape consistent in Task 9 test and command body.
- Migration v8's inline `generateUserId` matches the `users.ts` format (`u_` + 8 hex). They're independent implementations to avoid the cycle, but both produce the same shape — `tests/users-lookup.test.ts` and `tests/migration-v8.test.ts` both assert against this regex.

**Placeholder scan:** no "TBD"/"implement later"/"similar to Task N". All code blocks complete. The instruction in Task 10 Step 2 ("If it fails because seedAllowedChatsFromEnv was tested here too") is a defensive branch with concrete remediation, not a placeholder.
