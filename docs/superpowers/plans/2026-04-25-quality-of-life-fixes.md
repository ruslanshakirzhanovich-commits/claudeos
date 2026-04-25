# QoL fixes (block 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four small operational gaps in one PR — admin-visible init-failure notifications, weekly VACUUM/ANALYZE on the live DB, dedicated rate-limit on admin commands via a shared `adminGuard`, and dedup of crash notifications against a 5-minute window.

**Architecture:** New small module `src/crash-dedup.ts` exposes `shouldNotifyCrash`, used by both the existing crash notifier and a new `notifyAdminsOnInitFailure` in `src/index.ts`. New `src/maintenance.ts` runs `VACUUM` + `ANALYZE` on a `setInterval`, wired in alongside `initBackupSchedule`. `src/rate-limit.ts` gains a `tryConsumeAdmin` helper (5 burst, 5/min sustained, namespaced by `admin:`); `src/commands/_admin-guard.ts` centralizes the `isAdmin` + rate-limit check that every admin command performs. Five admin command modules switch from inline boilerplate to the shared guard.

**Tech Stack:** TypeScript (strict), better-sqlite3 (VACUUM/ANALYZE), grammy (Telegram), vitest.

**Spec:** `docs/superpowers/specs/2026-04-25-quality-of-life-fixes-design.md`

---

## File Structure

**Create:**
- `src/crash-dedup.ts` — `shouldNotifyCrash`, `crashSignature`, `resetCrashDedupForTest`
- `src/maintenance.ts` — `runMaintenance`, `initMaintenanceSchedule`
- `src/commands/_admin-guard.ts` — `adminGuard(ctx)` helper
- `tests/crash-dedup.test.ts`
- `tests/maintenance.test.ts`
- `tests/admin-rate-limit.test.ts`
- `tests/init-failure-notify.test.ts`

**Modify:**
- `src/rate-limit.ts` — add `tryConsumeAdmin`
- `src/config.ts` — add `MAINTENANCE_ENABLED`, `MAINTENANCE_INTERVAL_HOURS`
- `src/index.ts` — `notifyAdminsOnCrash` uses `shouldNotifyCrash`; new `notifyAdminsOnInitFailure`; wire `initMaintenanceSchedule`; clear timer in shutdown
- `src/commands/users.ts` — three admin-command sites switch to `adminGuard`
- `src/commands/backup.ts` — switch to `adminGuard`
- `src/commands/update.ts` — two admin-command sites switch to `adminGuard`
- `src/commands/health.ts` — switch to `adminGuard`

---

## Task 1: `crash-dedup` module

