import { describe, it, expect } from 'vitest'
import {
  EFFORT_LEVELS,
  effortLabel,
  effortDescription,
  effortToThinkingTokens,
  isEffortLevel,
} from '../src/effort.js'

describe('effort helpers', () => {
  it('has a stable ordered list of 4 levels', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('isEffortLevel accepts known levels and rejects everything else', () => {
    for (const lvl of EFFORT_LEVELS) expect(isEffortLevel(lvl)).toBe(true)
    expect(isEffortLevel('max')).toBe(false)
    expect(isEffortLevel('LOW')).toBe(false)
    expect(isEffortLevel('')).toBe(false)
    expect(isEffortLevel(null)).toBe(false)
    expect(isEffortLevel(undefined)).toBe(false)
    expect(isEffortLevel(42)).toBe(false)
  })

  it('effortToThinkingTokens returns a strictly increasing budget', () => {
    let prev = 0
    for (const lvl of EFFORT_LEVELS) {
      const tokens = effortToThinkingTokens(lvl)
      expect(tokens).toBeGreaterThan(prev)
      expect(tokens).toBeGreaterThanOrEqual(1024)
      prev = tokens
    }
  })

  it('labels and descriptions are non-empty for every level', () => {
    for (const lvl of EFFORT_LEVELS) {
      expect(effortLabel(lvl).length).toBeGreaterThan(0)
      expect(effortDescription(lvl).length).toBeGreaterThan(0)
    }
  })
})
