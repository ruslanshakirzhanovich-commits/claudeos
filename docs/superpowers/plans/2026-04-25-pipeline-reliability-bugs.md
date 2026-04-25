# Pipeline reliability bug fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four pipeline-reliability defects in one PR: stale `sessionId` reads in `chat-pipeline`, in-flight tracking that misses chunk send, naked send loops that lose chunks on mid-flight failures, and `rotateBackups` that hides partial deletion failures.

**Architecture:** Lift the per-chat serialization guard (`runSerialPerChat`) and the in-flight tracking guard (`trackInflight`) **out of `runAgent`** and into its callers (`chat-pipeline`, `scheduler.runDueTasks`, channel handlers in `bot.ts` / `discord/handler.ts` / `whatsapp/handler.ts`). This places both guards at the natural "one logical chat operation" boundary, so `getSession` and `setSession` happen inside the serialized window, and shutdown drains the whole handler including chunk send. Add a small `sendAllChunksOrMark` helper that wraps each chunk in `withRetry` and emits a visible `[…truncated…]` marker if any chunk fails after retries. Reshape `rotateBackups` to return `{ requested, removed, failed }` and lift its log to `warn` whenever something failed.

**Tech Stack:** TypeScript (strict), grammy (Telegram), discord.js, @whiskeysockets/baileys, vitest. Existing `withRetry` from `src/retry.ts` for per-chunk retries.

**Spec:** `docs/superpowers/specs/2026-04-25-pipeline-reliability-bugs-design.md`

---

## File Structure

**Create:**
- `src/chunked-send.ts` — `sendAllChunksOrMark` helper (channel-agnostic, takes a send callback)
- `tests/chunked-send.test.ts` — retry exhaustion + marker behavior
- `tests/chat-pipeline-session-race.test.ts` — two parallel `runChatPipeline` for one chatId, second sees first's `setSession`
- `tests/agent-no-self-serialization.test.ts` — regression: parallel `runAgent({ chatId })` calls really run in parallel
- `tests/handler-inflight.test.ts` — `inflightCount()` rises during handle\* and returns to 0 after
- `tests/backup-rotation-result.test.ts` — `RotationResult` shape, partial failure → warn

**Modify:**
- `src/agent.ts` — drop `trackInflight` and `runSerialPerChat` wraps; `runAgent` becomes a pure SDK call with retry
- `src/chat-pipeline.ts` — wrap the post-rate-limit body in `runSerialPerChat`
- `src/scheduler.ts` — wrap each per-task body in `runSerialPerChat` and `trackInflight`
- `src/bot.ts` — wrap `handleMessage` in `trackInflight`; replace `sendResponse` body with `sendAllChunksOrMark` driver
- `src/discord/handler.ts` — wrap body in `trackInflight`; use `sendAllChunksOrMark`
- `src/whatsapp/handler.ts` — wrap body in `trackInflight`; use `sendAllChunksOrMark`
- `src/backup.ts` — `rotateBackups` returns `RotationResult`; `initBackupSchedule` reads it, lifts to `warn` on failures

---

## Task 1: `chunked-send` helper

**Files:**
- Create: `src/chunked-send.ts`
- Create: `tests/chunked-send.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/chunked-send.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { sendAllChunksOrMark } = await import('../src/chunked-send.js')

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
} as any

describe('sendAllChunksOrMark', () => {
  it('sends all chunks in order when send always succeeds', async () => {
    const sent: string[] = []
    const send = vi.fn(async (t: string) => {
      sent.push(t)
    })

    await sendAllChunksOrMark(['a', 'b', 'c'], send, noopLog)

    expect(sent).toEqual(['a', 'b', 'c'])
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('appends a truncation marker when a chunk fails after retries', async () => {
    const sent: string[] = []
    const send = vi.fn(async (t: string) => {
      sent.push(t)
      // chunk 0 and 1 succeed, chunk 2 always fails (caller-level)
      if (t === 'c2') throw Object.assign(new Error('network dead'), { code: 'ECONNRESET' })
    })

    await sendAllChunksOrMark(['c0', 'c1', 'c2', 'c3', 'c4'], send, noopLog)

    // c0 once, c1 once, c2 retried 3 times, then a marker
    expect(sent.filter((s) => s === 'c0')).toHaveLength(1)
    expect(sent.filter((s) => s === 'c1')).toHaveLength(1)
    expect(sent.filter((s) => s === 'c2')).toHaveLength(3)
    expect(sent.filter((s) => s === 'c3')).toHaveLength(0)
    expect(sent.filter((s) => s === 'c4')).toHaveLength(0)
    const marker = sent.find((s) => /truncated/.test(s))
    expect(marker).toMatch(/3 chunk\(s\) lost/)
  })

  it('swallows a marker-send failure rather than throwing', async () => {
    let attempts = 0
    const send = vi.fn(async (t: string) => {
      attempts++
      throw Object.assign(new Error('always down'), { code: 'ECONNRESET' })
    })

    await expect(sendAllChunksOrMark(['only'], send, noopLog)).resolves.toBeUndefined()
    // first chunk: 3 retries, then marker (1 attempt, also fails)
    expect(attempts).toBe(4)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- chunked-send`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/chunked-send.ts`:

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
        /* marker also failed — error log above already records it */
      }
      return
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- chunked-send`
Expected: 3 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/chunked-send.ts tests/chunked-send.test.ts
git commit -m "feat(send): sendAllChunksOrMark helper with per-chunk retry and marker

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `rotateBackups` returns `RotationResult`