**Files:**
- Create: `src/crash-dedup.ts`
- Create: `tests/crash-dedup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/crash-dedup.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  shouldNotifyCrash,
  crashSignature,
  resetCrashDedupForTest,
} from '../src/crash-dedup.js'

beforeEach(() => {
  resetCrashDedupForTest()
})

function err(msg: string, stack?: string): Error {
  const e = new Error(msg)
  if (stack) e.stack = stack
  return e
}

describe('crashSignature', () => {
  it('combines kind with the first 200 chars of stack', () => {
    const e = err('boom', 'Error: boom\n    at f1\n    at f2')
    const sig = crashSignature('uncaughtException', e)
    expect(sig.startsWith('uncaughtException::')).toBe(true)
    expect(sig).toContain('Error: boom')
    expect(sig.length).toBeLessThanOrEqual('uncaughtException::'.length + 200)
  })

  it('falls back to String(err) when no stack is present', () => {
    const sig = crashSignature('init', 'plain string error')
    expect(sig).toBe('init::plain string error')
  })
})

describe('shouldNotifyCrash', () => {
  it('returns true for the first occurrence of a signature', () => {
    expect(shouldNotifyCrash('uncaughtException', err('boom'))).toBe(true)
  })

  it('returns false for the same signature within the dedup window', () => {
    const e = err('boom')
    const t0 = 1_000_000
    expect(shouldNotifyCrash('uncaughtException', e, t0)).toBe(true)
    expect(shouldNotifyCrash('uncaughtException', e, t0 + 60_000)).toBe(false)
    expect(shouldNotifyCrash('uncaughtException', e, t0 + 4 * 60_000)).toBe(false)
  })

  it('returns true again once the window has passed', () => {
    const e = err('boom')
    const t0 = 1_000_000
    shouldNotifyCrash('uncaughtException', e, t0)
    // 5 minutes is the window; just past it should re-fire.
    expect(shouldNotifyCrash('uncaughtException', e, t0 + 5 * 60_000 + 1)).toBe(true)
  })

  it('different kinds with the same stack are not deduped together', () => {
    const e = err('boom')
    expect(shouldNotifyCrash('uncaughtException', e)).toBe(true)
    expect(shouldNotifyCrash('unhandledRejection', e)).toBe(true)
  })

  it('caps the dedup map at 100 entries (FIFO eviction)', () => {
    for (let i = 0; i < 105; i++) {
      shouldNotifyCrash('kind', err(`unique error ${i}`))
    }
    // The oldest (i=0..4) should have been evicted; their next call is a
    // fresh "first" → should return true again.
    expect(shouldNotifyCrash('kind', err('unique error 0'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- crash-dedup`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/crash-dedup.ts`:

```typescript
const CRASH_DEDUP_WINDOW_MS = 5 * 60 * 1000
const CRASH_DEDUP_MAX_ENTRIES = 100
const recentCrashes = new Map<string, number>()

export function crashSignature(kind: string, err: unknown): string {
  const stack = (err as Error)?.stack ?? String(err)
  return `${kind}::${stack.slice(0, 200)}`
}

export function shouldNotifyCrash(
  kind: string,
  err: unknown,
  now: number = Date.now(),
): boolean {
  const sig = crashSignature(kind, err)
  const last = recentCrashes.get(sig)
  if (last !== undefined && now - last < CRASH_DEDUP_WINDOW_MS) return false
  // Move-to-end on insertion: delete-then-set so JS Map's insertion-order
  // iteration acts as LRU for the eviction step below.
  recentCrashes.delete(sig)
  recentCrashes.set(sig, now)
  if (recentCrashes.size > CRASH_DEDUP_MAX_ENTRIES) {
    const oldestKey = recentCrashes.keys().next().value
    if (oldestKey !== undefined) recentCrashes.delete(oldestKey)
  }
  return true
}

export function resetCrashDedupForTest(): void {
  recentCrashes.clear()
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test -- crash-dedup`
Expected: 6 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/crash-dedup.ts tests/crash-dedup.test.ts
git commit -m "feat(crash): dedup helper for repeated crash notifications

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire crash dedup into existing notifier + add init-failure notifier

**Files:**
- Modify: `src/index.ts`
- Create: `tests/init-failure-notify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/init-failure-notify.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetCrashDedupForTest } from '../src/crash-dedup.js'

const sendSpy = vi.fn(async () => {})

vi.mock('../src/bot.js', () => ({
  sendToChat: (chatId: string, text: string) => sendSpy(chatId, text),
  // Other exports are not exercised by this test, leave undefined.
}))

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js')
  return { ...actual, ADMIN_CHAT_IDS: ['admin-1', 'admin-2'] }
})

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { notifyAdminsOnInitFailure } = await import('../src/init-notify.js')

beforeEach(() => {
  sendSpy.mockClear()
  resetCrashDedupForTest()
})

