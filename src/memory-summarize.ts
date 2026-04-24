import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  listChatsWithStaleEpisodic,
  getStaleEpisodicForChat,
  replaceEpisodicWithSummary,
} from './db.js'
import { PROJECT_ROOT, CLAUDE_MODEL } from './config.js'
import { logger, type Logger } from './logger.js'

export type SummarizeFn = (text: string) => Promise<string>

export interface SummarizeSweepConfig {
  minAgeDays: number
  batch: number
  minBatch: number
}

export interface SummarizeSweepResult {
  chatsProcessed: number
  chatsConsolidated: number
  episodicConsolidated: number
  errors: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function runMemorySummarizeSweep(
  cfg: SummarizeSweepConfig,
  summarize: SummarizeFn,
  log: Logger = logger,
): Promise<SummarizeSweepResult> {
  const cutoffMs = Date.now() - cfg.minAgeDays * DAY_MS
  const chats = listChatsWithStaleEpisodic(cutoffMs, cfg.minBatch)
  const result: SummarizeSweepResult = {
    chatsProcessed: 0,
    chatsConsolidated: 0,
    episodicConsolidated: 0,
    errors: 0,
  }

  for (const chatId of chats) {
    result.chatsProcessed += 1
    const rows = getStaleEpisodicForChat(chatId, cutoffMs, cfg.batch)
    if (rows.length < cfg.minBatch) continue

    const joined = rows.map((r) => r.content).join('\n')
    let summary: string
    try {
      summary = (await summarize(joined)).trim()
    } catch (err) {
      log.warn({ err, chatId }, 'summarize call failed')
      result.errors += 1
      continue
    }
    if (!summary) {
      log.warn({ chatId }, 'summarize returned empty — skipping swap')
      continue
    }

    try {
      const swap = replaceEpisodicWithSummary(
        chatId,
        rows.map((r) => r.id),
        summary,
      )
      result.chatsConsolidated += 1
      result.episodicConsolidated += swap.deleted
    } catch (err) {
      log.warn({ err, chatId }, 'summary swap failed')
      result.errors += 1
    }
  }

  return result
}

// Real summarize backend. Uses the agent SDK in plan mode, without the
// project's settingSources, so the call stays short (no CLAUDE.md
// persona prelude) and can't run tools or touch the filesystem.
export async function summarizeViaAgentSdk(text: string): Promise<string> {
  const prompt = [
    'Below are conversation snippets between a user and their personal AI assistant.',
    'Write a factual 2–3 sentence summary focused on persistent user preferences,',
    'facts, and recurring topics. Omit trivia, one-off tasks, and pleasantries.',
    'Do not address the user directly. Output ONLY the summary, no preamble.',
    '',
    '--- snippets start ---',
    text,
    '--- snippets end ---',
    'Summary:',
  ].join('\n')
  const options: Record<string, unknown> = {
    cwd: PROJECT_ROOT,
    settingSources: [],
    permissionMode: 'plan',
  }
  if (CLAUDE_MODEL) options['model'] = CLAUDE_MODEL

  const stream = query({ prompt, options: options as any })
  let result = ''
  for await (const event of stream as AsyncIterable<any>) {
    if (event?.type === 'result') {
      result =
        typeof event.result === 'string' ? event.result : (event.result?.result ?? '')
    }
  }
  return result.trim()
}
