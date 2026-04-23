import { CLAUDE_DEFAULT_EFFORT } from './config.js'

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

export function effortToThinkingTokens(level: EffortLevel): number {
  switch (level) {
    case 'low':
      return 2_048
    case 'medium':
      return 8_192
    case 'high':
      return 24_576
    case 'xhigh':
      return 65_536
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