describe('notifyAdminsOnInitFailure', () => {
  it('sends a Telegram message to every admin on first failure', async () => {
    await notifyAdminsOnInitFailure('Discord', new Error('login dropped'))
    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(sendSpy.mock.calls[0]?.[0]).toBe('admin-1')
    expect(sendSpy.mock.calls[1]?.[0]).toBe('admin-2')
    expect(sendSpy.mock.calls[0]?.[1]).toContain('Discord init failed')
    expect(sendSpy.mock.calls[0]?.[1]).toContain('login dropped')
  })

  it('does not send a second time for the same channel + identical error within the dedup window', async () => {
    const e = new Error('same problem')
    await notifyAdminsOnInitFailure('WhatsApp', e)
    sendSpy.mockClear()
    await notifyAdminsOnInitFailure('WhatsApp', e)
    expect(sendSpy).toHaveBeenCalledTimes(0)
  })

  it('different channels with the same stack are not deduped together', async () => {
    const e = new Error('same problem')
    await notifyAdminsOnInitFailure('WhatsApp', e)
    sendSpy.mockClear()
    await notifyAdminsOnInitFailure('Discord', e)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })
})
```

The test imports from `src/init-notify.js`, a new small module created in Step 3 below. We extract `notifyAdminsOnInitFailure` (and re-export `notifyAdminsOnCrash`) so it's testable without booting `index.ts`'s top-level scope.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- init-failure-notify`
Expected: FAIL — `src/init-notify.js` not found.

- [ ] **Step 3: Extract notifier helpers into `src/init-notify.ts`**

Create `src/init-notify.ts`:

```typescript
import { ADMIN_CHAT_IDS } from './config.js'
import { sendToChat } from './bot.js'
import { logger } from './logger.js'
import { recordCrash } from './metrics.js'
import { shouldNotifyCrash } from './crash-dedup.js'

export async function notifyAdminsOnCrash(err: unknown, kind: string): Promise<void> {
  if (!shouldNotifyCrash(kind, err)) return
  const msg = (err as Error)?.stack ?? (err as Error)?.message ?? String(err)
  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await sendToChat(adminId, `⚠️ ${kind}\n\n<pre>${msg.slice(0, 3000)}</pre>`)
    } catch {
      /* alert is best-effort */
    }
  }
}

export async function notifyAdminsOnInitFailure(
  channel: string,
  err: unknown,
): Promise<void> {
  if (!shouldNotifyCrash(`init:${channel}`, err)) return
  const msg = (err as Error)?.message ?? String(err)
  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await sendToChat(
        adminId,
        `⚠️ ${channel} init failed\n\n<pre>${msg.slice(0, 1000)}</pre>\n\nBot is still running on Telegram. Logs have full stack.`,
      )
    } catch {
      /* best-effort */
    }
  }
  logger.error({ err, channel }, 'init failure notified to admins')
  recordCrash(`init:${channel}`, err)
}
```

- [ ] **Step 4: Re-route `src/index.ts` to use the extracted helpers**

In `src/index.ts`, find the existing `notifyAdminsOnCrash` arrow function (around line 266). Replace the inline definition and the two call sites:

Before:
```typescript
const notifyAdminsOnCrash = async (err: unknown, kind: string) => {
  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      const msg = (err as Error)?.stack ?? (err as Error)?.message ?? String(err)
      await sendToChat(adminId, `⚠️ ${kind}\n\n<pre>${msg.slice(0, 3000)}</pre>`)
    } catch {
      /* ignore — alert is best-effort */
    }
  }
}
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
  recordCrash('uncaughtException', err)
  void notifyAdminsOnCrash(err, 'uncaughtException')
})
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection')
  recordCrash('unhandledRejection', err)
  void notifyAdminsOnCrash(err, 'unhandledRejection')
})
```

After (delete the inline `notifyAdminsOnCrash` definition entirely, then):
```typescript
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
  recordCrash('uncaughtException', err)
  void notifyAdminsOnCrash(err, 'uncaughtException')
})
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection')
  recordCrash('unhandledRejection', err)
  void notifyAdminsOnCrash(err, 'unhandledRejection')
})
```

Add the import at the top of `src/index.ts` (group with other local imports):

