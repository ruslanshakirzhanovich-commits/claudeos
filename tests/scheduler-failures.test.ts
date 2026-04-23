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
}> = []

const updateSpy = vi.fn()
const runAgentSpy = vi.fn()

vi.mock('../src/db.js', () => ({
  getDueTasks: () => [...mockTasks],
  updateTaskAfterRun: (id: string, nextRun: number, result: string) => {
    updateSpy(id, nextRun, result)
  },
  createTask: () => {},
}))

vi.mock('../src/agent.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}))

vi.mock('../src/metrics.js', () => ({
  recordEvent: () => {},
}))

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { runDueTasks } = await import('../src/scheduler.js')

function makeTask(id: string): (typeof mockTasks)[number] {
  return {
    id,
    chat_id: '42',
    prompt: 'do a thing',
    schedule: '0 9 * * *',
    next_run: Date.now() - 1000,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: Date.now() - 86400_000,
  }
}

beforeEach(() => {
  mockTasks.length = 0
  updateSpy.mockClear()
  runAgentSpy.mockReset()
})

describe('runDueTasks', () => {
  it('advances next_run even when the agent throws — task does not run forever', async () => {
    mockTasks.push(makeTask('t1'))
    runAgentSpy.mockRejectedValue(new Error('agent down'))
    const sends: Array<[string, string]> = []
    const send = async (chatId: string, text: string) => { sends.push([chatId, text]) }

    await runDueTasks(send)

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [id, nextRun, result] = updateSpy.mock.calls[0]!
    expect(id).toBe('t1')
    expect(nextRun).toBeGreaterThan(Date.now())
    expect(String(result)).toMatch(/ERROR.*agent down/)
  })

  it('delivers both progress-start and result on happy path', async () => {
    mockTasks.push(makeTask('t2'))
    runAgentSpy.mockResolvedValue({ text: 'here is the thing' })
    const sends: Array<[string, string]> = []
    const send = async (chatId: string, text: string) => { sends.push([chatId, text]) }

    await runDueTasks(send)

    expect(sends).toHaveLength(2)
    expect(sends[0]?.[1]).toMatch(/Running scheduled task:/)
    expect(sends[1]?.[1]).toBe('here is the thing')
    expect(updateSpy).toHaveBeenCalledWith('t2', expect.any(Number), 'here is the thing')
  })

  it('passes the task chat_id to runAgent so usage attributes to the owning chat', async () => {
    mockTasks.push(makeTask('t-chatid'))
    runAgentSpy.mockResolvedValue({ text: 'ok' })

    await runDueTasks(async () => {})

    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    const opts = runAgentSpy.mock.calls[0]?.[1]
    expect(opts).toMatchObject({
      permissionMode: 'bypassPermissions',
      chatId: '42',
    })
  })

  it('swallows errors thrown by the sender (network to Telegram flaking) — still updates next_run', async () => {
    mockTasks.push(makeTask('t3'))
    runAgentSpy.mockResolvedValue({ text: 'ok' })
    const send = vi.fn().mockRejectedValue(new Error('telegram down'))

    await runDueTasks(send)

    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it('processes multiple due tasks independently — one failure does not block the rest', async () => {
    mockTasks.push(makeTask('a'), makeTask('b'), makeTask('c'))
    runAgentSpy.mockImplementation(async () => {
      const call = runAgentSpy.mock.calls.length
      if (call === 2) throw new Error('middle one failed')
      return { text: `run ${call}` }
    })
    const send = async () => {}

    await runDueTasks(send)

    expect(updateSpy).toHaveBeenCalledTimes(3)
    const ids = updateSpy.mock.calls.map((c) => c[0])
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})
