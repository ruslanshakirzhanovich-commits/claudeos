import { describe, it, expect } from 'vitest'
import { recordEvent, recordCrash, snapshot } from '../src/metrics.js'

describe('metrics', () => {
  it('counts events per kind', () => {
    const before = snapshot().counters.agent_success.total
    recordEvent('agent_success')
    recordEvent('agent_success')
    recordEvent('agent_error')
    const s = snapshot()
    expect(s.counters.agent_success.total).toBe(before + 2)
    expect(s.counters.agent_success.lastHour).toBeGreaterThanOrEqual(2)
    expect(s.counters.agent_error.lastHour).toBeGreaterThanOrEqual(1)
  })

  it('records last crash with kind and message', () => {
    recordCrash('uncaughtException', new Error('kaboom'))
    const s = snapshot()
    expect(s.lastCrash).not.toBeNull()
    expect(s.lastCrash?.kind).toBe('uncaughtException')
    expect(s.lastCrash?.message).toContain('kaboom')
    expect(s.lastCrash?.at).toBeLessThanOrEqual(Date.now())
  })

  it('updates lastBackupAt on backup_ok', () => {
    const before = snapshot().lastBackupAt
    recordEvent('backup_ok')
    const after = snapshot().lastBackupAt
    expect(after).not.toBeNull()
    expect(after).toBeGreaterThanOrEqual(before ?? 0)
  })
})