```typescript
import { notifyAdminsOnCrash, notifyAdminsOnInitFailure } from './init-notify.js'
```

Update the two fire-and-forget catches (around lines 161-162):

Before:
```typescript
initWhatsApp().catch((err) => logger.error({ err }, 'WhatsApp init failed (continuing without)'))
initDiscord().catch((err) => logger.error({ err }, 'Discord init failed (continuing without)'))
```

After:
```typescript
initWhatsApp().catch(async (err) => {
  logger.error({ err }, 'WhatsApp init failed (continuing without)')
  await notifyAdminsOnInitFailure('WhatsApp', err)
})
initDiscord().catch(async (err) => {
  logger.error({ err }, 'Discord init failed (continuing without)')
  await notifyAdminsOnInitFailure('Discord', err)
})
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -- init-failure-notify`
Expected: 3 tests pass.

Run: `npm run test`
Expected: full suite green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/init-notify.ts src/index.ts tests/init-failure-notify.test.ts
git commit -m "feat(init): notify admins on Discord/WhatsApp init failure with dedup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Maintenance schedule (VACUUM + ANALYZE)

**Files:**
- Create: `src/maintenance.ts`
- Modify: `src/config.ts` — add two env vars
- Modify: `src/index.ts` — wire schedule, clear in shutdown
- Create: `tests/maintenance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/maintenance.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-maint-'))
const dbFile = path.join(tmpRoot, 'db.sqlite')

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js')
  return { ...actual, DB_PATH: dbFile, STORE_DIR: tmpRoot }
})

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { initDatabase, closeDb, getDb, insertMemories, countMemories } = await import('../src/db.js')
const { runMaintenance } = await import('../src/maintenance.js')

beforeAll(() => {
  initDatabase()
  // Seed enough rows that VACUUM has something to do.
  insertMemories([
    { chatId: 'c1', content: 'a', sector: 'episodic' },
    { chatId: 'c1', content: 'b', sector: 'episodic' },
    { chatId: 'c1', content: 'c', sector: 'semantic' },
  ])
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('runMaintenance', () => {
  it('runs VACUUM and ANALYZE without breaking the DB', () => {
    const before = countMemories('c1')
    expect(before).toBe(3)

    const r = runMaintenance()
    expect(r.vacuumMs).toBeGreaterThanOrEqual(0)
    expect(r.analyzeMs).toBeGreaterThanOrEqual(0)
    expect(r.sizeBytes).toBeGreaterThan(0)

    // DB still works after VACUUM
    const after = countMemories('c1')
    expect(after).toBe(3)

    // Inserts after maintenance still work
    insertMemories([{ chatId: 'c1', content: 'd', sector: 'episodic' }])
    expect(countMemories('c1')).toBe(4)
  })

  it('reports a non-trivial sizeBytes derived from page_count * page_size', () => {
    const r = runMaintenance()
    const db = getDb()
    const pc = db.pragma('page_count', { simple: true }) as number
    const ps = db.pragma('page_size', { simple: true }) as number
    expect(r.sizeBytes).toBe(pc * ps)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- maintenance`
Expected: FAIL — `src/maintenance.ts` not found.

- [ ] **Step 3: Implement `src/maintenance.ts`**

Create `src/maintenance.ts`:

