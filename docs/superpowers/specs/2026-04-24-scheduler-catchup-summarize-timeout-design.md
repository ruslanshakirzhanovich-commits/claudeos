# Scheduler catch-up and summarize timeout

**Date:** 2026-04-24
**Status:** Approved

## Problem

Two background subsystems fail silently in operational edge cases:

1. **Scheduler loses cron ticks across downtime.** `runDueTasks` picks every row with `next_run <= now` and computes the next run from `Date.now()`, not from the schedule timeline. If the process is down for several days, a daily task runs once and the missed ticks are invisible: no log, no metric, no sign in `/status` that anything was skipped.
2. **`summarizeViaAgentSdk` can hang indefinitely.** The SDK stream is consumed by a plain `for await` without any timeout. A stuck call blocks the whole `runMemorySummarizeSweep`, and because the sweep is wrapped in `nonOverlapping`, every subsequent tick is silently skipped. The 24-hour consolidation pipeline can be offline for days without visibility.

Smaller defects compound these:

- `updateTaskAfterRun` does not check `info.changes`, so a task deleted mid-run leaves the scheduler confident it updated state that no longer exists, and the user still receives the "Running scheduled task…" / result messages.
- `nonOverlapping` logs each skip at `debug` and emits a `scheduler_skip` event, but gives no warning when skips stack (e.g. three ticks in a row skipped = the long-running task is probably hung, not just slow).

## Goals

- Detect and record missed cron ticks per task. Run the task once on catch-up. Surface the count to the user.
- Bound `summarizeViaAgentSdk` with a timeout so a stuck SDK call fails the individual chat rather than the whole sweep.
- Fix the two small scheduler defects that amplify the above.
- Add a regression test confirming migrations are idempotent (they already are by construction, but no test pins that).

## Non-goals

- Parallelizing `runMemorySummarizeSweep`. The sweep runs once per day and processes a small list of chats; parallelism is premature.
- "Run all missed ticks" policy. A daily task down for two days runs once, not twice. Prevents restart storms.
- Per-task catch-up policy (a `catch_up: once | all | skip` column). Over-engineered for a single-user assistant.
- Distributed migration locking. The bot runs as one process on one host.
- Changes to `runAgent`, the shared chat pipeline, the memory tables, or any channel handler.

## Design

### Schema change (migration v7)

Add two columns to `scheduled_tasks`:

- `missed_runs INTEGER NOT NULL DEFAULT 0` — cumulative count of skipped ticks detected across the task's lifetime.
- `last_missed_at INTEGER` — timestamp of the most recent detection, or `NULL`.

Migration follows the existing pattern: `PRAGMA table_info` guard, `ALTER TABLE ADD COLUMN`, inside the standard transaction that bumps `user_version`.

### Catch-up policy for `runDueTasks`

For each due task returned by `getDueTasks()`:

1. Determine the window start: `since = task.last_run ?? task.created_at`.
2. Iterate the cron expression forward from `since`, counting ticks with timestamp `<= now`. Stop at `MAX_MISSED_WINDOW = 50` iterations to bound work on very frequent crons.
3. Let `missed = max(0, count - 1)`. A value of `count - 1` is correct because the current run itself covers one tick.
4. If `missed > 0`:
   - `logger.warn({ id, missed }, 'scheduled task had missed ticks')`
   - `recordEvent('scheduler_missed', { id, missed })`
   - In the "Running scheduled task…" message, prepend `(missed N) ` to the prompt preview.
   - Increment `missed_runs` by `missed` and set `last_missed_at = now` when we call `updateTaskAfterRun`.
5. Execute the task exactly once, as today.
6. Set `next_run = computeNextRun(schedule)` from `now` — same as today.

When `missed == count - 1` hits the `MAX_MISSED_WINDOW` cap, log `warn` with `capped: true`. Record the capped count (50 - 1 = 49) in `missed_runs`.

### Extending `updateTaskAfterRun`

Change signature:

```ts
export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
  missedDelta: number,
  lastMissedAt: number | null,
): number  // returns info.changes
```

Body runs a single `UPDATE` that also adds `missed_runs = missed_runs + ?` and conditionally updates `last_missed_at`. Returns `info.changes`.

Call sites in `runDueTasks`:

- Both success and error paths pass the same `missedDelta` and `lastMissedAt`. Missed ticks are a fact about the past that is independent of whether the current attempt succeeded — if we computed `missed = 2` before running and the run then crashed, those two ticks were still skipped and should be recorded. Not bumping would mean the next successful run re-detects them via the same `since = last_run ?? created_at` calculation, so the count would still end up correct, but the intermediate `missed_runs` would lag and `last_missed_at` would be wrong. Simpler to record at the first opportunity.
- If `changes === 0` on either path: `logger.warn({ id }, 'task disappeared mid-run, update skipped')` and skip the `send()` of the result message. Sending "Scheduled task X failed" to a deleted task's chat is noise.