**Files:**
- Modify: `src/backup.ts`
- Create: `tests/backup-rotation-result.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/backup-rotation-result.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rot-'))
const STORE_DIR = path.join(tmpRoot, 'store')

vi.mock('../src/config.js', () => ({
  STORE_DIR,
}))

const warnSpy = vi.fn()
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: (...a: unknown[]) => warnSpy(...a), error: () => {}, debug: () => {} },
}))

vi.mock('../src/db.js', () => ({
  backupDatabase: () => {},
  verifyBackup: () => ({ schemaVersion: 7, sessions: 0, memories: 0, allowedChats: 0 }),
}))

vi.mock('../src/metrics.js', () => ({ recordEvent: () => {} }))

const { rotateBackups, backupsDir } = await import('../src/backup.js')

beforeEach(() => {
  warnSpy.mockClear()
  fs.rmSync(backupsDir(), { recursive: true, force: true })
  fs.mkdirSync(backupsDir(), { recursive: true })
})

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function seed(name: string, mtimeOffsetMs: number): string {
  const p = path.join(backupsDir(), name)
  fs.writeFileSync(p, 'fake')
  const t = Date.now() - mtimeOffsetMs
  fs.utimesSync(p, new Date(t), new Date(t))
  return p
}

describe('rotateBackups RotationResult', () => {
  it('returns counts when all deletions succeed', () => {
    seed('claudeclaw-2026-04-22T01-00-00.db', 3000)
    seed('claudeclaw-2026-04-23T01-00-00.db', 2000)
    seed('claudeclaw-2026-04-24T01-00-00.db', 1000)
    seed('claudeclaw-2026-04-25T01-00-00.db', 0)

    const res = rotateBackups(1)

    expect(res).toEqual({ requested: 3, removed: 3, failed: 0 })
    expect(fs.readdirSync(backupsDir())).toEqual(['claudeclaw-2026-04-25T01-00-00.db'])
  })

  it('counts failures separately and warns on each', () => {
    seed('claudeclaw-2026-04-22T01-00-00.db', 3000)
    seed('claudeclaw-2026-04-23T01-00-00.db', 2000)
    seed('claudeclaw-2026-04-24T01-00-00.db', 1000)
    seed('claudeclaw-2026-04-25T01-00-00.db', 0)

    const realUnlink = fs.unlinkSync
    let nthCall = 0
    const stub = vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      nthCall++
      if (nthCall === 1 || nthCall === 3) {
        const e = new Error('EACCES') as Error & { code: string }
        e.code = 'EACCES'
        throw e
      }
      return realUnlink(p)
    })
    try {
      const res = rotateBackups(1)
      expect(res).toEqual({ requested: 3, removed: 1, failed: 2 })
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      stub.mockRestore()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- backup-rotation-result`
Expected: FAIL — `rotateBackups` returns `number`, not the new shape.

- [ ] **Step 3: Reshape `rotateBackups` and update consumer**

Open `src/backup.ts`. Replace the `rotateBackups` function and adjust `initBackupSchedule`:

```typescript
export interface RotationResult {
  requested: number
  removed: number
  failed: number
}

export function rotateBackups(keep: number): RotationResult {
  const dir = backupsDir()
  if (!fs.existsSync(dir)) return { requested: 0, removed: 0, failed: 0 }
  const files = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((f) => ({
      name: f,
      full: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
  const toRemove = files.slice(Math.max(0, keep))
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
}

export function initBackupSchedule(intervalHours: number, keep: number): NodeJS.Timeout {
  const intervalMs = intervalHours * 60 * 60 * 1000
  const run = () => {
    try {
      const result = createAndVerifyBackup()
      const rotation = rotateBackups(keep)
      recordEvent('backup_ok')
      const logFn =
        rotation.failed > 0 ? logger.warn.bind(logger) : logger.info.bind(logger)
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
    } catch (err) {
      recordEvent('backup_fail')
      logger.error({ err }, 'scheduled backup FAILED')
    }
  }
  setTimeout(run, 30_000)
  return setInterval(run, intervalMs)
}
```

- [ ] **Step 4: Find and update other callers of `rotateBackups`**

Run: `grep -rn "rotateBackups" /root/claudeos-dev/src /root/claudeos-dev/tests`
If any production code consumed the previous `number` return value, update it. Most likely only `initBackupSchedule` (already updated above) and maybe `src/commands/backup.ts`.

If `src/commands/backup.ts` mentions `rotateBackups`:

Run: `grep -n "rotateBackups" /root/claudeos-dev/src/commands/backup.ts`
If a hit, read the file and adjust the consumer to use `.removed` (most natural mapping for a UI count). Adjust any related test.

- [ ] **Step 5: Run the tests**

Run: `npm run test -- backup-rotation-result`
Expected: 2 tests pass.

