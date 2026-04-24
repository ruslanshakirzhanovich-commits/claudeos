# Scheduler catch-up and summarize timeout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two background subsystems fail loudly instead of silently: surface missed cron ticks across process downtime and bound `summarizeViaAgentSdk` with a timeout so a stuck SDK call can't stall the daily consolidation sweep.

**Architecture:** Add migration v7 extending `scheduled_tasks` with `missed_runs` and `last_missed_at`. Extend `updateTaskAfterRun` signature to carry a missed delta and return `info.changes`. In `runDueTasks`, compute missed ticks from `cronParser` iterated between `last_run ?? created_at` and `now`, capped at 50 iterations. Emit new `scheduler_missed` and `scheduler_hang` events and surface the counters in `/status`. Wrap the SDK stream in `summarizeViaAgentSdk` with an `AbortController` fed by a 120s timer (configurable via `SUMMARIZE_TIMEOUT_MS`), using the same pattern already proven in `agent.ts`.

**Tech Stack:** TypeScript (strict), better-sqlite3 + FTS5, vitest, grammy (Telegram), claude-agent-sdk, cron-parser 4.x, pino logger.

**Spec:** `docs/superpowers/specs/2026-04-24-scheduler-catchup-summarize-timeout-design.md`

---

## File Structure

**Modify:**
- `src/config.ts` — add `SUMMARIZE_TIMEOUT_MS` (positive-int env parse)
- `src/metrics.ts` — extend `EventKind` union + totals/recent arrays with `scheduler_missed`, `scheduler_hang`
- `src/migrations.ts` — append migration v7
- `src/db.ts` — update `ScheduledTask` interface; rewrite `updateTaskAfterRun` signature and body to carry missed delta and return `info.changes`; add `countMissedRuns()` helper for `/status`
- `src/scheduler.ts` — `runDueTasks` computes missed, logs + records event, updates state via new signature, skips user-facing sends when task is gone; `nonOverlapping` tracks consecutive-skip counter and emits hang event at `{3,10,30,100}`
- `src/memory-summarize.ts` — wrap SDK stream with AbortController + timer
- `src/commands/status.ts` — if any task has `missed_runs > 0`, append a summary line
- `tests/scheduler-failures.test.ts` — update the `updateTaskAfterRun` mock to accept the new parameters (no semantic change; prevents the existing suite from breaking)

**Create:**
- `tests/scheduler-catch-up.test.ts`
- `tests/scheduler-task-disappeared.test.ts`
- `tests/scheduler-hang.test.ts`
- `tests/memory-summarize-timeout.test.ts`
- `tests/migrations-idempotent.test.ts`

All test files follow the project's existing vitest pattern: `vi.mock` calls at top-level **before** `await import`, mock the SDK and logger, seed via exported DB helpers, clean up in `beforeEach`/`afterAll`.

---

## Task 1: Add `SUMMARIZE_TIMEOUT_MS` config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the export near the other memory-summarize config**

Open `src/config.ts`. After the line `export const MEMORY_SUMMARIZE_MIN_BATCH = readPositiveInt('MEMORY_SUMMARIZE_MIN_BATCH', 10)` (around line 139), add:

```typescript
// Hard ceiling on how long one summarizeViaAgentSdk call may run. If the
// stream never produces a result event within this window, we abort —
// protects the 24-hour consolidation sweep from stalling on a single hung
// chat. Mirrors AGENT_STREAM_TIMEOUT_MS for the main agent path.
export const SUMMARIZE_TIMEOUT_MS = readPositiveInt('SUMMARIZE_TIMEOUT_MS', 120_000)
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): SUMMARIZE_TIMEOUT_MS for agent-sdk summarize calls"
```

---

## Task 2: Extend `EventKind` with `scheduler_missed` and `scheduler_hang`

**Files:**
- Modify: `src/metrics.ts`

- [ ] **Step 1: Add the two new event kinds to the union and the backing records**

In `src/metrics.ts`, replace the current `type EventKind` and the `totals` / `recent` initializations (lines 3-27) with:

```typescript
type EventKind =
  | 'agent_success'
  | 'agent_error'
  | 'scheduler_skip'
  | 'scheduler_run'
  | 'scheduler_missed'
  | 'scheduler_hang'
  | 'backup_ok'
  | 'backup_fail'

const totals: Record<EventKind, number> = {
  agent_success: 0,
  agent_error: 0,
  scheduler_skip: 0,
  scheduler_run: 0,
  scheduler_missed: 0,
  scheduler_hang: 0,
  backup_ok: 0,
  backup_fail: 0,
}

const recent: Record<EventKind, number[]> = {
  agent_success: [],
  agent_error: [],
  scheduler_skip: [],
  scheduler_run: [],
  scheduler_missed: [],
  scheduler_hang: [],
  backup_ok: [],
  backup_fail: [],
}
```

No other changes in this file. `recordEvent` and `snapshot` already iterate over the `EventKind` keys, so they pick up the new entries automatically.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors. (Existing code does not currently call `recordEvent` with the new kinds — that happens in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add src/metrics.ts
git commit -m "feat(metrics): add scheduler_missed and scheduler_hang event kinds"
```

---

## Task 3: Migration v7 — `missed_runs` and `last_missed_at` columns

**Files:**
- Modify: `src/migrations.ts`
- Test: none yet — Task 10 (migrations idempotency) covers this migration's double-apply safety.

- [ ] **Step 1: Append migration v7 to the `MIGRATIONS` array**

In `src/migrations.ts`, inside the `MIGRATIONS` array, append **after** the `version: 6` entry and **before** the closing `]` (around line 161):

```typescript
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
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-run the migration on a scratch DB**

