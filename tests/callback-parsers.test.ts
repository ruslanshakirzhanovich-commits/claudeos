import { describe, it, expect } from 'vitest'
import { parseModelCallback, MODELS } from '../src/commands/models.js'
import { parseEffortCallback } from '../src/commands/effort.js'

describe('parseModelCallback', () => {
  it('returns the choice for a known model id', () => {
    expect(parseModelCallback('model:claude-sonnet-4-6')).toEqual({ choice: 'claude-sonnet-4-6' })
    expect(parseModelCallback('model:claude-haiku-4-5-20251001')).toEqual({
      choice: 'claude-haiku-4-5-20251001',
    })
  })

  it('returns the default choice', () => {
    expect(parseModelCallback('model:default')).toEqual({ choice: 'default' })
  })

  it('rejects unknown model ids — forged payload defense', () => {
    expect(parseModelCallback('model:claude-evil-9-9')).toBeNull()
    expect(parseModelCallback('model:rm-rf')).toBeNull()
    expect(parseModelCallback('model:')).toBeNull()
  })

  it('returns null for non-model: payloads (lets next() fire)', () => {
    expect(parseModelCallback('effort:high')).toBeNull()
    expect(parseModelCallback('something-else')).toBeNull()
    expect(parseModelCallback('')).toBeNull()
    expect(parseModelCallback(undefined)).toBeNull()
    expect(parseModelCallback(null)).toBeNull()
  })

  it('all MODELS are accepted by their canonical id', () => {
    for (const m of MODELS) {
      expect(parseModelCallback(`model:${m.id}`)).toEqual({ choice: m.id })
    }
  })
})

describe('parseEffortCallback', () => {
  it('returns each known effort level', () => {
    expect(parseEffortCallback('effort:low')).toEqual({ choice: 'low' })
    expect(parseEffortCallback('effort:medium')).toEqual({ choice: 'medium' })
    expect(parseEffortCallback('effort:high')).toEqual({ choice: 'high' })
    expect(parseEffortCallback('effort:xhigh')).toEqual({ choice: 'xhigh' })
  })

  it('returns the default choice', () => {
    expect(parseEffortCallback('effort:default')).toEqual({ choice: 'default' })
  })

  it('rejects unknown effort levels — case-sensitive', () => {
    expect(parseEffortCallback('effort:LOW')).toBeNull()
    expect(parseEffortCallback('effort:max')).toBeNull()
    expect(parseEffortCallback('effort:none')).toBeNull()
    expect(parseEffortCallback('effort:')).toBeNull()
  })

  it('returns null for non-effort: payloads', () => {
    expect(parseEffortCallback('model:opus')).toBeNull()
    expect(parseEffortCallback('xxx')).toBeNull()
    expect(parseEffortCallback('')).toBeNull()
    expect(parseEffortCallback(undefined)).toBeNull()
    expect(parseEffortCallback(null)).toBeNull()
  })
})
