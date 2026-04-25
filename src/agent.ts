import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  PROJECT_ROOT,
  CLAUDE_MODEL,
  AGENT_RETRY_ATTEMPTS,
  AGENT_RETRY_BASE_MS,
  AGENT_MAX_TURNS,
  AGENT_STREAM_TIMEOUT_MS,
} from './config.js'
import { logger, type Logger } from './logger.js'
import { recordEvent } from './metrics.js'
import { effortToThinkingTokens, isEffortLevel } from './effort.js'
import { recordUsage, recordCompaction } from './usage.js'
import { withRetry, isTransientError } from './retry.js'

export interface AgentResult {
  text: string | null
  newSessionId?: string
}

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan'

export interface RunAgentOptions {
  sessionId?: string
  onTyping?: () => void
  permissionMode: PermissionMode
  log?: Logger
  model?: string
  effort?: string
  chatId?: string
}

// CLAUDE.md is loaded by the SDK itself from settingSources (['project','user']).
// Injecting it into the user prompt would double the tokens and defeat the
// automatic system-prompt cache. Only the per-request model override needs to
// be appended.
function buildSystemPrompt(activeModel: string | undefined): {
  type: 'preset'
  preset: 'claude_code'
  append?: string
} {
  if (!activeModel) return { type: 'preset', preset: 'claude_code' }
  return {
    type: 'preset',
    preset: 'claude_code',
    append: `You are currently running as model id: ${activeModel}. When the user asks about your model, respond with this exact id.`,
  }
}

export async function runAgent(message: string, opts: RunAgentOptions): Promise<AgentResult> {
  if (!opts || !opts.permissionMode) {
    throw new Error('runAgent: permissionMode is required (no implicit bypassPermissions)')
  }
  // streamStarted is flipped inside runAgentInner as soon as the SDK emits
  // any event. After that point a tool call may already have fired and a
  // retry would be non-idempotent, so shouldRetry pins to false.
  let streamStarted = false
  const attempt = () => {
    streamStarted = false
    return runAgentInner(message, opts, () => {
      streamStarted = true
    })
  }
  return withRetry(attempt, {
    attempts: AGENT_RETRY_ATTEMPTS,
    baseMs: AGENT_RETRY_BASE_MS,
    label: 'runAgent',
    log: opts.log ?? logger,
    shouldRetry: (err) => !streamStarted && isTransientError(err),
  })
}

async function runAgentInner(
  message: string,
  opts: RunAgentOptions,
  onStreamStart: () => void,
): Promise<AgentResult> {
  const { sessionId, onTyping, permissionMode, log = logger, model, effort, chatId } = opts
  const effectiveModel = model || CLAUDE_MODEL || undefined
  const effectiveEffort = isEffortLevel(effort) ? effort : undefined

  const typingTimer = onTyping ? setInterval(() => onTyping(), 4000) : null
  const abortController = new AbortController()
  const timeoutTimer = setTimeout(() => abortController.abort(), AGENT_STREAM_TIMEOUT_MS)

  let text: string | null = null
  let newSessionId: string | undefined

  try {
    const options: Record<string, unknown> = {
      cwd: PROJECT_ROOT,
      settingSources: ['project', 'user'],
      permissionMode,
      systemPrompt: buildSystemPrompt(effectiveModel),
      maxTurns: AGENT_MAX_TURNS,
      abortController,
    }
    if (sessionId) options['resume'] = sessionId
    if (effectiveModel) options['model'] = effectiveModel
    if (effectiveEffort) options['maxThinkingTokens'] = effortToThinkingTokens(effectiveEffort)

    const stream = query({ prompt: message, options: options as any })

    for await (const event of stream as AsyncIterable<any>) {
      onStreamStart()
      if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
        newSessionId = event.session_id
      } else if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
        if (chatId) recordCompaction(chatId)
      } else if (event?.type === 'result') {
        text = typeof event.result === 'string' ? event.result : (event.result?.result ?? null)
        if (!newSessionId && event.session_id) newSessionId = event.session_id
        if (chatId && event.modelUsage) {
          const entries = Object.values(event.modelUsage) as Array<{
            inputTokens: number
            outputTokens: number
            cacheReadInputTokens: number
            cacheCreationInputTokens: number
            contextWindow: number
          }>
          if (entries.length > 0) {
            const agg = entries.reduce(
              (a, b) => ({
                inputTokens: a.inputTokens + b.inputTokens,
                outputTokens: a.outputTokens + b.outputTokens,
                cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
                cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
                contextWindow: Math.max(a.contextWindow, b.contextWindow),
              }),
              {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                contextWindow: 0,
              },
            )
            recordUsage(chatId, agg)
          }
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'runAgent failed')
    recordEvent('agent_error')
    throw err
  } finally {
    if (typingTimer) clearInterval(typingTimer)
    clearTimeout(timeoutTimer)
  }

  recordEvent('agent_success')
  return { text, newSessionId }
}
