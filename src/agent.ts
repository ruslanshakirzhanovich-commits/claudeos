import fs from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, CLAUDE_MD_PATH, CLAUDE_MODEL } from './config.js'
import { logger, type Logger } from './logger.js'
import { trackInflight } from './inflight.js'
import { runSerialPerChat } from './chat-queue.js'
import { recordEvent } from './metrics.js'
import { effortToThinkingTokens, isEffortLevel } from './effort.js'
import { recordUsage, recordCompaction } from './usage.js'

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

function loadClaudeMd(): string {
  try {
    return fs.readFileSync(CLAUDE_MD_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

function wrapWithClaudeMd(userMessage: string, activeModel: string | undefined): string {
  const claudeMd = loadClaudeMd()
  const parts: string[] = []
  if (activeModel) {
    parts.push(
      `You are currently running as model id: ${activeModel}. When the user asks about your model, respond with this exact id.`,
    )
  }
  if (claudeMd) {
    parts.push(
      'You MUST follow these instructions at all times, this is your identity and personality:',
      '',
      claudeMd,
    )
  }
  if (parts.length === 0) return userMessage
  return parts.join('\n\n') + '\n\n---\nUser message:\n' + userMessage
}

export async function runAgent(
  message: string,
  opts: RunAgentOptions,
): Promise<AgentResult> {
  if (!opts || !opts.permissionMode) {
    throw new Error('runAgent: permissionMode is required (no implicit bypassPermissions)')
  }
  const run = () => trackInflight(runAgentInner(message, opts))
  if (opts.chatId) return runSerialPerChat(opts.chatId, run)
  return run()
}

async function runAgentInner(
  message: string,
  opts: RunAgentOptions,
): Promise<AgentResult> {
  const { sessionId, onTyping, permissionMode, log = logger, model, effort, chatId } = opts
  const effectiveModel = model || CLAUDE_MODEL || undefined
  const wrapped = wrapWithClaudeMd(message, effectiveModel)
  const effectiveEffort = isEffortLevel(effort) ? effort : undefined

  const typingTimer = onTyping ? setInterval(() => onTyping(), 4000) : null

  let text: string | null = null
  let newSessionId: string | undefined

  try {
    const options: Record<string, unknown> = {
      cwd: PROJECT_ROOT,
      settingSources: ['project', 'user'],
      permissionMode,
    }
    if (sessionId) options['resume'] = sessionId
    if (effectiveModel) options['model'] = effectiveModel
    if (effectiveEffort) options['maxThinkingTokens'] = effortToThinkingTokens(effectiveEffort)

    const stream = query({ prompt: wrapped, options: options as any })

    for await (const event of stream as AsyncIterable<any>) {
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
              { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 0 },
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
  }

  recordEvent('agent_success')
  return { text, newSessionId }
}