```typescript
import { getDb } from './db.js'
import { logger } from './logger.js'

export interface MaintenanceResult {
  vacuumMs: number
  analyzeMs: number
  sizeBytes: number
}

export function runMaintenance(): MaintenanceResult {
  const db = getDb()
  const t0 = Date.now()
  db.exec('VACUUM')
  const vacuumMs = Date.now() - t0
  const t1 = Date.now()
  db.exec('ANALYZE')
  const analyzeMs = Date.now() - t1
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0
  const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 0
  const sizeBytes = pageCount * pageSize
  logger.info({ vacuumMs, analyzeMs, sizeBytes }, 'maintenance complete')
  return { vacuumMs, analyzeMs, sizeBytes }
}

export function initMaintenanceSchedule(intervalHours: number): NodeJS.Timeout {
  const intervalMs = intervalHours * 60 * 60 * 1000
  // Stagger the first run six hours after boot so it doesn't collide with
  // the 30-second-after-boot backup or the 24-hour decay sweep.
  const initialDelayMs = 6 * 60 * 60 * 1000
  const tick = (): void => {
    try {
      runMaintenance()
    } catch (err) {
      logger.error({ err }, 'maintenance failed')
    }
  }
  setTimeout(tick, initialDelayMs)
  return setInterval(tick, intervalMs)
}
```

- [ ] **Step 4: Add config entries**

In `src/config.ts`, near the other interval-driven flags (next to `BACKUP_*`), add:

```typescript
export const MAINTENANCE_ENABLED = (env['MAINTENANCE_ENABLED'] ?? '1').trim() !== '0'
export const MAINTENANCE_INTERVAL_HOURS = readPositiveInt('MAINTENANCE_INTERVAL_HOURS', 168)
```

- [ ] **Step 5: Wire into `src/index.ts`**

Add to the imports:

```typescript
import { MAINTENANCE_ENABLED, MAINTENANCE_INTERVAL_HOURS } from './config.js'
import { initMaintenanceSchedule } from './maintenance.js'
```

(If `MAINTENANCE_*` are picked up via the existing block-import from `./config.js`, just add them to that destructure.)

After the `initBackupSchedule` block:

```typescript
const maintenanceTimer = MAINTENANCE_ENABLED
  ? initMaintenanceSchedule(MAINTENANCE_INTERVAL_HOURS)
  : null
if (!MAINTENANCE_ENABLED) {
  logger.warn('MAINTENANCE_ENABLED=0 — VACUUM/ANALYZE disabled')
}
```

In the `shutdown` function, alongside `clearInterval(backupTimer)`:

```typescript
if (maintenanceTimer) clearInterval(maintenanceTimer)
```

- [ ] **Step 6: Run tests**

Run: `npm run test -- maintenance`
Expected: 2 tests pass.

Run: `npm run test`
Expected: full suite green.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/maintenance.ts src/config.ts src/index.ts tests/maintenance.test.ts
git commit -m "feat(maintenance): weekly VACUUM + ANALYZE on the live DB

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `tryConsumeAdmin` rate-limit helper

**Files:**
- Modify: `src/rate-limit.ts`
- Create: `tests/admin-rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/admin-rate-limit.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { tryConsumeAdmin, resetRateLimitForTest } from '../src/rate-limit.js'

beforeEach(() => {
  resetRateLimitForTest()
})

describe('tryConsumeAdmin', () => {
  it('grants the first five tokens to a single admin chat', () => {
    for (let i = 0; i < 5; i++) {
      const r = tryConsumeAdmin('admin-A')
      expect(r.ok).toBe(true)
    }
  })

  it('rejects the sixth call within the burst', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('admin-A')
    const r = tryConsumeAdmin('admin-A')
    expect(r.ok).toBe(false)
    expect(r.retryAfterMs).toBeGreaterThan(0)
  })

  it('uses a separate bucket per chatId', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('admin-A')
    const r = tryConsumeAdmin('admin-B')
    expect(r.ok).toBe(true)
  })

  it('admin bucket is independent of the user-message bucket for the same chatId', () => {
    // The admin and user buckets are namespaced separately. Using the user
    // bucket should not consume admin tokens.
    for (let i = 0; i < 5; i++) tryConsumeAdmin('shared-chat')
    // Admin bucket exhausted; user bucket is untouched.
    const userBucket = (
      await import('../src/rate-limit.js')
    ).rateLimitBucketsForTest()
    expect(userBucket.has('admin:shared-chat')).toBe(true)
    expect(userBucket.has('shared-chat')).toBe(false)
  })
})
```

