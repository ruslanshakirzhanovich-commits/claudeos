import fs from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT, CLAUDE_MD_PATH } from './config.js'
import { logger } from './logger.js'

export interface AgentResult {
  text: string | null
  newSessionId?: string
}

function loadClaudeMd(): string {
  try {
    return fs.readFileSync(CLAUDE_MD_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

function wrapWithClaudeMd(userMessage: string): string {
  const claudeMd = loadClaudeMd()
  if (!claudeMd) return userMessage
  return (
    'You MUST follow these instructions at all times, this is your identity and personality:\n\n' +
    claudeMd +
    '\n\n---\nUser message:\n' +
    userMessage
  )
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
): Promise<AgentResult> {
  const wrapped = wrapWithClaudeMd(message)

  const typingTimer = onTyping ? setInterval(() => onTyping(), 4000) : null

  let text: string | null = null
  let newSessionId: string | undefined

  try {
    const options: Record<string, unknown> = {
      cwd: PROJECT_ROOT,
      settingSources: ['project', 'user'],
      permissionMode: 'bypassPermissions',
    }
    if (sessionId) options['resume'] = sessionId

    const stream = query({ prompt: wrapped, options: options as any })

    for await (const event of stream as AsyncIterable<any>) {
      if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
        newSessionId = event.session_id
      } else if (event?.type === 'result') {
        text = typeof event.result === 'string' ? event.result : (event.result?.result ?? null)
        if (!newSessionId && event.session_id) newSessionId = event.session_id
      }
    }
  } catch (err) {
    logger.error({ err }, 'runAgent failed')
    throw err
  } finally {
    if (typingTimer) clearInterval(typingTimer)
  }

  return { text, newSessionId }
}
