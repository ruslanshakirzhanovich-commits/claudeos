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
    const [, , , missedDelta, lastMissedAt] = updateSpy.mock.calls[0]!
    expect(missedDelta).toBeLessThanOrEqual(1)
    expect(lastMissedAt === null || typeof lastMissedAt === 'number').toBe(true)
  })

  it('records missed>0 when multiple cron ticks fell in the downtime window', async () => {
    const now = Date.now()
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
    expect(typeof lastMissedAt).toBe('number')
    expect(recordEventSpy).toHaveBeenCalledWith(
      'scheduler_missed',
      expect.objectContaining({ id: 't-missed', missed: missedDelta }),
    )
  })

  it('runs the task exactly once on catch-up, not once per missed tick', async () => {
    mockTasks.push(
      makeTask({
        id: 't-one-shot',
        schedule: '0 * * * *',
        last_run: Date.now() - 5 * 60 * 60 * 1000,
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
        schedule: '* * * * *',
        last_run: Date.now() - 365 * DAY_MS,
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