Note: the fourth test uses an inline dynamic import inside an arrow expression — flatten it to a plain top-level import for clarity:

Replace the fourth test body with:

```typescript
  it('admin bucket is independent of the user-message bucket for the same chatId', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('shared-chat')
    expect(buckets.has('admin:shared-chat')).toBe(true)
    expect(buckets.has('shared-chat')).toBe(false)
  })
```

and add a top-level binding inside the file:

```typescript
import { rateLimitBucketsForTest } from '../src/rate-limit.js'
const buckets = rateLimitBucketsForTest()
```

The complete test file is therefore:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  tryConsumeAdmin,
  resetRateLimitForTest,
  rateLimitBucketsForTest,
} from '../src/rate-limit.js'

const buckets = rateLimitBucketsForTest()

beforeEach(() => {
  resetRateLimitForTest()
})

describe('tryConsumeAdmin', () => {
  it('grants the first five tokens to a single admin chat', () => {
    for (let i = 0; i < 5; i++) {
      const r = tryConsumeAdmin('admin-A')
      expect(r.ok).toBe(true)
    }
  })

  it('rejects the sixth call within the burst', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('admin-A')
    const r = tryConsumeAdmin('admin-A')
    expect(r.ok).toBe(false)
    expect(r.retryAfterMs).toBeGreaterThan(0)
  })

  it('uses a separate bucket per chatId', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('admin-A')
    const r = tryConsumeAdmin('admin-B')
    expect(r.ok).toBe(true)
  })

  it('admin bucket is independent of the user-message bucket for the same chatId', () => {
    for (let i = 0; i < 5; i++) tryConsumeAdmin('shared-chat')
    expect(buckets.has('admin:shared-chat')).toBe(true)
    expect(buckets.has('shared-chat')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- admin-rate-limit`
Expected: FAIL — `tryConsumeAdmin` not exported.

- [ ] **Step 3: Implement `tryConsumeAdmin`**

In `src/rate-limit.ts`, append at the end of the file:

```typescript
const ADMIN_LIMIT_CAPACITY = 5
const ADMIN_LIMIT_REFILL_PER_MS = 5 / 60_000

export function tryConsumeAdmin(chatId: string): RateLimitDecision {
  return tryConsume(`admin:${chatId}`, {
    capacity: ADMIN_LIMIT_CAPACITY,
    refillPerMs: ADMIN_LIMIT_REFILL_PER_MS,
    maxTracked: 1000,
  })
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test -- admin-rate-limit`
Expected: 4 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/rate-limit.ts tests/admin-rate-limit.test.ts
git commit -m "feat(rate-limit): tryConsumeAdmin with separate bucket (5 burst, 5/min)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `adminGuard` helper + apply across admin commands

**Files:**
- Create: `src/commands/_admin-guard.ts`
- Modify: `src/commands/users.ts`, `src/commands/backup.ts`, `src/commands/update.ts`, `src/commands/health.ts`

- [ ] **Step 1: Implement `adminGuard`**

Create `src/commands/_admin-guard.ts`:

```typescript
import type { Context } from 'grammy'
import { isAdmin } from '../config.js'
import { tryConsumeAdmin, rateLimitMessage } from '../rate-limit.js'

export interface AdminGuardOk {
  ok: true
  chatId: string
}
export interface AdminGuardDenied {
  ok: false
}

export async function adminGuard(ctx: Context): Promise<AdminGuardOk | AdminGuardDenied> {
  const chatId = String(ctx.chat?.id ?? '')
  if (!isAdmin(chatId)) {
    await ctx.reply('Admin only.').catch(() => {})
    return { ok: false }
  }
  const rl = tryConsumeAdmin(chatId)
  if (!rl.ok) {
    await ctx.reply(rateLimitMessage(rl.retryAfterMs)).catch(() => {})
    return { ok: false }
  }
  return { ok: true, chatId }
}
```

- [ ] **Step 2: Apply to `src/commands/users.ts`**

Open `src/commands/users.ts`. Three command handlers (`/listusers`, `/adduser`, `/removeuser`) each start with:

```typescript
const chatId = String(ctx.chat?.id ?? '')
if (!isAdmin(chatId)) {
  await ctx.reply('Admin only.')
  return
}
```

Replace each with:

```typescript
const guard = await adminGuard(ctx)
if (!guard.ok) return
const { chatId } = guard
```

Add the import at the top:

```typescript
import { adminGuard } from './_admin-guard.js'
```

The original `isAdmin` import from `../config.js` stays — it's still used inside `/listusers` for the admin-badge labelling and inside `/removeuser` for the "cannot remove an admin" branch.

- [ ] **Step 3: Apply to `src/commands/backup.ts`**

Open `src/commands/backup.ts`. The single `/backup` handler starts with the same pattern. Apply the same replacement.

Add the import:

```typescript
import { adminGuard } from './_admin-guard.js'
```

The `isAdmin` import is no longer needed in this file once the inline check is gone — remove it from the import line.

- [ ] **Step 4: Apply to `src/commands/update.ts`**

Open `src/commands/update.ts`. Two admin-gated handlers (around lines 111 and 167) have the boilerplate. Apply the replacement to both.

Add the import:

```typescript
import { adminGuard } from './_admin-guard.js'
```

If `isAdmin` is no longer referenced after replacement, drop it from the import. Verify with `grep -n "isAdmin" /root/claudeos-dev/src/commands/update.ts` after the edit; if no hits remain, remove the import.

- [ ] **Step 5: Apply to `src/commands/health.ts`**

Open `src/commands/health.ts`. Single handler. Apply the replacement, add the import. Drop `isAdmin` if unused after the edit.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test`
Expected: all green. Existing command tests don't exercise the rate-limit (one call per test, well within the 5-burst), so they remain transparent to this change.

- [ ] **Step 7: Spot-check that `/status` is still NOT guarded**

Run: `grep -n "adminGuard\|isAdmin" /root/claudeos-dev/src/commands/status.ts`
Expected: only the existing `isAdmin(chatId)` line that detects role for display purposes — no `adminGuard` call. `/status` is intentionally for any authorised user, not just admins.

- [ ] **Step 8: Commit**

```bash
git add src/commands/_admin-guard.ts src/commands/users.ts src/commands/backup.ts src/commands/update.ts src/commands/health.ts
git commit -m "feat(commands): admin guard with shared rate-limit across admin commands

Replaces the inline 'if (!isAdmin) reply Admin only; return' boilerplate
in /listusers, /adduser, /removeuser, /backup, /update, /health with a
shared adminGuard that also consumes from a per-admin bucket
(5 burst, 5/min). /status remains open to any authorised user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the full check pipeline**

Run: `npm run check`
Expected: typecheck, lint, format:check, vitest all green.

If prettier flags any modified file, run `npx prettier --write <files>` and commit:

```bash
git add -u
git commit -m "style: prettier format

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Smoke-test maintenance on a scratch DB**

```bash
cat > smoke-tmp.ts <<'EOF'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-maint-smoke-'))
  process.env.DB_PATH = path.join(tmp, 'db.sqlite')
  process.env.STORE_DIR = tmp
  // Use config defaults; we just want VACUUM/ANALYZE to run.
  const { initDatabase, getDb } = await import('./src/db.js')
  const { runMaintenance } = await import('./src/maintenance.js')
  initDatabase()
  // Seed and immediately delete some rows so VACUUM has fragmentation to clean.
  const db = getDb()
  for (let i = 0; i < 100; i++) {
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at)
       VALUES (?, ?, 'episodic', ?, ?)`,
    ).run('smoke', `row ${i}`, Date.now(), Date.now())
  }
  db.exec('DELETE FROM memories')
  const before = (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number)
  const r = runMaintenance()
  console.log('before bytes:', before, 'after bytes:', r.sizeBytes, 'vacuumMs:', r.vacuumMs)
  fs.rmSync(tmp, { recursive: true, force: true })
}
main().catch(console.error)
EOF
npx tsx smoke-tmp.ts 2>&1 | grep -E "before bytes|vacuumMs" | tail -3
rm -f smoke-tmp.ts
```

Expected: a single line showing `before bytes: ...`, with `after bytes` smaller than or equal to `before bytes`, and `vacuumMs` a small positive number.

- [ ] **Step 3: Spot-check `/status` and other open commands not gated**

Run: `grep -rn "adminGuard" /root/claudeos-dev/src/commands/`
Expected: hits only in `_admin-guard.ts`, `users.ts`, `backup.ts`, `update.ts`, `health.ts`. NOT in `status.ts`, `version.ts`, `voice.ts`, `effort.ts`, `models.ts`, `stats.ts`.

`effort.ts` and `models.ts` — verify whether they have admin-gated branches that should also use `adminGuard`. Run:

```bash
grep -n "isAdmin(chatId)" /root/claudeos-dev/src/commands/effort.ts /root/claudeos-dev/src/commands/models.ts
```

If there's an `if (!isAdmin(chatId)) { reply 'Admin only'; return }` block in either, apply the same replacement and re-commit:

```bash
git add src/commands/effort.ts src/commands/models.ts
git commit -m "feat(commands): apply admin guard to effort/models admin paths

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If those files only use `isAdmin` for non-gating purposes (like permission-mode selection inside an otherwise-open command), leave them alone.

- [ ] **Step 4: Verify dedup on real-world flow**

Run a quick test that simulates two identical crashes back-to-back:

```bash
cat > smoke-dedup.ts <<'EOF'
import { shouldNotifyCrash, resetCrashDedupForTest } from './src/crash-dedup.js'
resetCrashDedupForTest()
const e = new Error('test crash')
console.log('first:', shouldNotifyCrash('uncaughtException', e))
console.log('second:', shouldNotifyCrash('uncaughtException', e))
console.log('different kind:', shouldNotifyCrash('unhandledRejection', e))
EOF
npx tsx smoke-dedup.ts 2>&1 | tail -5
rm -f smoke-dedup.ts
```

Expected:
- `first: true`
- `second: false`
- `different kind: true`

- [ ] **Step 5: Final commit if anything was fixed**

If any verification step required code changes:

```bash
git add -A
git commit -m "fix: issues found during final verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Otherwise no commit.

---

## Self-Review Notes

**Spec coverage:**
- Init failure notify → Tasks 1, 2 ✔
- Weekly maintenance VACUUM/ANALYZE → Task 3 ✔
- Admin command rate-limit → Tasks 4, 5 ✔
- Crash dedup → Task 1 (helper), Task 2 (wired into existing notifier) ✔
- `sanitizeFtsQuery` is correctly out of scope (already fixed) ✔

**Type consistency:**
- `shouldNotifyCrash(kind, err, now?)` consistent across Tasks 1, 2.
- `MaintenanceResult` shape consistent across Task 3 implementation and test.
- `tryConsumeAdmin(chatId)` returns `RateLimitDecision`, the same type used by the existing `tryConsume` — Tasks 4, 5 reference it identically.
- `AdminGuardOk` / `AdminGuardDenied` shape consistent in Task 5 and the helper definition.

**Placeholder scan:** no "TBD"/"implement later"/"similar to Task N". The mid-step decisions in Task 5 ("If `isAdmin` is no longer referenced after replacement, drop it") are concrete branches with verification commands, not placeholders. Task 6 Step 3's `effort.ts`/`models.ts` follow-up is similarly conditional with an explicit grep check.
