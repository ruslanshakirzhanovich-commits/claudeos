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

    // The "Running scheduled task" progress message goes out first. The
    // *result* message must not — the task is gone from DB.
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

    // Only the progress message was sent before the run failed. The
    // "failed" message must not be sent if task is gone.
    expect(sends).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-gone' }),
      expect.stringContaining('disappeared'),
    )
  })
})