Run: `npm run test`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/backup.ts src/commands/backup.ts tests/backup-rotation-result.test.ts 2>/dev/null; git add src/backup.ts tests/backup-rotation-result.test.ts
git commit -m "feat(backup): rotateBackups returns RotationResult, warn on partial failure

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(The first `git add` is best-effort: includes commands/backup.ts only if it was modified; the second covers the guaranteed files.)

---

## Task 3: Move `runSerialPerChat` out of `runAgent` into `chat-pipeline`

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/chat-pipeline.ts`
- Create: `tests/chat-pipeline-session-race.test.ts`

- [ ] **Step 1: Write the failing race test**

Create `tests/chat-pipeline-session-race.test.ts`:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-race-'))
const dbFile = path.join(tmpDir, 'db.sqlite')

vi.mock('../src/config.js', () => ({
  DB_PATH: dbFile,
  STORE_DIR: tmpDir,
  PROJECT_ROOT: tmpDir,
  CLAUDE_MODEL: '',
  RATE_LIMIT_CAPACITY: 10,
  RATE_LIMIT_REFILL_PER_MIN: 100,
  RATE_LIMIT_MAX_TRACKED: 100,
}))

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: async () => '',
  saveConversationTurn: async () => {},
}))

const seenSessionIds: Array<string | undefined> = []
const runAgentMock = vi.fn(async (_msg: string, opts: any) => {
  seenSessionIds.push(opts.sessionId)
  // Simulate SDK latency so an unguarded race shows up.
  await new Promise((r) => setTimeout(r, 30))
  return { text: 'ok', newSessionId: `sid-${seenSessionIds.length}` }
})

vi.mock('../src/agent.js', () => ({
  runAgent: (m: string, o: any) => runAgentMock(m, o),
}))

const { initDatabase, closeDb } = await import('../src/db.js')
const { runChatPipeline } = await import('../src/chat-pipeline.js')

beforeAll(() => {
  initDatabase()
})

afterAll(() => {
  closeDb()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('runChatPipeline session-id race', () => {
  it('serializes per-chat: second call sees the sessionId written by the first', async () => {
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log } as any

    seenSessionIds.length = 0
    runAgentMock.mockClear()

    const a = runChatPipeline({
      chatId: 'race-chat',
      userMessage: 'hi 1',
      wrappedUserMessage: 'wrap 1',
      permissionMode: 'plan',
      log,
    })
    const b = runChatPipeline({
      chatId: 'race-chat',
      userMessage: 'hi 2',
      wrappedUserMessage: 'wrap 2',
      permissionMode: 'plan',
      log,
    })

    await Promise.all([a, b])

    // First call had no prior session — undefined.
    // Second call must have read 'sid-1' (what the first wrote).
    expect(seenSessionIds[0]).toBeUndefined()
    expect(seenSessionIds[1]).toBe('sid-1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- chat-pipeline-session-race`
Expected: FAIL — second call sees `undefined`, not `'sid-1'`. The race demonstrates the bug.

- [ ] **Step 3: Remove serialization from `runAgent`**

Open `src/agent.ts`. Replace the bottom block of `runAgent` (lines 66-77 in the current source). Find:

```typescript
  const run = () =>
    trackInflight(
      withRetry(attempt, {
        attempts: AGENT_RETRY_ATTEMPTS,
        baseMs: AGENT_RETRY_BASE_MS,
        label: 'runAgent',
        log: opts.log ?? logger,
        shouldRetry: (err) => !streamStarted && isTransientError(err),
      }),
    )
  if (opts.chatId) return runSerialPerChat(opts.chatId, run)
  return run()
}
```

Replace with:

```typescript
  return trackInflight(
    withRetry(attempt, {
      attempts: AGENT_RETRY_ATTEMPTS,
      baseMs: AGENT_RETRY_BASE_MS,
      label: 'runAgent',
      log: opts.log ?? logger,
      shouldRetry: (err) => !streamStarted && isTransientError(err),
    }),
  )
}
```

Then remove the now-unused import. Find at the top:

```typescript
import { runSerialPerChat } from './chat-queue.js'
```