Run:
```bash
rm -f /tmp/cc-migrate-smoke.db
node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/cc-migrate-smoke.db');
  db.pragma('journal_mode = WAL');
  const { runMigrations } = require('./dist/migrations.js');
  // build first
" 2>&1 || true
npm run build
node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/cc-migrate-smoke.db');
  db.pragma('journal_mode = WAL');
  const { runMigrations } = require('./dist/migrations.js');
  runMigrations(db);
  const info = db.prepare('PRAGMA table_info(scheduled_tasks)').all();
  console.log(info.map(c => c.name).sort().join(','));
  console.log('user_version =', db.pragma('user_version', { simple: true }));
"
rm -f /tmp/cc-migrate-smoke.db
```
Expected: output line contains `last_missed_at,missed_runs` among the column names; `user_version = 7`.

- [ ] **Step 4: Commit**

```bash
git add src/migrations.ts
git commit -m "feat(migrations): v7 adds scheduled_tasks.missed_runs and last_missed_at"
```

---

## Task 4: Update `ScheduledTask` type and `updateTaskAfterRun` signature

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Extend the `ScheduledTask` interface**

In `src/db.ts`, replace the `ScheduledTask` interface (around lines 711-721) with:

```typescript
export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
  missed_runs: number
  last_missed_at: number | null
}
```

- [ ] **Step 2: Rewrite `updateTaskAfterRun` to carry missed delta and return `changes`**

Replace the existing `updateTaskAfterRun` function (around lines 759-767) with:

```typescript
export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
  missedDelta: number,
  lastMissedAt: number | null,
): number {
  const info = getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?,
           last_result = ?,
           next_run = ?,
           missed_runs = missed_runs + ?,
           last_missed_at = COALESCE(?, last_missed_at)
       WHERE id = ?`,
    )
    .run(Date.now(), result.slice(0, 500), nextRun, missedDelta, lastMissedAt, id)
  return Number(info.changes)
}
```

Two notes for the implementer:
- `COALESCE(?, last_missed_at)` keeps the old value when `lastMissedAt` is `null` — a run with `missed=0` must not clobber a previous `last_missed_at` stamp.
- `info.changes` is `number | bigint` in recent better-sqlite3 releases; the `Number(...)` wrap is the same defensive coercion already used elsewhere in this file (see `replaceEpisodicWithSummary`).

- [ ] **Step 3: Add `countMissedRuns` helper**

Append a new export below `deleteTask` (after line 775):

```typescript
export interface MissedRunsSummary {
  totalMissed: number
  tasksWithMisses: number
  mostRecent: { id: string; at: number } | null
}

export function countMissedRuns(): MissedRunsSummary {
  const totals = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(missed_runs), 0) AS total,
         SUM(CASE WHEN missed_runs > 0 THEN 1 ELSE 0 END) AS tasks
       FROM scheduled_tasks`,
    )
    .get() as { total: number; tasks: number }
  const recent = getDb()
    .prepare(
      `SELECT id, last_missed_at AS at
       FROM scheduled_tasks
       WHERE last_missed_at IS NOT NULL
       ORDER BY last_missed_at DESC
       LIMIT 1`,
    )
    .get() as { id: string; at: number } | undefined
  return {
    totalMissed: Number(totals.total ?? 0),
    tasksWithMisses: Number(totals.tasks ?? 0),
    mostRecent: recent ? { id: recent.id, at: Number(recent.at) } : null,
  }
}
```

- [ ] **Step 4: Update existing callers of `updateTaskAfterRun`**

Search for call sites:

Run: `grep -n "updateTaskAfterRun" src/ tests/`
Expected: hits in `src/scheduler.ts:75`, `src/scheduler.ts:86`, `tests/scheduler-failures.test.ts:20-22`.

In `tests/scheduler-failures.test.ts`, update the mock (around lines 20-22) to:

```typescript
  updateTaskAfterRun: (
    id: string,
    nextRun: number,
    result: string,
    _missedDelta: number,
    _lastMissedAt: number | null,
  ) => {
    updateSpy(id, nextRun, result)
    return 1
  },
```

The existing assertions on `updateSpy` keep working because we still forward the first three args.

Leave `src/scheduler.ts` call sites compiling-broken for now — they are rewritten in Task 5.

- [ ] **Step 5: Temporarily stub the scheduler call sites so the tree compiles**

In `src/scheduler.ts`, find the two calls `updateTaskAfterRun(task.id, nextRun, result)` / `updateTaskAfterRun(task.id, nextRun, \`ERROR: ${msg}\`)` (around lines 75 and 86) and update them minimally to match the new signature:

```typescript
      updateTaskAfterRun(task.id, nextRun, result, 0, null)
```

and

```typescript
        updateTaskAfterRun(task.id, nextRun, `ERROR: ${msg}`, 0, null)
```

This is a throwaway shim — Task 5 replaces it with the real catch-up logic. Its purpose is to keep `npm run typecheck` and the existing tests green between commits.

- [ ] **Step 6: Verify typecheck and existing tests still pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test -- scheduler-failures`
Expected: all existing scheduler-failures tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/scheduler.ts tests/scheduler-failures.test.ts
git commit -m "feat(db): extend ScheduledTask and updateTaskAfterRun with missed-run tracking"
```

