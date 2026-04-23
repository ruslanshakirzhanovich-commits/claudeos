import {
  CLAUDE_DEFAULT_EFFORT,
  EFFORT_TOKENS_LOW,
  EFFORT_TOKENS_MEDIUM,
  EFFORT_TOKENS_HIGH,
  EFFORT_TOKENS_XHIGH,
} from './config.js'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh']

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

// Default reasoning budget for Telegram/WhatsApp chat handlers. Scheduler
// tasks and other callers that pass no `effort` inherit from the Claude CLI
// settings file instead (typically xhigh for the admin user).
// Override via CLAUDE_DEFAULT_EFFORT env (low|medium|high|xhigh). Invalid
// values fall back to medium.
export const CHAT_DEFAULT_EFFORT: EffortLevel = isEffortLevel(CLAUDE_DEFAULT_EFFORT)
  ? CLAUDE_DEFAULT_EFFORT
  : 'medium'

// Thinking-token budgets per effort tier. Defaults chosen as a 4× ladder
// (2k → 8k → 24k → 64k) to give a perceptible quality/latency step between
// adjacent levels without overshooting common context windows. Override via
// the EFFORT_TOKENS_* env vars in config.ts.
export function effortToThinkingTokens(level: EffortLevel): number {
  switch (level) {
    case 'low':
      return EFFORT_TOKENS_LOW
    case 'medium':
      return EFFORT_TOKENS_MEDIUM
    case 'high':
      return EFFORT_TOKENS_HIGH
    case 'xhigh':
      return EFFORT_TOKENS_XHIGH
  }
}

export function effortLabel(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
    case 'xhigh':
      return 'Extra high'
  }
}

export function effortDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Fast, minimal reasoning. Good for trivial replies.'
    case 'medium':
      return 'Balanced. Default for everyday questions.'
    case 'high':
      return 'More thinking before answering. Better on complex problems.'
    case 'xhigh':
      return 'Maximum reasoning budget. Slowest and most thorough.'
  }
}
