# Quality-of-life fixes (block 3)

**Date:** 2026-04-25
**Status:** Approved

## Problem

Four small, independent operational gaps that surfaced in the deep audit:

1. **Init failures are invisible.** [src/index.ts:161-162](src/index.ts#L161-L162) launches `initWhatsApp()` and `initDiscord()` as fire-and-forget promises. If a channel fails to start (missing token, bad encryption key, network at boot), the catch logs an error and the process keeps running with a "successfully started" appearance. The operator has to read the logs to discover the channel is dead.

2. **No live-DB maintenance.** `VACUUM` only runs as part of `VACUUM INTO` for backups. The live SQLite file accumulates fragmentation after every cap/decay/summarize sweep. `ANALYZE` is never invoked, so query-planner statistics drift over time. Both are negligible for current bot scale, but the cost of fixing this is also negligible — and the absence is a real audit finding.

3. **Admin commands skip rate-limit.** Regular messages run through `tryConsume(chatId)` in `chat-pipeline.ts`, but admin commands (`/update`, `/backup`, `/adduser`, `/removeuser`, etc.) do not. A misbehaving keyboard, a script, or a compromised admin account can trigger `/update` repeatedly and snowball into deploy storms or disk thrashing.

4. **Crash notifications can flood admins.** `notifyAdminsOnCrash` in [src/index.ts:266](src/index.ts#L266) sends a Telegram message for every `uncaughtException` / `unhandledRejection`. A flapping bug (e.g. a tight loop emitting unhandled rejections) sends one message per occurrence — multiplied by the admin count.

## Goals

- Init failures get a single Telegram message to admins per init attempt, in addition to the existing log line.
- Weekly `VACUUM` + `ANALYZE` of the live DB, configurable via env, runs alongside the existing backup/decay schedules.
- Admin commands honour a separate rate-limit bucket — five tokens, refill 5/min — distinct from per-chat user-message rate-limit.
- Crash notifications dedup against a 5-minute in-memory window keyed on `(kind, stack-hash)`. Identical signature within the window is silently suppressed; a different signature still fires.

## Non-goals

- Changing how init *itself* works (no `process.exit` on channel failure, no retry-with-backoff). Telegram must keep working even when WhatsApp/Discord can't start.
- Persisting rate-limit or crash-dedup state across process restarts. After a restart, the first crash notifies — that's intentional.
- `incremental_vacuum` or table-by-table `ANALYZE`. The simple full-DB form is fine at our scale; revisit if the live DB ever exceeds tens of MB.
- Touching the `sanitizeFtsQuery` function. The audit flagged it for short Cyrillic tokens, but the live code already drops the floor to two characters with a comment explaining the rationale ([src/memory.ts:39-51](src/memory.ts#L39-L51)). Already fixed.

## Design

### 1. Init failure notifications

Wrap each fire-and-forget in a helper that logs **and** notifies admins:

```typescript
// src/index.ts (new helper near notifyAdminsOnCrash)
async function notifyAdminsOnInitFailure(channel: string, err: unknown): Promise<void> {
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
}
```

`shouldNotifyCrash` is reused from the dedup helper (point 4 below). This way, repeated reconnect-attempt failures within five minutes don't flood the admin chat.

The two call sites:

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

### 2. Maintenance schedule

New module `src/maintenance.ts`:

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
  // page_count * page_size = file size
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
  const tick = () => {
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

Config (`src/config.ts`):

```typescript
export const MAINTENANCE_ENABLED = (env['MAINTENANCE_ENABLED'] ?? '1').trim() !== '0'
export const MAINTENANCE_INTERVAL_HOURS = readPositiveInt('MAINTENANCE_INTERVAL_HOURS', 168)
```

`src/index.ts` startup, near `initBackupSchedule`:

```typescript
const maintenanceTimer = MAINTENANCE_ENABLED
  ? initMaintenanceSchedule(MAINTENANCE_INTERVAL_HOURS)
  : null
if (!MAINTENANCE_ENABLED) {
  logger.warn('MAINTENANCE_ENABLED=0 — VACUUM/ANALYZE disabled')
}
```

`shutdown` clears the timer.

### 3. Admin command rate-limit

Extend `src/rate-limit.ts`:

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

Reuses the same internal Map so memory pressure stays bounded by `RATE_LIMIT_MAX_TRACKED`. The `admin:` prefix ensures admin and user buckets stay distinct: a user pinging at the regular rate doesn't drain the admin bucket.

New shared guard `src/commands/_admin-guard.ts`:

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

Replace existing admin-command boilerplate. For each command that currently does:

```typescript
const chatId = String(ctx.chat?.id ?? '')
if (!isAdmin(chatId)) {
  await ctx.reply('Admin only.')
  return
}
// … work …
```

substitute:

```typescript
const guard = await adminGuard(ctx)
if (!guard.ok) return
const { chatId } = guard
// … work …
```

Files affected: `src/commands/users.ts` (3 commands: `/listusers`, `/adduser`, `/removeuser`), `src/commands/backup.ts` (`/backup`), `src/commands/update.ts` (`/update`), `src/commands/effort.ts` (admin-only paths), `src/commands/models.ts` (admin-only paths). Non-admin commands (`/status`, `/ping`, `/version`) remain unchanged.

### 4. Crash dedup

Add to `src/index.ts`, just above `notifyAdminsOnCrash`:

```typescript
const CRASH_DEDUP_WINDOW_MS = 5 * 60 * 1000
const CRASH_DEDUP_MAX_ENTRIES = 100
const recentCrashes = new Map<string, number>()

function crashSignature(kind: string, err: unknown): string {
  const stack = (err as Error)?.stack ?? String(err)
  return `${kind}::${stack.slice(0, 200)}`
}

function shouldNotifyCrash(kind: string, err: unknown): boolean {
  const sig = crashSignature(kind, err)
  const now = Date.now()
  const last = recentCrashes.get(sig)
  if (last !== undefined && now - last < CRASH_DEDUP_WINDOW_MS) return false
  recentCrashes.set(sig, now)
  if (recentCrashes.size > CRASH_DEDUP_MAX_ENTRIES) {
    const oldestKey = recentCrashes.keys().next().value
    if (oldestKey !== undefined) recentCrashes.delete(oldestKey)
  }
  return true
}
```

Use it as the first guard in `notifyAdminsOnCrash` and the new `notifyAdminsOnInitFailure`:

```typescript
const notifyAdminsOnCrash = async (err: unknown, kind: string) => {
  if (!shouldNotifyCrash(kind, err)) return
  // … existing send loop …
}
```

`recordCrash` keeps firing for every event so the metric counter stays accurate; only the user-facing notification is deduped.

For testability, export `shouldNotifyCrash` and `crashSignature` from a small helper module `src/crash-dedup.ts`:

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
  recentCrashes.set(sig, now)
  if (recentCrashes.size > CRASH_DEDUP_MAX_ENTRIES) {
    const oldestKey = recentCrashes.keys().next().value
    if (oldestKey !== undefined) recentCrashes.delete(oldestKey)
  }
  return true
}

// For tests:
export function resetCrashDedupForTest(): void {
  recentCrashes.clear()
}
```

`src/index.ts` imports from this module instead of declaring inline.

## Observability

- `maintenance complete` info log per VACUUM/ANALYZE run.
- Existing `recordCrash` continues firing on every event (counter accurate).
- No new metric events. Dedup-suppressions are not counted at this stage; if it ever matters, add a `crash_deduped` counter then.

## Testing

New test files:

1. **`tests/maintenance.test.ts`**
   - `runMaintenance()` on a fresh test DB with a few seeded `memories` rows. Assert positive `vacuumMs`, `analyzeMs`, and that `sizeBytes > 0`. Assert subsequent `INSERT` and `SELECT` continue to work (sanity that VACUUM didn't break the DB handle).

2. **`tests/admin-rate-limit.test.ts`**
   - `tryConsumeAdmin('chat-A')` × 5 → all five `ok: true`.
   - 6th call → `ok: false`, `retryAfterMs > 0`.
   - Different chatId (`chat-B`) → `ok: true` (separate bucket).
   - After advancing the bucket-clock past the refill window (use `cfg.now` injection), one more passes.

3. **`tests/crash-dedup.test.ts`**
   - Same `(kind, stack)` twice within window → second `shouldNotifyCrash` returns `false`.
   - Different `kind` with same stack → both `true`.
   - After `now` advances past the window → next call returns `true` again.
   - Cap behaviour: 101 distinct signatures → map size stays at 100, oldest evicted.

4. **`tests/init-failure-notify.test.ts`**
   - Mock `sendToChat` to record calls.
   - Simulate `initDiscord()` rejecting with `new Error('boom')` and the `notifyAdminsOnInitFailure` flow.
   - Assert each admin in `ADMIN_CHAT_IDS` received exactly one call with the expected message body.
   - Second identical reject within window → no additional `sendToChat` calls.

Existing tests unaffected: nothing in current suite calls `sendToChat` for crashes, so wiring `shouldNotifyCrash` into `notifyAdminsOnCrash` is invisible to them. Admin-command tests (Discord, WhatsApp, etc.) do not exercise the rate-limit, so the guard introduction is also transparent — they hit it once per test run, well within the burst.

## Rollout

Single PR. Two new env vars with safe defaults (`MAINTENANCE_ENABLED=1`, `MAINTENANCE_INTERVAL_HOURS=168`). No schema migration. Existing admin-command call sites get a one-line refactor; the visible behaviour change is "rate-limit message instead of nothing" for the unlikely 6th call within a minute.

After deploy:
- The `maintenance complete` log appears once, six hours after first start, and weekly thereafter.
- An operator who deliberately spams `/listusers` six times in a row will see the rate-limit message. Confirms the wiring.
- An operator who triggers a known crash twice will see one Telegram alert, not two. (Already covered by existing tests for the dedup helper.)

## Risks

- **Maintenance VACUUM on a future huge DB.** At our scale (single user, low-MB DB) `VACUUM` finishes in milliseconds. If we ever hit the multi-hundred-MB regime where VACUUM blocks for seconds, the maintenance run could overlap with an incoming message and the user feels a stutter. The fix at that point would be `incremental_vacuum`, but that's a problem for "later" — flagged in non-goals.
- **Crash dedup window pinning.** The 200-char stack prefix is a heuristic; two different bugs that share a top-level frame would dedup as one. Acceptable tradeoff: false negatives are noise reduction, not correctness loss. The full stack still goes to logs.
- **`adminGuard` consumes a token before checking the work succeeds.** If `/backup` fails after the rate-limit token was consumed, the user has lost a token without getting the result. Acceptable: 5 tokens/min on admin actions is a generous budget; partial failures rarely come in floods.
- **Inline `Map` for crash dedup grows unbounded if size cap is wrong.** Cap is 100 entries with eviction-on-overflow. Worst case: 100 distinct stack prefixes in the window, ~50 KB. Bounded.