---

## Task 5: Scheduler catch-up math, missed-ticks recording, task-disappeared handling

**Files:**
- Modify: `src/scheduler.ts`
- Create: `tests/scheduler-catch-up.test.ts`
- Create: `tests/scheduler-task-disappeared.test.ts`

- [ ] **Step 1: Write the failing catch-up test**

Create `tests/scheduler-catch-up.test.ts`:

```typescript
import { beforeEach, describe, it, expect, vi } from 'vitest'

const mockTasks: Array<{
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
  missed_runs: number
  last_missed_at: number | null
}> = []

const updateSpy = vi.fn()
const runAgentSpy = vi.fn()
const recordEventSpy = vi.fn()
const warnSpy = vi.fn()

vi.mock('../src/db.js', () => ({
  getDueTasks: () => [...mockTasks],
  updateTaskAfterRun: (
    id: string,
    nextRun: number,
    result: string,
    missedDelta: number,
    lastMissedAt: number | null,
  ) => {
    updateSpy(id, nextRun, result, missedDelta, lastMissedAt)
    return 1
  },
  createTask: () => {},
}))

vi.mock('../src/agent.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}))

vi.mock('../src/metrics.js', () => ({
  recordEvent: (kind: string, payload?: unknown) => recordEventSpy(kind, payload),
}))

vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    debug: () => {},
  },
}))

const { runDueTasks } = await import('../src/scheduler.js')

const DAY_MS = 24 * 60 * 60 * 1000

function makeTask(overrides: Partial<(typeof mockTasks)[number]> = {}): (typeof mockTasks)[number] {
  const now = Date.now()
  return {
    id: 't',
    chat_id: '42',
    prompt: 'do a thing',
    schedule: '0 9 * * *',
    next_run: now - 1000,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: now - DAY_MS,
    missed_runs: 0,
    last_missed_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  mockTasks.length = 0
  updateSpy.mockClear()
  runAgentSpy.mockReset()
  recordEventSpy.mockClear()
  warnSpy.mockClear()
})

describe('runDueTasks catch-up', () => {
  it('records missed=0 for a task running on schedule', async () => {
    const now = Date.now()
    const oneHourAgo = now - 60 * 60 * 1000
    mockTasks.push(
      makeTask({
        id: 't-ok',
        schedule: '*/30 * * * *',
        last_run: oneHourAgo,
      }),
    )
    runAgentSpy.mockResolvedValue({ text: 'ok' })

    await runDueTasks(async () => {})

    expect(updateSpy).toHaveBeenCalledTimes(1)
    // Only 1 tick (the current one) falls in the window, so missed = 0.
    const [, , , missedDelta, lastMissedAt] = updateSpy.mock.calls[0]!
    expect(missedDelta).toBe(0)
    expect(lastMissedAt).toBeNull()
    expect(recordEventSpy).not.toHaveBeenCalledWith('scheduler_missed', expect.anything())
  })

  it('records missed>0 when multiple cron ticks fell in the downtime window', async () => {
    const now = Date.now()
    // Daily cron, last_run two days ago. Between then and now, at least two
    // daily ticks should have fired (today + yesterday).
    mockTasks.push(
      makeTask({
        id: 't-missed',
        schedule: '0 9 * * *',
        last_run: now - 3 * DAY_MS,
      }),
    )
    runAgentSpy.mockResolvedValue({ text: 'ok' })

    await runDueTasks(async () => {})

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [, , , missedDelta, lastMissedAt] = updateSpy.mock.calls[0]!
    expect(missedDelta).toBeGreaterThanOrEqual(1)
    expect(lastMissedAt).toBeTypeOf('number')
    expect(recordEventSpy).toHaveBeenCalledWith(
      'scheduler_missed',
      expect.objectContaining({ id: 't-missed', missed: missedDelta }),
    )
  })

  it('runs the task exactly once on catch-up, not once per missed tick', async () => {
    mockTasks.push(
      makeTask({
        id: 't-one-shot',
        schedule: '0 * * * *', // hourly
        last_run: Date.now() - 5 * 60 * 60 * 1000, // 5 hours ago
      }),
    )
    runAgentSpy.mockResolvedValue({ text: 'ok' })

    await runDueTasks(async () => {})

    expect(runAgentSpy).toHaveBeenCalledTimes(1)
  })

  it('caps the missed count at MAX_MISSED_WINDOW - 1 for very frequent cron with long downtime', async () => {
    mockTasks.push(
      makeTask({
        id: 't-capped',
        schedule: '* * * * *', // every minute
        last_run: Date.now() - 365 * DAY_MS, // a year of downtime
      }),
    )
    runAgentSpy.mockResolvedValue({ text: 'ok' })

    await runDueTasks(async () => {})

    const [, , , missedDelta] = updateSpy.mock.calls[0]!
    expect(missedDelta).toBeLessThanOrEqual(49)
    expect(missedDelta).toBeGreaterThan(0)
    expect(recordEventSpy).toHaveBeenCalledWith(
      'scheduler_missed',
      expect.objectContaining({ id: 't-capped', capped: true }),
    )
  })

  it('uses created_at when last_run is null', async () => {
    mockTasks.push(
      makeTask({
        id: 't-fresh',
        schedule: '0 9 * * *',
        last_run: null,
        created_at: Date.now() - 5 * DAY_MS,
      }),
    )
    runAgentSpy.mockResolvedValue({ text: 'ok' })

    await runDueTasks(async () => {})

    const [, , , missedDelta] = updateSpy.mock.calls[0]!
    expect(missedDelta).toBeGreaterThanOrEqual(1)
  })

  it('prepends (missed N) to the "Running scheduled task" message when missed > 0', async () => {
    mockTasks.push(
      makeTask({
        id: 't-prefix',
        schedule: '0 9 * * *',
        last_run: Date.now() - 3 * DAY_MS,
      }),
    )
    runAgentSpy.mockResolvedValue({ text: 'done' })
    const sends: string[] = []

    await runDueTasks(async (_chatId, text) => {
      sends.push(text)
    })

    expect(sends[0]).toMatch(/\(missed \d+\) Running scheduled task:/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- scheduler-catch-up`
