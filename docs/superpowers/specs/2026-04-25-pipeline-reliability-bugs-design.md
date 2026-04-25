# Pipeline reliability bug fixes

**Date:** 2026-04-25
**Status:** Approved

## Problem

Four concrete defects in the chat-handling pipeline and its surrounding infrastructure cause silent message loss, stale session state, and misleading ops logs:

1. **Race on `session_id` in `chat-pipeline`.** `runChatPipeline` reads `getSession(chatId)` at [chat-pipeline.ts:36](src/chat-pipeline.ts#L36) before calling `runAgent`. The serialization guard (`runSerialPerChat`) lives **inside** `runAgent` at [agent.ts:76](src/agent.ts#L76), so two concurrent messages for the same chat both read the same `sessionId`. The agent calls then serialize correctly, but the second invocation passes a stale `sessionId` to the SDK because the first hasn't yet written `setSession(newSessionId)`. Result: lost continuation context mid-conversation, occasionally a restarted session when none was needed.

2. **`trackInflight` covers only the SDK call, not the full handler.** [agent.ts:67](src/agent.ts#L67) wraps the `runAgent` work in `trackInflight`, but every channel handler (`bot.ts`, `discord/handler.ts`, `whatsapp/handler.ts`) continues to do work after `runAgent` returns — splitting into chunks, calling `send(chunk)` repeatedly, calling `saveConversationTurn`. On graceful shutdown, `waitForInflight` drains the agent promise and exits while those chunks are still in flight. Result: partial replies, some chunks never sent, user sees only a prefix of what the model said.

3. **Chunk send has no retry or truncation marker.** Each handler's send loop (e.g. [discord/handler.ts:70-72](src/discord/handler.ts#L70-L72), [whatsapp/handler.ts:62-64](src/whatsapp/handler.ts#L62-L64)) calls `send(chunk)` naked inside `for`. If `send` rejects on chunk 3 of 5 (transient network error, Discord rate-limit, Meta backpressure), the outer `try` logs an error and the remaining chunks are silently dropped. User receives the first two chunks and never learns the rest existed.

4. **`rotateBackups` hides partial failures.** [backup.ts:32-55](src/backup.ts#L32-L55) returns just `removed` as a count. When `unlinkSync` throws (permission denied, lock, read-only FS), the error is logged at `warn`, the counter is not incremented, and the caller ([backup.ts:62-73](src/backup.ts#L62-L73)) logs `removedOld: removed` at `info`. An operator reading the ok-line sees "1 removed" but doesn't see "2 expected". Silent retention drift over time.

## Goals

- `chat-pipeline` must read and write `session_id` inside the per-chat serialization boundary, so sequential messages always chain through the freshest `sessionId`.
- Graceful shutdown must wait for the full handler, including chunk send, not just the agent call.
- Chunk send must retry transient failures and, when it gives up, append a visible truncation marker so the user knows the reply was clipped.
- Backup rotation must expose `{ requested, removed, failed }` and escalate to `warn` when anything failed.

## Non-goals

- Unifying Telegram, Discord, and WhatsApp handlers into one shared adapter. That's a code-quality refactor, deferred to a separate spec. This one is bug-fix-only.
- Changing the chat-queue algorithm, rate limiting, memory consolidation, or anything not directly named above.
- Reworking `runAgent`'s retry policy. The existing `withRetry` wrapper stays.
- Adding persistence or durability to the send-chunk layer beyond the in-memory retry. If WhatsApp really is down, the chunks really are lost; the marker tells the user.

## Design

### Move serialization out of `runAgent`

`runSerialPerChat(chatId, run)` currently lives at the bottom of `runAgent` ([agent.ts:76](src/agent.ts#L76)). It moves up one level, to every caller that owns a logical per-chat operation:

- [chat-pipeline.ts](src/chat-pipeline.ts): the entire post-rate-limit body of `runChatPipeline` becomes the callback passed to `runSerialPerChat`. Inside that callback: `getSession`, `buildMemoryContext`, `runAgent`, `setSession`, `saveConversationTurn`.
- [scheduler.ts](src/scheduler.ts) `runDueTasks`: the inner per-task body (after `getDueTasks`) runs inside `runSerialPerChat(task.chat_id, async () => { ... })`.

Then `runAgent` drops its own wrap:

```typescript
// agent.ts, bottom of runAgent()
return trackInflight(
  withRetry(attempt, { ... }),
)
```

No `if (opts.chatId) return runSerialPerChat(...)` anymore. `runAgent` becomes a pure SDK call with retry and in-flight tracking.

**Why not nested `runSerialPerChat` + `runSerialPerChat`?** Deadlock. An inner invocation would set `prev = tail` where `tail` is the very promise we're inside. The inner `prev.catch(...).then(fn)` would block on its own completion.

**Callers audit:** `grep -rn "runAgent(" src/` must return exactly three files after this change — `agent.ts` (definition), `chat-pipeline.ts`, `scheduler.ts`. No other module calls `runAgent` with a `chatId`. This is asserted in the implementation plan as a verification step.

### Extend `trackInflight` to the whole handler

`trackInflight(promise)` stays as-is (see [inflight.ts:5](src/inflight.ts#L5)). Entry points change:

- [bot.ts](src/bot.ts): the `bot.on('message', ...)` dispatch wraps its handler in `trackInflight((async () => { ... })())`.
- [discord/handler.ts](src/discord/handler.ts) `handleDiscordMessage`: same pattern at function body.
- [whatsapp/handler.ts](src/whatsapp/handler.ts) `handleWhatsAppMessage`: same.

`runAgent` drops its own `trackInflight` call at the same time. This is symmetric with the serialization move: both concerns — "one tracked, one serialized operation per logical chat turn" — move up from the SDK layer to the caller layer.

Scheduler stays tracked too: `runDueTasks`'s per-task body runs inside `trackInflight(runSerialPerChat(task.chat_id, async () => { ... }))`. Ordering: `trackInflight` wraps the whole thing (so the promise is tracked while it waits in the per-chat queue), `runSerialPerChat` wraps the actual work.

### Chunk send with retry and truncation marker

New helper in a small new module, **`src/chunked-send.ts`**:

```typescript
import { withRetry } from './retry.js'
import type { Logger } from './logger.js'

export async function sendAllChunksOrMark(
  chunks: string[],
  send: (text: string) => Promise<void>,
  log: Logger,
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    try {
      await withRetry(() => send(chunks[i]!), {
        attempts: 3,
        baseMs: 250,
        label: 'send-chunk',
        log,
      })
    } catch (err) {
      log.error(
        { err, sentChunks: i, totalChunks: chunks.length },
        'send failed mid-chunk',
      )
      try {
        await send(`[…truncated: ${chunks.length - i} chunk(s) lost]`)
      } catch {
        /* marker also failed — log above already covers it */
      }
      return
    }
  }
}
```

Used in all three handlers in place of the naked `for` loop:

```typescript
// discord/handler.ts
await sendAllChunksOrMark(chunkForDiscord(replyText), (t) => send(msg.channelId, t), log)

// whatsapp/handler.ts
await sendAllChunksOrMark(splitMessage(replyText, MAX_MESSAGE_LENGTH), (t) => send(jid, t), log)

// bot.ts (Telegram): the existing flow already splits and sends; adapt similarly.
```

The marker is terse and unambiguous. A user who sees `[…truncated: 2 chunk(s) lost]` knows (a) the reply was cut short, (b) how much was lost, (c) that the failure is infrastructure-side, not a silent model abort.

`withRetry` is the existing retry helper in [src/retry.ts](src/retry.ts). It already has exponential backoff and treats errors as retryable by default. No new framework.

### Backup rotation returns structured result

[backup.ts](src/backup.ts): `rotateBackups` goes from `(keep: number): number` to `(keep: number): RotationResult`:

```typescript
export interface RotationResult {
  requested: number
  removed: number
  failed: number
}
```

Body:

```typescript
let removed = 0
let failed = 0
for (const f of toRemove) {
  try {
    fs.unlinkSync(f.full)
    removed++
  } catch (err) {
    failed++
    logger.warn({ err, file: f.name }, 'failed to remove old backup')
  }
}
return { requested: toRemove.length, removed, failed }
```

In `initBackupSchedule`:

```typescript
const rotation = rotateBackups(keep)
recordEvent('backup_ok')
const logFn = rotation.failed > 0 ? logger.warn.bind(logger) : logger.info.bind(logger)
logFn(
  {
    path: result.path,
    sizeBytes: result.sizeBytes,
    schemaVersion: result.verification.schemaVersion,
    memories: result.verification.memories,
    rotation,
  },
  'scheduled backup ok',
)
```

No new metric event. The `failed > 0` lift to `warn` is enough signal: any alerting on warn-or-higher picks this up without a new counter.

## Observability

New logged conditions:

- `send failed mid-chunk` — error from `sendAllChunksOrMark` when `withRetry` exhausted attempts. Fields: `{ err, sentChunks, totalChunks }`.
- Backup rotation warn — existing log string, warn level when any file failed to delete.

Existing metrics (`agent_*`, `scheduler_*`, `backup_*`) unchanged.

## Testing

Five new tests.

1. **`tests/chat-pipeline-session-race.test.ts`**
   - Stub `runAgent` to return a monotonic `newSessionId = s-${n}` per call, with an artificial `await new Promise(r => setTimeout(r, 20))` delay inside.
   - Fire two `runChatPipeline` calls for the same `chatId` in parallel.
   - Use real `getSession`/`setSession` backed by a tmp SQLite from `initDatabase`.
   - Assert: the second call's `runAgent` receives the `sessionId` written by the first (no stale read). Second's `newSessionId` is what ends up in the DB.

2. **`tests/agent-no-self-serialization.test.ts`**
   - Mock `query` to record `Date.now()` per call and hold for 50ms.
   - Two parallel `runAgent({ chatId: 'X' })` with no outer serialization.
   - Assert: both `query` calls start within ~5ms of each other (parallel, not sequential). Regression guard: if someone re-introduces `runSerialPerChat` inside `runAgent`, this test fails.

3. **`tests/handler-inflight.test.ts`**
   - Three sub-tests, one per channel handler.
   - Stub `runChatPipeline` to resolve after 30ms.
   - During the 30ms window, poll `inflightCount()` — must be `>= 1`.
   - After resolution, `inflightCount()` must return to 0.

4. **`tests/send-chunks-truncation.test.ts`**
   - Array of 5 chunks. `send` mock: chunks 0-1 succeed, chunks 2+ throw `new Error('network dead')` forever.
   - After calling `sendAllChunksOrMark`, assert:
     - `send` was called for chunks 0, 1, 2 (with 3 retry attempts on chunk 2 before failing).
     - A final `send` call with text matching `/truncated: 3 chunk\(s\) lost/`.
     - Chunks 3 and 4 were never attempted.
     - Error log emitted with `sentChunks: 2, totalChunks: 5`.
   - Second sub-test: marker send also fails → no throw (the `try/catch` around marker swallows).

5. **`tests/backup-rotation-result.test.ts`**
   - Temp dir with four files matching `BACKUP_FILENAME_RE`, `keep=1` → three expected to delete.
   - Spy `fs.unlinkSync`: first and third throw EACCES, second succeeds.
   - Assert `rotateBackups(1) === { requested: 3, removed: 1, failed: 2 }`.
   - Warn log spied for both failures.

Existing tests affected — spot-check and update if the mock shape changes:
- `tests/agent-permission-default.test.ts` — tests for `runAgent` behavior. If it relied on internal `runSerialPerChat`, it needs a light update (wrap the call in `runSerialPerChat` at the test level or remove that expectation).
- `tests/scheduler-failures.test.ts`, `tests/scheduler-catch-up.test.ts`, `tests/scheduler-task-disappeared.test.ts` — they mock `runAgent` entirely, unaffected by the internal move.

## Rollout

Single PR. Atomic within one commit where practical, but structured so each TDD cycle commits a working tree:

1. `chunked-send.ts` module + its test (standalone, no depends).
2. `rotateBackups` return-type change + its test + `initBackupSchedule` consumer update.
3. Move `runSerialPerChat` out of `runAgent` + regression test + chat-pipeline wrap + scheduler wrap + session-race test.
4. Move `trackInflight` to handlers + in-flight tests + remove `trackInflight` from `runAgent`.
5. Replace naked send loops with `sendAllChunksOrMark` in all three handlers.

No config flag. No env vars. No schema migration.

## Risks

- **Missed caller of `runAgent`.** If a future caller (or some module I didn't grep) invokes `runAgent` with `chatId` and doesn't wrap in `runSerialPerChat`, that path loses serialization. Mitigation: plan includes a verification step `grep -rn "runAgent(" src/` that must return only the known three files. If something unexpected shows up, it gets the wrapper too.
- **In-flight double-count window.** During implementation, between the commit that wraps handlers in `trackInflight` and the commit that removes `trackInflight` from `runAgent`, a single message counts as 2 in `inflightCount()`. The commits are ordered to minimize this (handler wrap + agent unwrap in the same step), so in git history the state is consistent.
- **`sendAllChunksOrMark` retries amplify failures.** If `send` fails because of a real network outage, we now hit it 3 times instead of 1 per chunk. With 5 chunks failing, that's 15 calls instead of 5. For Meta/Discord/Telegram, still well under any rate-limit. For `send-chunk` specifically the 250ms baseMs with 3 attempts means max ~500ms delay per chunk in the worst case.
- **Truncation marker could itself be rate-limited.** If Discord 429s us and we're using `withRetry`, the marker send might also hit the rate limit. We catch the marker error silently — user gets no notification but logs show it. Acceptable for a corner case of a corner case.
