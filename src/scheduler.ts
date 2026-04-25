import cronParser from 'cron-parser'
import { randomUUID } from 'node:crypto'
import { getDueTasks, updateTaskAfterRun, createTask, type ScheduledTask } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import { SCHEDULER_POLL_MS } from './config.js'
import { recordEvent } from './metrics.js'
import { runSerialPerChat } from './chat-queue.js'

const { parseExpression } = (cronParser as any).default ?? cronParser

export type Sender = (chatId: string, text: string) => Promise<void>

export function computeNextRun(cronExpression: string): number {
  const it = parseExpression(cronExpression)
  return it.next().getTime()
}

export function validateCron(cronExpression: string): boolean {
  try {
    parseExpression(cronExpression)
    return true
  } catch {
    return false
  }
}

export function createScheduledTask(
  chatId: string,
  prompt: string,
  cronExpression: string,
): ScheduledTask {
  if (!validateCron(cronExpression)) {
    throw new Error(`Invalid cron expression: ${cronExpression}`)
  }
  const id = randomUUID().slice(0, 8)
  const nextRun = computeNextRun(cronExpression)
  createTask({
    id,
    chat_id: chatId,
    prompt,
    schedule: cronExpression,
    next_run: nextRun,
    status: 'active',
  })
  return {
    id,
    chat_id: chatId,
    prompt,
    schedule: cronExpression,
    next_run: nextRun,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: Date.now(),
    missed_runs: 0,
    last_missed_at: null,
  }
}

const MAX_MISSED_WINDOW = 50

function countMissedTicks(
  schedule: string,
  since: number,
  now: number,
): { missed: number; capped: boolean } {
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
    return { missed: 0, capped: false }
  }
  // `count` includes the tick that represents the current run. Missed = count - 1.
  return { missed: Math.max(0, count - 1), capped }
}

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
        // Scheduled tasks are admin-created via CLI — keep full permissions.
        // Pass chatId so token usage is attributed to the owning chat (visible
        // in /status usage counters and /health), not lost as anonymous runs.
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

export function initScheduler(send: Sender): NodeJS.Timeout {
  logger.info('scheduler started')
  const tick = nonOverlapping(
    () => runDueTasks(send),
    () => {
      recordEvent('scheduler_skip')
      logger.debug('scheduler tick skipped — previous run still in flight')
    },
  )
  return setInterval(tick, SCHEDULER_POLL_MS)
}