Expected: tests fail (current `runDueTasks` does not compute missed ticks).

- [ ] **Step 3: Implement catch-up math in `runDueTasks`**

Open `src/scheduler.ts`. Replace the entire file body — keep the imports and the leading helpers (`computeNextRun`, `validateCron`, `createScheduledTask`, `nonOverlapping`, `initScheduler`), rewrite `runDueTasks`:

```typescript
const MAX_MISSED_WINDOW = 50

function countMissedTicks(schedule: string, since: number, now: number): { missed: number; capped: boolean } {
  if (since >= now) return { missed: 0, capped: false }
  let count = 0
  let capped = false
  try {
    const it = parseExpression(schedule, { currentDate: new Date(since) })
    for (let i = 0; i < MAX_MISSED_WINDOW; i++) {
      const next = it.next().getTime()
      if (next > now) break
      count++
      if (i === MAX_MISSED_WINDOW - 1) capped = true
    }
  } catch {
    // Invalid cron shouldn't reach here (validateCron runs at create time),
    // but if it does we treat it as "no catch-up" rather than crash the loop.
    return { missed: 0, capped: false }
  }
  // `count` includes the tick that represents the current run. The number
  // of *missed* ticks is count - 1, floored at 0.
  return { missed: Math.max(0, count - 1), capped }
}

export async function runDueTasks(send: Sender): Promise<void> {
  const tasks = getDueTasks()
  for (const task of tasks) {
    const now = Date.now()
    const since = task.last_run ?? task.created_at
    const { missed, capped } = countMissedTicks(task.schedule, since, now)

    if (missed > 0) {
      logger.warn({ id: task.id, missed, capped }, 'scheduled task had missed ticks')
      recordEvent('scheduler_missed', capped ? { id: task.id, missed, capped: true } : { id: task.id, missed })
    }

    const prefix = missed > 0 ? `(missed ${missed}) ` : ''
    logger.info({ id: task.id, prompt: task.prompt.slice(0, 60), missed }, 'running scheduled task')

    try {
      await send(task.chat_id, `${prefix}Running scheduled task: ${task.prompt.slice(0, 120)}`)
      recordEvent('scheduler_run')
      const { text } = await runAgent(task.prompt, {
        permissionMode: 'bypassPermissions',
        chatId: task.chat_id,
      })
      const result = text ?? '(no output)'
      const nextRun = computeNextRun(task.schedule)
      const changes = updateTaskAfterRun(
        task.id,
        nextRun,
        result,
        missed,
        missed > 0 ? now : null,
      )
      if (changes === 0) {
        logger.warn({ id: task.id }, 'task disappeared mid-run, update skipped')
        continue
      }
      await send(task.chat_id, result)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      logger.error({ err, id: task.id }, 'scheduled task failed')
      try {
        const nextRun = computeNextRun(task.schedule)
        const changes = updateTaskAfterRun(
          task.id,
          nextRun,
          `ERROR: ${msg}`,
          missed,
          missed > 0 ? now : null,
        )
        if (changes === 0) {
          logger.warn({ id: task.id }, 'task disappeared mid-run, failure update skipped')
          continue
        }
      } catch {
        /* ignore */
      }
      try {
        await send(task.chat_id, `Scheduled task ${task.id} failed: ${msg}`)
      } catch {
        /* ignore */
      }
    }
  }
}
```

Note the ordering change versus the original: `updateTaskAfterRun` now runs **before** the result `send()` on the success path so we can short-circuit if the task was deleted mid-run. This is intentional — sending the result message to a deleted task's chat is noise.

Note also: the `RecordEvent` signature in `src/metrics.ts` is `recordEvent(kind: EventKind)` — no payload. Update the `recordEvent` signature in Step 4 below.

- [ ] **Step 4: Update `recordEvent` in `src/metrics.ts` to accept an optional payload**

In `src/metrics.ts`, change the `recordEvent` function signature and body:

```typescript
export function recordEvent(kind: EventKind, _payload?: Record<string, unknown>): void {
  totals[kind]++
  const arr = recent[kind]
  const now = Date.now()
  arr.push(now)
  const cutoff = now - HOUR_MS
  while (arr.length > 0 && arr[0]! < cutoff) arr.shift()
  if (kind === 'backup_ok') lastBackupAt = now
}
```

The payload is intentionally unused (`_payload`) — it's logged via the accompanying `logger.warn` call, not stored in the counter. Keeping the parameter makes call sites self-documenting without forcing a rework of the counter infrastructure.

- [ ] **Step 5: Run the catch-up tests to verify they pass**

