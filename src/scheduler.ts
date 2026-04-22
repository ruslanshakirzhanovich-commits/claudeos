import cronParser from 'cron-parser'
import { randomUUID } from 'node:crypto'
import { getDueTasks, updateTaskAfterRun, createTask, type ScheduledTask } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import { SCHEDULER_POLL_MS } from './config.js'

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
  }
}

export async function runDueTasks(send: Sender): Promise<void> {
  const tasks = getDueTasks()
  for (const task of tasks) {
    logger.info({ id: task.id, prompt: task.prompt.slice(0, 60) }, 'running scheduled task')
    try {
      await send(task.chat_id, `Running scheduled task: ${task.prompt.slice(0, 120)}`)
      // Scheduled tasks are admin-created via CLI — keep full permissions.
      const { text } = await runAgent(task.prompt, { permissionMode: 'bypassPermissions' })
      const result = text ?? '(no output)'
      await send(task.chat_id, result)
      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, nextRun, result)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      logger.error({ err, id: task.id }, 'scheduled task failed')
      try {
        await send(task.chat_id, `Scheduled task ${task.id} failed: ${msg}`)
      } catch {
        /* ignore */
      }
      try {
        const nextRun = computeNextRun(task.schedule)
        updateTaskAfterRun(task.id, nextRun, `ERROR: ${msg}`)
      } catch {
        /* ignore */
      }
    }
  }
}

export function initScheduler(send: Sender): NodeJS.Timeout {
  logger.info('scheduler started')
  return setInterval(() => {
    runDueTasks(send).catch((err) => logger.error({ err }, 'runDueTasks crashed'))
  }, SCHEDULER_POLL_MS)
}