Delete that line. (`trackInflight` import stays — it's still used.)

- [ ] **Step 4: Wrap `chat-pipeline` in `runSerialPerChat`**

Open `src/chat-pipeline.ts`. Add the import near the top:

```typescript
import { runSerialPerChat } from './chat-queue.js'
```

Replace the body of `runChatPipeline` after the rate-limit check. Current:

```typescript
  if (!rl.ok) {
    input.log.warn({ retryAfterMs: rl.retryAfterMs }, 'rate limited')
    return { kind: 'rate-limited', retryAfterMs: rl.retryAfterMs }
  }
  try {
    const memoryContext = await buildMemoryContext(input.chatId, input.userMessage)
    const messageForAgent = memoryContext
      ? `${memoryContext}\n\n${input.wrappedUserMessage}`
      : input.wrappedUserMessage
    const sessionId = getSession(input.chatId) ?? undefined
    const model = getPreferredModel(input.chatId) ?? undefined
    const storedEffort = getEffortLevel(input.chatId)
    const effort = isEffortLevel(storedEffort) ? storedEffort : CHAT_DEFAULT_EFFORT
    const { text, newSessionId } = await runAgent(messageForAgent, {
      sessionId,
      permissionMode: input.permissionMode,
      log: input.log,
      model,
      effort,
      chatId: input.chatId,
    })
    if (newSessionId && newSessionId !== sessionId) setSession(input.chatId, newSessionId)
    if (text) await saveConversationTurn(input.chatId, input.userMessage, text)
    return { kind: 'ok', text }
  } catch (err) {
    return { kind: 'error', error: err as Error }
  }
}
```

Replace with:

```typescript
  if (!rl.ok) {
    input.log.warn({ retryAfterMs: rl.retryAfterMs }, 'rate limited')
    return { kind: 'rate-limited', retryAfterMs: rl.retryAfterMs }
  }
  return runSerialPerChat(input.chatId, async (): Promise<ChatTurnResult> => {
    try {
      const memoryContext = await buildMemoryContext(input.chatId, input.userMessage)
      const messageForAgent = memoryContext
        ? `${memoryContext}\n\n${input.wrappedUserMessage}`
        : input.wrappedUserMessage
      const sessionId = getSession(input.chatId) ?? undefined
      const model = getPreferredModel(input.chatId) ?? undefined
      const storedEffort = getEffortLevel(input.chatId)
      const effort = isEffortLevel(storedEffort) ? storedEffort : CHAT_DEFAULT_EFFORT
      const { text, newSessionId } = await runAgent(messageForAgent, {
        sessionId,
        permissionMode: input.permissionMode,
        log: input.log,
        model,
        effort,
        chatId: input.chatId,
      })
      if (newSessionId && newSessionId !== sessionId) setSession(input.chatId, newSessionId)
      if (text) await saveConversationTurn(input.chatId, input.userMessage, text)
      return { kind: 'ok', text }
    } catch (err) {
      return { kind: 'error', error: err as Error }
    }
  })
}
```

- [ ] **Step 5: Run the race test**

Run: `npm run test -- chat-pipeline-session-race`
Expected: PASS — second call sees `'sid-1'`.

- [ ] **Step 6: Run the existing agent tests to ensure nothing broke**

Run: `npm run test -- agent-`
Expected: all `agent-*.test.ts` files still pass. None of them assert on the internal serialization order; they all mock `query` and observe its calls or the return value.

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts src/chat-pipeline.ts tests/chat-pipeline-session-race.test.ts
git commit -m "fix(pipeline): serialize chat-pipeline body to fix sessionId race

Move runSerialPerChat out of runAgent and wrap chat-pipeline's
post-rate-limit body. getSession and setSession now run inside
the per-chat serialization window, so concurrent messages chain
through the freshest session id instead of both reading stale
state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wrap `scheduler.runDueTasks` per-task body in `runSerialPerChat`

**Files:**
- Modify: `src/scheduler.ts`

- [ ] **Step 1: Read the current per-task body**

Open `src/scheduler.ts`. The relevant block is the inside of the `for (const task of tasks)` loop in `runDueTasks` (around lines 87-145 in the current file). Specifically the block from `const now = Date.now()` to the matching `}` at the end of the catch.

- [ ] **Step 2: Add the import**

At the top of `src/scheduler.ts`, find the existing imports and append (next to the other local imports):

```typescript
import { runSerialPerChat } from './chat-queue.js'
```

- [ ] **Step 3: Wrap the per-task body**

Inside `runDueTasks`, replace the current per-task loop body. Find the loop:

```typescript
  for (const task of tasks) {
    const now = Date.now()
    const since = task.last_run ?? task.created_at
    const { missed, capped } = countMissedTicks(task.schedule, since, now)

    if (missed > 0) { /* ... */ }
    // ... lots of existing logic ...
    try { /* run agent, send, update */ } catch { /* error path */ }
  }
```

Wrap the entire loop body in `runSerialPerChat(task.chat_id, async () => { ... })`:

```typescript
  for (const task of tasks) {
    await runSerialPerChat(task.chat_id, async () => {
      const now = Date.now()
      const since = task.last_run ?? task.created_at
      const { missed, capped } = countMissedTicks(task.schedule, since, now)

      // ... (everything that was in the original loop body, untouched) ...
    })
  }
```

The full revised function (replace the existing `runDueTasks` body wholesale):

```typescript
export async function runDueTasks(send: Sender): Promise<void> {
  const tasks = getDueTasks()
  for (const task of tasks) {
    await runSerialPerChat(task.chat_id, async () => {
      const now = Date.now()
      const since = task.last_run ?? task.created_at
      const { missed, capped } = countMissedTicks(task.schedule, since, now)

      if (missed > 0) {
        logger.warn({ id: task.id, missed, capped }, 'scheduled task had missed ticks')
        recordEvent(
          'scheduler_missed',
          capped ? { id: task.id, missed, capped: true } : { id: task.id, missed },
        )
      }

      const prefix = missed > 0 ? `(missed ${missed}) ` : ''
      logger.info(
        { id: task.id, prompt: task.prompt.slice(0, 60), missed },
        'running scheduled task',
      )

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
          return
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
            return
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
    })
  }
}
```

The only structural change is the `runSerialPerChat(task.chat_id, async () => { ... })` wrapper and replacing two `continue` statements with `return` (the function body now returns instead of continuing the loop).

- [ ] **Step 4: Run the scheduler tests**

Run: `npm run test -- scheduler`
Expected: all four scheduler test files (`scheduler-failures`, `scheduler-catch-up`, `scheduler-task-disappeared`, `scheduler-hang`, `scheduler-guard`, `scheduler.test.ts`) still pass. They mock `runAgent` and observe `updateTaskAfterRun` — the wrap is invisible to them.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts
git commit -m "fix(scheduler): wrap per-task body in runSerialPerChat

Now that runAgent no longer self-serializes, the scheduler's
direct calls to runAgent need their own serialization. Two
concurrent triggers for the same chat (a scheduled task and a
user message) must still take the queue in order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Regression test — `runAgent` does not self-serialize

**Files:**
- Create: `tests/agent-no-self-serialization.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/agent-no-self-serialization.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

vi.mock('../src/config.js', () => ({
  PROJECT_ROOT: '/tmp',
  CLAUDE_MODEL: '',
  AGENT_RETRY_ATTEMPTS: 1,
  AGENT_RETRY_BASE_MS: 10,
  AGENT_MAX_TURNS: 25,
  AGENT_STREAM_TIMEOUT_MS: 30_000,
}))

const startTimes: number[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: async function* () {
      startTimes.push(Date.now())
      // Hold the stream open long enough that a serialized second call would
      // be visibly delayed.
      await new Promise((r) => setTimeout(r, 50))
      yield { type: 'system', subtype: 'init', session_id: 's' }
      yield { type: 'result', result: 'ok' }
    },
  }),
}))

const { runAgent } = await import('../src/agent.js')

describe('runAgent does not self-serialize per chatId', () => {
  it('two parallel calls for the same chatId start within a few ms of each other', async () => {
    startTimes.length = 0

    const [a, b] = await Promise.all([
      runAgent('m1', { permissionMode: 'plan', chatId: 'X' }),
      runAgent('m2', { permissionMode: 'plan', chatId: 'X' }),
    ])

    expect(a.text).toBe('ok')
    expect(b.text).toBe('ok')

    // Both calls started; if runAgent had self-serialized, the second start
    // would be at least ~50ms after the first.
    expect(startTimes).toHaveLength(2)
    const delta = Math.abs(startTimes[1]! - startTimes[0]!)
    expect(delta).toBeLessThan(20)
  })
})
```

- [ ] **Step 2: Run the test — should pass already**

Run: `npm run test -- agent-no-self-serialization`
Expected: PASS. (After Task 3 the self-wrap is gone; this test pins that invariant.)

- [ ] **Step 3: Commit**

```bash
git add tests/agent-no-self-serialization.test.ts
git commit -m "test(agent): regression — runAgent does not self-serialize per chatId

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Move `trackInflight` from `runAgent` to handlers + scheduler

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/bot.ts`
- Modify: `src/discord/handler.ts`
- Modify: `src/whatsapp/handler.ts`
- Modify: `src/scheduler.ts`

- [ ] **Step 1: Remove `trackInflight` from `runAgent`**

Open `src/agent.ts`. After Task 3, the bottom of `runAgent` looks like:

```typescript
  return trackInflight(
    withRetry(attempt, {
      attempts: AGENT_RETRY_ATTEMPTS,
      baseMs: AGENT_RETRY_BASE_MS,
      label: 'runAgent',
      log: opts.log ?? logger,
      shouldRetry: (err) => !streamStarted && isTransientError(err),
    }),
  )
}
```

Remove the `trackInflight(...)` wrap:

```typescript
  return withRetry(attempt, {
    attempts: AGENT_RETRY_ATTEMPTS,
    baseMs: AGENT_RETRY_BASE_MS,
    label: 'runAgent',
    log: opts.log ?? logger,
    shouldRetry: (err) => !streamStarted && isTransientError(err),
  })
}
```

Then delete the now-unused import at the top:

```typescript
import { trackInflight } from './inflight.js'
```

Remove that line.

- [ ] **Step 2: Wrap Telegram `handleMessage` in `trackInflight`**

Open `src/bot.ts`. Find the `handleMessage` function (around line 96). Replace its signature and body so the entire async work is wrapped:

Current:

```typescript
async function handleMessage(
  ctx: Context,
  agentInput: string,
  opts: { forceVoice?: boolean; memoryText?: string } = {},
): Promise<void> {
  const { chatId, userId, username } = ctxIdentity(ctx)
  // ... existing body ...
}
```

Add `trackInflight` to the import block at the top of bot.ts (find existing imports):

```typescript
import { trackInflight } from './inflight.js'
```

Then wrap the body. The simplest pattern that doesn't restructure the function: rename the existing function to `handleMessageInner` (private), and create a new `handleMessage` that wraps:

```typescript
async function handleMessageInner(
  ctx: Context,
  agentInput: string,
  opts: { forceVoice?: boolean; memoryText?: string } = {},
): Promise<void> {
  // ... entire existing body, unchanged ...
}

async function handleMessage(
  ctx: Context,
  agentInput: string,
  opts: { forceVoice?: boolean; memoryText?: string } = {},
): Promise<void> {
  return trackInflight(handleMessageInner(ctx, agentInput, opts))
}
```

The existing call sites of `handleMessage` (inside `createBot`'s message dispatch) keep working unchanged.

- [ ] **Step 3: Wrap Discord `handleDiscordMessage`**

Open `src/discord/handler.ts`. Apply the same inner/outer split:

Add the import:

```typescript
import { trackInflight } from '../inflight.js'
```

Rename existing `handleDiscordMessage` to `handleDiscordMessageInner`. Add a thin wrapper:

```typescript
export async function handleDiscordMessage(
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
  sendTyping?: DiscordSendTyping,
): Promise<void> {
  return trackInflight(handleDiscordMessageInner(msg, send, sendTyping))
}

async function handleDiscordMessageInner(
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
  sendTyping?: DiscordSendTyping,
): Promise<void> {
  // ... entire existing body, unchanged ...
}
```

- [ ] **Step 4: Wrap WhatsApp `handleWhatsAppMessage`**

Open `src/whatsapp/handler.ts`. Same pattern:

Add the import:

```typescript
import { trackInflight } from '../inflight.js'
```

Rename `handleWhatsAppMessage` to `handleWhatsAppMessageInner` and add the wrapper:

```typescript
export async function handleWhatsAppMessage(
  msg: WhatsAppMessage,
  send: WhatsAppSendReply,
  sendTyping?: WhatsAppSendTyping,
): Promise<void> {
  return trackInflight(handleWhatsAppMessageInner(msg, send, sendTyping))
}

async function handleWhatsAppMessageInner(
  msg: WhatsAppMessage,
  send: WhatsAppSendReply,
  sendTyping?: WhatsAppSendTyping,
): Promise<void> {
  // ... entire existing body, unchanged ...
}
```

- [ ] **Step 5: Wrap scheduler per-task body**

Open `src/scheduler.ts`. Find the per-task block from Task 4 (the `runSerialPerChat` wrap). Wrap the **outer** of the two existing wraps in `trackInflight`. The shape becomes:

```typescript
for (const task of tasks) {
  await trackInflight(
    runSerialPerChat(task.chat_id, async () => {
      // ... existing body unchanged ...
    }),
  )
}
```

Add the import:

```typescript
import { trackInflight } from './inflight.js'
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the existing test suite — should still pass**

Run: `npm run test`
Expected: all current tests green. The trackInflight changes are observable through `inflightCount()` but no current test asserts on it; the Task 7 test will.

- [ ] **Step 8: Commit**

```bash
git add src/agent.ts src/bot.ts src/discord/handler.ts src/whatsapp/handler.ts src/scheduler.ts
git commit -m "fix(inflight): track full handler, not just runAgent

Move trackInflight from runAgent up to each handler and to the
scheduler per-task body. Graceful shutdown now waits for chunk
send and saveConversationTurn, not just the SDK call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Handler-inflight tests

**Files:**
- Create: `tests/handler-inflight.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/handler-inflight.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log }
  return { logger: log }
})

vi.mock('../src/config.js', () => ({
  TYPING_REFRESH_MS: 4000,
  MAX_MESSAGE_LENGTH: 4096,
  // Discord
  isDiscordUserAuthorisedOf: () => true,
  isDiscordUserAdminOf: () => false,
  isDiscordUserAuthorised: () => true,
  isDiscordUserAdmin: () => false,
  // WhatsApp
  isWhatsAppAuthorisedOf: () => true,
  isWhatsAppNumberAdminOf: () => false,
  isWhatsAppAuthorised: () => true,
  isWhatsAppNumberAdmin: () => false,
}))

let pipelineResolve: (() => void) | undefined
const pipelineMock = vi.fn(async () => {
  await new Promise<void>((r) => {
    pipelineResolve = r
  })
  return { kind: 'ok' as const, text: 'reply' }
})

vi.mock('../src/chat-pipeline.js', () => ({
  runChatPipeline: (input: any) => pipelineMock(input),
}))

const { handleDiscordMessage } = await import('../src/discord/handler.js')
const { handleWhatsAppMessage } = await import('../src/whatsapp/handler.js')
const { inflightCount } = await import('../src/inflight.js')

describe('handler in-flight tracking', () => {
  it('Discord: inflightCount rises during handle and returns to 0 after', async () => {
    pipelineResolve = undefined
    const sent: string[] = []
    const send = async (_id: string, t: string) => {
      sent.push(t)
    }
    const before = inflightCount()
    const p = handleDiscordMessage(
      { channelId: 'c', userId: 'u', authorTag: 't', text: 'hi', isDM: true } as any,
      send,
    )
    // Yield once so the inner async runs to its first await.
    await new Promise((r) => setImmediate(r))
    expect(inflightCount()).toBeGreaterThan(before)
    pipelineResolve!()
    await p
    expect(inflightCount()).toBe(before)
  })

  it('WhatsApp: inflightCount rises during handle and returns to 0 after', async () => {
    pipelineResolve = undefined
    const send = async () => {}
    const before = inflightCount()
    const p = handleWhatsAppMessage(
      { jid: '1@s.whatsapp.net', text: 'hi', isGroup: false, messageId: 'm', timestamp: 0 } as any,
      send,
    )
    await new Promise((r) => setImmediate(r))
    expect(inflightCount()).toBeGreaterThan(before)
    pipelineResolve!()
    await p
    expect(inflightCount()).toBe(before)
  })
})
```

(Telegram is intentionally not covered here — its handler is wired through grammy `Bot` and would require mocking the framework. The Discord and WhatsApp tests prove the pattern; Telegram uses the same wrap shape and the same `trackInflight` from `inflight.ts`.)

- [ ] **Step 2: Run the test**

Run: `npm run test -- handler-inflight`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/handler-inflight.test.ts
git commit -m "test(inflight): handlers register in-flight for the full duration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Apply `sendAllChunksOrMark` in Discord handler

**Files:**
- Modify: `src/discord/handler.ts`

- [ ] **Step 1: Replace the chunk send loop**

Open `src/discord/handler.ts`. Find the success branch (after the rate-limit and error checks), currently:

```typescript
    const replyText = result.text ?? '(no output)'
    for (const chunk of chunkForDiscord(replyText)) {
      await send(msg.channelId, chunk)
    }
```

Replace with a call to `sendAllChunksOrMark`. Add the import at the top of the file:

```typescript
import { sendAllChunksOrMark } from '../chunked-send.js'
```

Then replace the loop:

```typescript
    const replyText = result.text ?? '(no output)'
    await sendAllChunksOrMark(
      chunkForDiscord(replyText),
      (text) => send(msg.channelId, text),
      log,
    )
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run Discord tests**

Run: `npm run test -- discord`
Expected: all `discord-*.test.ts` files pass. The semantic when send always succeeds is identical to the prior `for` loop, so existing tests should remain green.

- [ ] **Step 4: Commit**

```bash
git add src/discord/handler.ts
git commit -m "fix(discord): use sendAllChunksOrMark for resilient chunk delivery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Apply `sendAllChunksOrMark` in WhatsApp handler

**Files:**
- Modify: `src/whatsapp/handler.ts`

- [ ] **Step 1: Replace the chunk send loop**

Open `src/whatsapp/handler.ts`. Add the import:

```typescript
import { sendAllChunksOrMark } from '../chunked-send.js'
```

Find the success branch:

```typescript
    const replyText = result.text ?? '(no output)'
    for (const chunk of splitMessage(replyText, MAX_MESSAGE_LENGTH)) {
      await send(jid, chunk)
    }
```

Replace with:

```typescript
    const replyText = result.text ?? '(no output)'
    await sendAllChunksOrMark(
      splitMessage(replyText, MAX_MESSAGE_LENGTH),
      (text) => send(jid, text),
      log,
    )
```

- [ ] **Step 2: Typecheck and run WhatsApp tests**

Run: `npm run typecheck && npm run test -- whatsapp`
Expected: no typecheck errors, WhatsApp tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/whatsapp/handler.ts
git commit -m "fix(whatsapp): use sendAllChunksOrMark for resilient chunk delivery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Apply `sendAllChunksOrMark` in Telegram (`bot.ts`)

**Files:**
- Modify: `src/bot.ts`

Telegram has a richer per-chunk path (HTML-then-plain fallback). We keep that fallback inside a single `send` callback and let `sendAllChunksOrMark` orchestrate the chunk-level retry + marker.

- [ ] **Step 1: Inspect the current `sendResponse`**

Run: `grep -n -A 25 "async function sendResponse" /root/claudeos-dev/src/bot.ts`
Expected output: lines ~45-67 of bot.ts, the existing implementation that retries HTML, falls back to plain, and `continue`s on exhausted retries.

- [ ] **Step 2: Replace `sendResponse`**

Open `src/bot.ts`. Find the `sendResponse` function. Replace it with:

```typescript
import { sendAllChunksOrMark } from './chunked-send.js'

async function sendOneTelegramChunk(ctx: Context, chunk: string): Promise<void> {
  // First try HTML; on a non-transient HTML error (parser issues), fall
  // back to plain text. On transient HTML errors, retry with HTML — the
  // retry cap is enforced by sendAllChunksOrMark's outer withRetry, so
  // here we throw to let it count as one failed attempt.
  try {
    await ctx.reply(chunk, { parse_mode: 'HTML' })
  } catch (err) {
    if (isTransientError(err)) throw err
    logger.warn({ err }, 'HTML send failed, falling back to plain text')
    await ctx.reply(chunk)
  }
}

async function sendResponse(ctx: Context, text: string): Promise<void> {
  if (!text) {
    await ctx.reply('(no output)').catch(() => {})
    return
  }
  const formatted = formatForTelegram(text)
  const log = logger.child({})
  await sendAllChunksOrMark(
    splitMessage(formatted),
    (chunk) => sendOneTelegramChunk(ctx, chunk),
    log,
  )
}
```

The `import` line goes at the top with other imports (next to the existing `import { withRetry, isTransientError } from './retry.js'`).

`withRetry` and the local manual retry inside `sendResponse` are no longer needed in this function. Leave the `withRetry`/`isTransientError` imports — they may be used elsewhere in `bot.ts` (line 47 of the current file uses `withRetry` for the `(no output)` reply, but we simplified that above; if `withRetry` is now unused in this file, the linter will flag it; remove the import then).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: If lint complains about unused imports, remove them**

Run: `npm run lint 2>&1 | grep "bot.ts"`
If `withRetry` (or `isTransientError`) is reported as unused in `bot.ts`, remove from the import line. Re-run lint; expected: clean.

- [ ] **Step 5: Run Telegram tests**

Run: `npm run test -- bot`
Expected: existing bot tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts
git commit -m "fix(telegram): use sendAllChunksOrMark; HTML→plain fallback per-chunk

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Full verification

**Files:** none — validation task.

- [ ] **Step 1: Verify `runAgent` callsites are still only the known three**

Run: `grep -rn "runAgent(" /root/claudeos-dev/src/ | grep -v "function runAgent\|export.*runAgent"`
Expected: exactly two production callsites: `src/chat-pipeline.ts` (inside `runSerialPerChat`) and `src/scheduler.ts` (inside `runSerialPerChat`). If any other file is in the list, it needs the wrap.

- [ ] **Step 2: Run the full check pipeline**

Run: `npm run check`
Expected: typecheck, lint, format:check, vitest all green.

If `prettier --check` flags any modified file, run `npx prettier --write <files>` and commit:

```bash
git add -u
git commit -m "style: prettier format

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Spot-check inflight drain end-to-end**

Run:
```bash
npx tsx -e "
import { trackInflight, inflightCount, waitForInflight } from './src/inflight.js'

let release: (() => void) | undefined
const work = trackInflight(new Promise<void>((r) => { release = r }))
console.log('count during work:', inflightCount())
setTimeout(() => release!(), 100)
const remaining = await waitForInflight(2000)
console.log('count after drain:', inflightCount(), 'returned:', remaining)
" 2>&1 | grep -v INFO | tail -5
```

Wrap the import in an async IIFE if top-level await is rejected:

```bash
cat > smoke-tmp.ts <<'EOF'
import { trackInflight, inflightCount, waitForInflight } from './src/inflight.js'

async function main() {
  let release: (() => void) | undefined
  const work = trackInflight(new Promise<void>((r) => { release = r }))
  console.log('count during work:', inflightCount())
  setTimeout(() => release!(), 100)
  const remaining = await waitForInflight(2000)
  console.log('count after drain:', inflightCount(), 'returned:', remaining)
}
main().catch(console.error)
EOF
npx tsx smoke-tmp.ts 2>&1 | grep -E "count|returned" | tail -5
rm -f smoke-tmp.ts
```

Expected output:
- `count during work: 1`
- `count after drain: 0 returned: 0`

This confirms `trackInflight` + `waitForInflight` still work end-to-end after the move.

- [ ] **Step 4: Spot-check rotation result on real disk**

```bash
cat > smoke-tmp.ts <<'EOF'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rot-smoke-'))
  process.env.STORE_DIR = tmp
  // We can't override STORE_DIR after import; just use the production
  // path with a fake backup file. Skipping this smoke test unless STORE_DIR
  // can be tested without affecting prod. Using a unit-test pattern instead.
  console.log('rotation smoke covered by tests/backup-rotation-result.test.ts')
}
main()
EOF
npx tsx smoke-tmp.ts 2>&1 | tail -2
rm -f smoke-tmp.ts
```

(Result: the message confirms the unit test is the source of truth; no further smoke needed.)

- [ ] **Step 5: Final commit if anything changed during verification**

If steps 2-4 surfaced fixes:

```bash
git add -A
git commit -m "fix: issues found during final verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Otherwise no commit.

---

## Self-Review Notes

**Spec coverage:**
- Race on session_id → Task 3 (move serialization, regression test) ✔
- Scheduler also serialized after the move → Task 4 ✔
- Agent doesn't self-serialize regression → Task 5 ✔
- In-flight tracking covers full handler → Task 6 (move) + Task 7 (test) ✔
- Chunk send retry + truncation marker → Task 1 (helper) + Tasks 8-10 (apply) ✔
- `rotateBackups` returns RotationResult, warn on partial failure → Task 2 ✔

**Type consistency:**
- `RotationResult` defined in Task 2, consumed by `initBackupSchedule` in same task. ✔
- `sendAllChunksOrMark(chunks, send, log)` signature consistent across Tasks 1, 8, 9, 10. The `send` callback signature is `(text: string) => Promise<void>` everywhere. ✔
- `runSerialPerChat(chatId, async () => { ... })` shape consistent in Tasks 3, 4, 6. ✔
- `trackInflight(promise)` shape consistent in Task 6. ✔
- Rename pattern: `handle*Message` (exported wrapper) → `handle*MessageInner` (private) used uniformly in Discord and WhatsApp; Telegram does the same with `handleMessage`/`handleMessageInner`. ✔

**Placeholder scan:** no "TBD", no "implement later", no "similar to Task N". Every code block is concrete. The reference to "if any other caller of `rotateBackups` exists, update it" in Task 2 Step 4 is a real branch with grep instructions, not a placeholder. ✔