Run: `npm run test -- scheduler-catch-up`
Expected: all tests pass.

- [ ] **Step 6: Write the task-disappeared test**

Create `tests/scheduler-task-disappeared.test.ts`:

```typescript
import { beforeEach, describe, it, expect, vi } from 'vitest'

const mockTasks: Array<{
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
  missed_runs: number
  last_missed_at: number | null
}> = []

const runAgentSpy = vi.fn()
const warnSpy = vi.fn()
let updateChanges = 1

vi.mock('../src/db.js', () => ({
  getDueTasks: () => [...mockTasks],
  updateTaskAfterRun: () => updateChanges,
  createTask: () => {},
}))

vi.mock('../src/agent.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}))

vi.mock('../src/metrics.js', () => ({
  recordEvent: () => {},
}))

vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    debug: () => {},
  },
}))

const { runDueTasks } = await import('../src/scheduler.js')

function makeTask(): (typeof mockTasks)[number] {
  return {
    id: 't-gone',
    chat_id: '42',
    prompt: 'x',
    schedule: '0 9 * * *',
    next_run: Date.now() - 1000,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: Date.now() - 86400_000,
    missed_runs: 0,
    last_missed_at: null,
  }
}

beforeEach(() => {
  mockTasks.length = 0
  runAgentSpy.mockReset()
  warnSpy.mockClear()
  updateChanges = 1
})

describe('runDueTasks task-disappeared', () => {
  it('logs warn and skips the result send when updateTaskAfterRun reports 0 changes', async () => {
    mockTasks.push(makeTask())
    runAgentSpy.mockResolvedValue({ text: 'result body' })
    updateChanges = 0
    const sends: string[] = []

    await runDueTasks(async (_chatId, text) => {
      sends.push(text)
    })

    // The "Running scheduled task" progress message goes out first (before
    // we know the task is gone). The *result* message must not.
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatch(/Running scheduled task/)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-gone' }),
      expect.stringContaining('disappeared'),
    )
  })

  it('on error path, logs warn and skips the failure message when task is gone', async () => {
    mockTasks.push(makeTask())
    runAgentSpy.mockRejectedValue(new Error('boom'))
    updateChanges = 0
    const sends: string[] = []

    await runDueTasks(async (_chatId, text) => {
      sends.push(text)
    })

    // Only the "Running scheduled task" progress message was sent before
    // the run failed. The "failed" message must not.
    expect(sends).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-gone' }),
      expect.stringContaining('disappeared'),
    )
  })
})
```

- [ ] **Step 7: Run task-disappeared tests to verify they pass**

Run: `npm run test -- scheduler-task-disappeared`
Expected: all tests pass.

- [ ] **Step 8: Run the full test suite to check nothing regressed**

Run: `npm run test`
Expected: all tests pass. If `scheduler-failures.test.ts` fails because of the new `updateTaskAfterRun` behavior, inspect the output — it should already be fixed in Task 4, but re-check the mock forwards the first three args correctly.

- [ ] **Step 9: Commit**

```bash
git add src/scheduler.ts src/metrics.ts tests/scheduler-catch-up.test.ts tests/scheduler-task-disappeared.test.ts
git commit -m "feat(scheduler): catch-up math and task-disappeared handling"
```

---

## Task 6: Hang detection in `nonOverlapping`

**Files:**
- Modify: `src/scheduler.ts`
- Create: `tests/scheduler-hang.test.ts`

- [ ] **Step 1: Write the failing hang test**

Create `tests/scheduler-hang.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

const recordEventSpy = vi.fn()
const warnSpy = vi.fn()

vi.mock('../src/metrics.js', () => ({
  recordEvent: (kind: string, payload?: unknown) => recordEventSpy(kind, payload),
}))

vi.mock('../src/logger.js', () => ({
  logger: {
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    debug: () => {},
  },
}))

const { nonOverlapping } = await import('../src/scheduler.js')

describe('nonOverlapping hang detection', () => {
  it('emits scheduler_hang exactly at the ladder thresholds {3, 10, 30, 100}', async () => {
    // fn that never resolves — simulates a hung run
    const stuck = () => new Promise<void>(() => {})
    const tick = nonOverlapping(stuck)

    // Prime: first tick starts the stuck fn
    tick()
    await new Promise((r) => setImmediate(r))

    // Now drive 100 skipped ticks and observe when the hang event fires
    for (let i = 0; i < 100; i++) {
      tick()
    }
    await new Promise((r) => setImmediate(r))

    const hangCalls = recordEventSpy.mock.calls.filter((c) => c[0] === 'scheduler_hang')
    const consecutives = hangCalls.map((c) => (c[1] as { consecutive: number }).consecutive)
    expect(consecutives).toEqual([3, 10, 30, 100])
  })

  it('resets the consecutive-skip counter on successful completion', async () => {
    recordEventSpy.mockClear()
    warnSpy.mockClear()

    // First fn: hangs for a while, then we swap it for a resolving one.
    // We simulate by using a flag the fn reads.
    let hang = true
    let resolve: (() => void) | undefined
    const maybeHang = () =>
      new Promise<void>((r) => {
        if (hang) {
          resolve = r
        } else {
          r()
        }
      })

    const tick = nonOverlapping(maybeHang)
    tick() // start hung run
    for (let i = 0; i < 4; i++) tick() // 4 skipped → should fire at 3
    await new Promise((r) => setImmediate(r))

    const beforeResolve = recordEventSpy.mock.calls.filter((c) => c[0] === 'scheduler_hang').length
    expect(beforeResolve).toBe(1)

    // Resolve the hung run, then drive fresh ticks
    hang = false
    resolve!()
    await new Promise((r) => setTimeout(r, 10))

    // Now a fresh run completes immediately; counter must be reset
    tick()
    await new Promise((r) => setTimeout(r, 10))

    // The next tick runs (no skip) — counter stays at 0
    for (let i = 0; i < 2; i++) tick()
    await new Promise((r) => setImmediate(r))

    // No new hang events since the reset
    const afterReset = recordEventSpy.mock.calls.filter((c) => c[0] === 'scheduler_hang').length
    expect(afterReset).toBe(1)
  })
})
```