### Summarize timeout

Add `SUMMARIZE_TIMEOUT_MS` to `config.ts`, default `120_000` (2 minutes), parsed from `env['SUMMARIZE_TIMEOUT_MS']` with the existing number-parse pattern.

In `summarizeViaAgentSdk`, wrap the SDK interaction:

```ts
const abortController = new AbortController()
const timer = setTimeout(() => abortController.abort(), SUMMARIZE_TIMEOUT_MS)
try {
  options['abortController'] = abortController
  const stream = query({ prompt, options: options as any })
  // existing for-await loop, unchanged
  return result.trim()
} finally {
  clearTimeout(timer)
}
```

If the SDK version in use does not honor `abortController` in options, fall back to `Promise.race` between the stream consumer and a timeout that throws `new Error('summarize timeout')`. Pick one of the two at implementation time based on a quick check of the installed SDK's API — the interface is public, so this is a 5-minute check, not a design ambiguity.

Throwing `Error('summarize timeout')` from `summarizeViaAgentSdk` is already handled correctly by `runMemorySummarizeSweep`: the `catch` at line 50-53 logs warn, increments `result.errors`, and continues to the next chat. No changes needed in the sweep.

### Hang detection in `nonOverlapping`

Extend the closure with a consecutive-skip counter:

- On skip: `consecutive += 1`. Emit `logger.warn({ consecutive }, 'scheduler tick repeatedly skipped — previous run may be hung')` and `recordEvent('scheduler_hang', { consecutive })` exactly when `consecutive` equals one of `{3, 10, 30, 100}`. This gives an escalation ladder without log-spamming on every skipped tick.
- On successful completion (`finally`): `consecutive = 0`.

Keep the existing `scheduler_skip` event and `debug` log as-is.

## Observability summary

New events:

- `scheduler_missed { id: string, missed: number, capped?: boolean }`
- `scheduler_hang { consecutive: number }`

Existing events untouched.

`/status` (existing command) needs one addition: if any task has `missed_runs > 0`, include a summary line like `missed ticks: 7 across 2 tasks (most recent: <id> at <ts>)`. Exact formatting follows the conventions already in `src/commands/status.ts`.

## Testing

New test files under `tests/`:

1. **`scheduler-catch-up.test.ts`**
   - Daily cron, `last_run` 2 days ago, `now` past today's tick → `missed == 2`, task runs once, `missed_runs` incremented by 2, `scheduler_missed` event recorded.
   - Daily cron, `last_run` 30 minutes ago → `missed == 0`, no event, `missed_runs` unchanged.
   - 5-minute cron, `last_run` null and `created_at` very old → `missed` capped at 49, event fires with `capped: true`.
   - Task with `status = 'paused'` → not returned by `getDueTasks`, no run, no missed calculation.

2. **`scheduler-task-disappeared.test.ts`**
   - Stub `runAgent` to delete the task mid-run. Assert `updateTaskAfterRun` returns 0, warn is logged, no "failed" message is sent.

3. **`scheduler-hang.test.ts`**
   - Drive `nonOverlapping` with a fake `fn` that never resolves. Call the wrapper 4 times. Assert `scheduler_hang` fires exactly once between the 3rd and 4th skip.

4. **`memory-summarize-timeout.test.ts`**
   - Stub `query` to return an async iterable that never yields. With `SUMMARIZE_TIMEOUT_MS = 100`, assert `summarizeViaAgentSdk` rejects with `summarize timeout` within ~150ms. Assert the sweep continues to the next chat.

5. **`migrations-idempotent.test.ts`**
   - Open a fresh DB, run `runMigrations`. Reset `user_version` to `0` manually. Run `runMigrations` again. Assert no error, all `CREATE`/`ALTER` guarded, final `user_version` matches the latest migration.

Existing tests that hit `updateTaskAfterRun` need signature updates for the two new parameters — spot-fix, no behavior change.

## Rollout

One PR, no flag. The migration is backward-compatible (ADD COLUMN with DEFAULT). Old schedules keep working; `missed_runs` starts at 0.

## Risks

- **Cron iterator explosion on very frequent cron.** Mitigated by `MAX_MISSED_WINDOW = 50`.
- **`abortController` on the SDK options may not be honored.** Mitigated by the fallback `Promise.race` approach. The implementation plan should verify which path the installed SDK supports before writing tests against it.
- **False-positive "hang" warning.** If a user has one long-running scheduled task that genuinely takes >3 ticks to complete, they will see `scheduler_hang` warnings. This is arguably correct — the operator should know — but it may feel noisy. Acceptable for now; revisit if it becomes a complaint.
