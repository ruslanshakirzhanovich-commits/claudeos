import { initDatabase, listTasks, getTask, deleteTask, setTaskStatus } from './db.js'
import { createScheduledTask, validateCron, computeNextRun } from './scheduler.js'

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: node dist/schedule-cli.js <command> [args]',
      '',
      'Commands:',
      '  create "<prompt>" "<cron>" <chat_id>   Create a scheduled task',
      '  list                                    List all tasks',
      '  show <id>                               Show details of one task',
      '  delete <id>                             Delete a task',
      '  pause <id>                              Pause a task',
      '  resume <id>                             Resume a task',
      '',
      'Cron examples:',
      '  "0 9 * * *"     — daily 9am',
      '  "0 9 * * 1"     — Mondays 9am',
      '  "0 */4 * * *"   — every 4 hours',
      '',
    ].join('\n'),
  )
}

function fmt(ts: number | null): string {
  return ts ? new Date(ts).toISOString() : '—'
}

function main(): void {
  initDatabase()
  const [, , cmd, ...args] = process.argv

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage()
    return
  }

  switch (cmd) {
    case 'create': {
      const [prompt, cron, chatId] = args
      if (!prompt || !cron || !chatId) {
        process.stderr.write('create requires: "<prompt>" "<cron>" <chat_id>\n')
        process.exit(1)
      }
      if (!validateCron(cron)) {
        process.stderr.write(`Invalid cron expression: ${cron}\n`)
        process.exit(1)
      }
      const task = createScheduledTask(chatId, prompt, cron)
      process.stdout.write(`Created task ${task.id} — next run: ${fmt(task.next_run)}\n`)
      break
    }
    case 'list': {
      const tasks = listTasks()
      if (!tasks.length) {
        process.stdout.write('No scheduled tasks.\n')
        return
      }
      for (const t of tasks) {
        const snippet = t.prompt.length > 50 ? t.prompt.slice(0, 50) + '…' : t.prompt
        process.stdout.write(
          `${t.id}  [${t.status}]  ${t.schedule.padEnd(15)}  next=${fmt(t.next_run)}  "${snippet}"\n`,
        )
      }
      break
    }
    case 'show': {
      const [id] = args
      if (!id) {
        process.stderr.write('show requires: <id>\n')
        process.exit(1)
      }
      const t = getTask(id)
      if (!t) {
        process.stderr.write(`No task with id ${id}\n`)
        process.exit(1)
      }
      process.stdout.write(JSON.stringify(t, null, 2) + '\n')
      break
    }
    case 'delete': {
      const [id] = args
      if (!id) {
        process.stderr.write('delete requires: <id>\n')
        process.exit(1)
      }
      deleteTask(id)
      process.stdout.write(`Deleted ${id}\n`)
      break
    }
    case 'pause': {
      const [id] = args
      if (!id) {
        process.stderr.write('pause requires: <id>\n')
        process.exit(1)
      }
      setTaskStatus(id, 'paused')
      process.stdout.write(`Paused ${id}\n`)
      break
    }
    case 'resume': {
      const [id] = args
      if (!id) {
        process.stderr.write('resume requires: <id>\n')
        process.exit(1)
      }
      const t = getTask(id)
      if (!t) {
        process.stderr.write(`No task with id ${id}\n`)
        process.exit(1)
      }
      const nextRun = computeNextRun(t.schedule)
      setTaskStatus(id, 'active')
      process.stdout.write(`Resumed ${id} — next run: ${fmt(nextRun)}\n`)
      break
    }
    default:
      printUsage()
      process.exit(1)
  }
}

main()