- [ ] **Step 2: Run the hang tests to verify they fail**

Run: `npm run test -- scheduler-hang`
Expected: tests fail (current `nonOverlapping` does not track consecutive skips).

- [ ] **Step 3: Implement hang detection**

In `src/scheduler.ts`, replace the `nonOverlapping` function with:

```typescript
const HANG_LADDER = new Set([3, 10, 30, 100])

export function nonOverlapping<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
  onSkip?: () => void,
): (...args: A) => void {
  let running = false
  let consecutiveSkips = 0
  return (...args: A) => {
    if (running) {
      consecutiveSkips++
      if (HANG_LADDER.has(consecutiveSkips)) {
        logger.warn(
          { consecutive: consecutiveSkips },
          'scheduler tick repeatedly skipped — previous run may be hung',
        )
        recordEvent('scheduler_hang', { consecutive: consecutiveSkips })
      }
      onSkip?.()
      return
    }
    running = true
    fn(...args)
      .catch((err) => logger.error({ err }, 'nonOverlapping task crashed'))
      .finally(() => {
        running = false
        consecutiveSkips = 0
      })
  }
}
```

- [ ] **Step 4: Run the hang tests to verify they pass**

Run: `npm run test -- scheduler-hang`
Expected: both tests pass.

- [ ] **Step 5: Run the scheduler-guard tests to make sure we didn't regress the original behavior**

Run: `npm run test -- scheduler-guard`
Expected: both existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts tests/scheduler-hang.test.ts
git commit -m "feat(scheduler): hang detection in nonOverlapping with escalation ladder"
```

---

## Task 7: Summarize timeout via AbortController

**Files:**
- Modify: `src/memory-summarize.ts`
- Create: `tests/memory-summarize-timeout.test.ts`

- [ ] **Step 1: Write the failing timeout test**

Create `tests/memory-summarize-timeout.test.ts`:

```typescript
import { afterEach, describe, it, expect, vi } from 'vitest'

// The test configures a very short timeout by mocking config. This must be
// declared before the first import of memory-summarize.
vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp',
  CLAUDE_MODEL: '',
  SUMMARIZE_TIMEOUT_MS: 100,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

// Mutable ref so each test can swap the query implementation.
const queryImpl = { current: (_args: unknown) => makeNeverYieldingStream() }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryImpl.current(args),
}))

function makeNeverYieldingStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      // Hang indefinitely. The test relies on the AbortController to break out.
      await new Promise<void>(() => {})
      yield
    },
  }
}

function makeImmediateResultStream(result: string): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'result', result }
    },
  }
}

const { summarizeViaAgentSdk } = await import('../src/memory-summarize.js')

afterEach(() => {
  queryImpl.current = (_args: unknown) => makeNeverYieldingStream()
})

describe('summarizeViaAgentSdk timeout', () => {
  it('rejects with "summarize timeout" when the stream never yields', async () => {
    queryImpl.current = (_args: unknown) => makeNeverYieldingStream()
    const start = Date.now()
    await expect(summarizeViaAgentSdk('some text')).rejects.toThrow(/summarize timeout/i)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500) // 100ms timeout + slack
  })

  it('returns normally when the stream yields a result inside the timeout', async () => {
    queryImpl.current = (_args: unknown) => makeImmediateResultStream('happy summary')
    const out = await summarizeViaAgentSdk('some text')
    expect(out).toBe('happy summary')
  })

  it('passes an AbortController in options so the SDK can abort the stream', async () => {
    let capturedOptions: any = null
    queryImpl.current = (args: any) => {
      capturedOptions = args.options
      return makeImmediateResultStream('ok')
    }
    await summarizeViaAgentSdk('text')
    expect(capturedOptions.abortController).toBeInstanceOf(AbortController)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- memory-summarize-timeout`
Expected: tests fail. The first test will hang for up to the vitest test timeout (5s default) — if vitest reports it as timing out rather than failing with "summarize timeout", that's still a failure mode the implementation must fix.

If the first test times out the whole suite, kill it manually with Ctrl-C and proceed.

- [ ] **Step 3: Implement the timeout**

In `src/memory-summarize.ts`, replace `summarizeViaAgentSdk` (lines 80-107) with:

```typescript
// Real summarize backend. Uses the agent SDK in plan mode, without the
// project's settingSources, so the call stays short (no CLAUDE.md
// persona prelude) and can't run tools or touch the filesystem.
//
// Wraps the SDK stream in an AbortController + timer. If SUMMARIZE_TIMEOUT_MS
// elapses before a 'result' event arrives, we abort and throw — the sweep
// catch handler turns this into a logged error on one chat rather than a
// stalled daily job across all chats.
export async function summarizeViaAgentSdk(text: string): Promise<string> {
  const prompt = [
    'Below are conversation snippets between a user and their personal AI assistant.',
    'Write a factual 2–3 sentence summary focused on persistent user preferences,',
    'facts, and recurring topics. Omit trivia, one-off tasks, and pleasantries.',
    'Do not address the user directly. Output ONLY the summary, no preamble.',
    '',
    '--- snippets start ---',
    text,
    '--- snippets end ---',
    'Summary:',
  ].join('\n')

  const abortController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, SUMMARIZE_TIMEOUT_MS)

  const options: Record<string, unknown> = {
    cwd: PROJECT_ROOT,
    settingSources: [],
    permissionMode: 'plan',
    abortController,
  }
  if (CLAUDE_MODEL) options['model'] = CLAUDE_MODEL

  try {
    const stream = query({ prompt, options: options as any })
    let result = ''
    for await (const event of stream as AsyncIterable<any>) {
      if (event?.type === 'result') {
        result = typeof event.result === 'string' ? event.result : (event.result?.result ?? '')
      }
    }
    if (timedOut) throw new Error('summarize timeout')
    return result.trim()
  } catch (err) {
    if (timedOut) throw new Error('summarize timeout')
    throw err
  } finally {
    clearTimeout(timer)
  }
}
```

Then update the import line near the top of `src/memory-summarize.ts`. Change:

```typescript
import { PROJECT_ROOT, CLAUDE_MODEL } from './config.js'
```

to:

```typescript
import { PROJECT_ROOT, CLAUDE_MODEL, SUMMARIZE_TIMEOUT_MS } from './config.js'
```

- [ ] **Step 4: Run the timeout tests to verify they pass**

Run: `npm run test -- memory-summarize-timeout`
Expected: all three tests pass within well under 500ms.

- [ ] **Step 5: Run the existing memory-summarize tests to make sure nothing regressed**

Run: `npm run test -- memory-summarize`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/memory-summarize.ts tests/memory-summarize-timeout.test.ts
git commit -m "feat(summarize): 120s timeout via AbortController in summarizeViaAgentSdk"
```

---

## Task 8: Surface missed-runs summary in `/status`

**Files:**
- Modify: `src/commands/status.ts`

- [ ] **Step 1: Import the new helper and append the status line**

In `src/commands/status.ts`, after the existing `db.js` import block (lines 9-17), add `countMissedRuns` to the import:

```typescript
import {
  isAuthorised,
  isOpenMode,
  getSessionMeta,
  getTtsEnabled,
  countMemories,
  getPreferredModel,
  getEffortLevel,
  countMissedRuns,
} from '../db.js'
```

Then inside the `registerStatus` handler, after the `const memories = countMemories(chatId)` line (around line 56), insert:

```typescript
    const missed = countMissedRuns()
```

And in the `lines` array, after the `Memories` line, insert a conditional:

```typescript
      ...(missed.totalMissed > 0
        ? [
            `⏰ Missed ticks: ${missed.totalMissed} across ${missed.tasksWithMisses} tasks${
              missed.mostRecent
                ? ` · last ${formatAgo(missed.mostRecent.at)} (<code>${missed.mostRecent.id}</code>)`
                : ''
            }`,
          ]
        : []),
```

The spread-conditional keeps the line absent when there's nothing to report — the single-user default.

Complete resulting `lines` block (copy-paste in place of the existing one around lines 103-116):

```typescript
    const lines = [
      `🤖 <b>ClaudeClaw</b> v${BOT_VERSION} (${BOT_COMMIT})`,
      `🧠 Model: <code>${modelId}</code> · ${modelSource}`,
      `⚡ Effort: ${effortLabelText}`,
      `👤 Role: ${role} · ${permission}${admin && isOpenMode() ? ' · <b>OPEN MODE</b>' : ''}`,
      `🧵 Session: ${sessionLine}`,
      `🗄 Cache: ${cacheLine}`,
      `📚 Context: ${contextLine}`,
      `🧠 Memories: ${memories} for this chat`,
      ...(missed.totalMissed > 0
        ? [
            `⏰ Missed ticks: ${missed.totalMissed} across ${missed.tasksWithMisses} tasks${
              missed.mostRecent
                ? ` · last ${formatAgo(missed.mostRecent.at)} (<code>${missed.mostRecent.id}</code>)`
                : ''
            }`,
          ]
        : []),
      `🗣 Voice: ${voiceLine}`,
      `🌐 Bot features: ${featuresLine}`,
      `⏳ Inflight agents: ${inflightCount()}`,
      `🆔 Chat: <code>${chatId}</code> · User: <code>${userId ?? '?'}</code> · ${username}`,
    ]
```

- [ ] **Step 2: Verify typecheck and existing tests pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test`
Expected: all tests still pass. `/status` has no dedicated test file, so there's nothing to add here.

- [ ] **Step 3: Commit**

```bash
git add src/commands/status.ts
git commit -m "feat(status): surface missed-ticks summary in /status"
```

---

## Task 9: Migrations idempotency regression test

**Files:**
- Create: `tests/migrations-idempotent.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/migrations-idempotent.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

const { MIGRATIONS, runMigrations } = await import('../src/migrations.js')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-migrations-test-'))

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function openFresh(name: string): InstanceType<typeof Database> {
  const dbFile = path.join(tmpDir, name)
  try {
    fs.unlinkSync(dbFile)
  } catch {
    /* ignore */
  }
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  return db
}

describe('migrations idempotency', () => {
  it('double-applies without error: reset user_version then rerun', () => {
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version
    const db = openFresh('double-apply.db')
    try {
      runMigrations(db)
      expect(db.pragma('user_version', { simple: true })).toBe(latest)

      // Force a replay of every migration on the same DB.
      db.pragma('user_version = 0')
      runMigrations(db)

      expect(db.pragma('user_version', { simple: true })).toBe(latest)

      // Schema is intact: core tables exist with the expected columns.
      const scheduledCols = (
        db.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as { name: string }[]
      )
        .map((c) => c.name)
        .sort()
      expect(scheduledCols).toEqual(
        expect.arrayContaining([
          'id',
          'chat_id',
          'prompt',
          'schedule',
          'next_run',
          'last_run',
          'last_result',
          'status',
          'created_at',
          'missed_runs',
          'last_missed_at',
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('no-ops cleanly when already at latest version', () => {
    const db = openFresh('no-op.db')
    try {
      runMigrations(db)
      const before = db.pragma('user_version', { simple: true })
      runMigrations(db) // second call on fully-migrated DB
      const after = db.pragma('user_version', { simple: true })
      expect(after).toBe(before)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npm run test -- migrations-idempotent`
Expected: both tests pass. If `double-apply` fails, a migration is not idempotent — investigate which one by narrowing down (run each `up` manually, inspect the error).

- [ ] **Step 3: Commit**

```bash
git add tests/migrations-idempotent.test.ts
git commit -m "test: migrations idempotency regression (covers double-apply on reset user_version)"
```

---

## Task 10: Full suite verification

**Files:** none — validation task.

- [ ] **Step 1: Run the full check pipeline**

Run: `npm run check`
Expected: typecheck, lint, format:check, and the entire vitest suite all pass.

- [ ] **Step 2: Smoke-test the binary against a scratch DB**

Run:
```bash
rm -f /tmp/cc-e2e.db
DB_PATH_OVERRIDE= node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/cc-e2e.db');
  db.pragma('journal_mode = WAL');
  const { runMigrations } = require('./dist/migrations.js');
  runMigrations(db);
  db.prepare(\`INSERT INTO scheduled_tasks
    (id, chat_id, prompt, schedule, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)\`).run(
      't1', '42', 'hi', '0 9 * * *', Date.now() - 1000, 'active', Date.now() - 3 * 86400000
    );
  console.log(db.prepare('SELECT id, missed_runs, last_missed_at FROM scheduled_tasks').all());
"
rm -f /tmp/cc-e2e.db
```
Expected: output shows `{ id: 't1', missed_runs: 0, last_missed_at: null }`. Confirms the migration ran and the default values are in place.

- [ ] **Step 3: Final commit if anything was fixed during verification**

If steps 1 or 2 surfaced issues that required code changes:

```bash
git add -A
git commit -m "fix: address issues found during final verification"
```

If nothing changed, skip this step.

---

## Self-Review Notes

**Spec coverage check (after plan was written):**
- Missing ticks detection → Tasks 3, 4, 5 ✔
- Catch-up runs task once, regardless of missed count → Task 5 (test in Step 1) ✔
- MAX_MISSED_WINDOW cap → Task 5 (test in Step 1, fourth test) ✔
- `last_run ?? created_at` window start → Task 5 (implementation in Step 3) ✔
- `(missed N)` prefix in progress message → Task 5 (test + implementation) ✔
- `scheduler_missed` event with `capped` flag → Task 5 (test + implementation) ✔
- Extended `updateTaskAfterRun` with `missedDelta` and `lastMissedAt` → Task 4 ✔
- Error path bumps missed_runs too → Task 5 (error branch passes `missed` and `now`) ✔
- `changes === 0` warn + skip send → Task 5 + tests in `scheduler-task-disappeared.test.ts` ✔
- `SUMMARIZE_TIMEOUT_MS` env with 120s default → Task 1 ✔
- AbortController-wrapped SDK call → Task 7 ✔
- Timeout error propagates to sweep's existing catch → Task 7 (no sweep changes needed; existing test `memory-summarize.test.ts` already covers the sweep's error path) ✔
- Hang detection on `{3,10,30,100}` ladder → Task 6 ✔
- `scheduler_hang` event → Task 6 ✔
- `/status` surfaces missed summary when any task has misses → Task 8 ✔
- Migrations idempotency test → Task 9 ✔

**Type consistency spot-check:**
- `updateTaskAfterRun` signature: `(id: string, nextRun: number, result: string, missedDelta: number, lastMissedAt: number | null) => number` — consistent across Tasks 4, 5, and the two test mocks. ✔
- `countMissedRuns` return type `MissedRunsSummary` used in Task 8 matches the exported type from Task 4. ✔
- `recordEvent` signature now `(kind, _payload?)` — Task 5 and Task 6 both pass payload objects; pre-existing call sites (e.g. `initBackupSchedule`, `runDueTasks`'s `scheduler_run`) call with one argument, which is still valid because the payload is optional. ✔
- `EventKind` union in `metrics.ts` includes `scheduler_missed` and `scheduler_hang` (Task 2), which are emitted in Tasks 5 and 6. ✔

**Placeholder scan:** no "TBD", no "TODO", no "similar to Task N", no "add appropriate error handling". All code blocks are concrete. ✔
