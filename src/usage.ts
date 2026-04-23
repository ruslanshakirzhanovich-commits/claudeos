import type Database from 'better-sqlite3'
import { getDb } from './db.js'

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  contextWindow: number
  compactions: number
  updatedAt: number
}

interface ModelUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  contextWindow: number
}

interface Row {
  usage_input_tokens: number | null
  usage_output_tokens: number | null
  usage_cache_read: number | null
  usage_cache_create: number | null
  usage_context_window: number | null
  usage_compactions: number | null
  usage_updated_at: number | null
}

function read(db: InstanceType<typeof Database>, chatId: string): Row | undefined {
  return db
    .prepare(
      `SELECT usage_input_tokens, usage_output_tokens, usage_cache_read, usage_cache_create,
              usage_context_window, usage_compactions, usage_updated_at
         FROM chat_preferences WHERE chat_id = ?`,
    )
    .get(chatId) as Row | undefined
}

export function recordUsage(chatId: string, usage: ModelUsageLike): void {
  const db = getDb()
  const prior = read(db, chatId)
  const compactions = prior?.usage_compactions ?? 0
  db.prepare(
    `INSERT INTO chat_preferences (
       chat_id, usage_input_tokens, usage_output_tokens, usage_cache_read, usage_cache_create,
       usage_context_window, usage_compactions, usage_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       usage_input_tokens = excluded.usage_input_tokens,
       usage_output_tokens = excluded.usage_output_tokens,
       usage_cache_read = excluded.usage_cache_read,
       usage_cache_create = excluded.usage_cache_create,
       usage_context_window = excluded.usage_context_window,
       usage_updated_at = excluded.usage_updated_at`,
  ).run(
    chatId,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
    usage.contextWindow,
    compactions,
    Date.now(),
  )
}

export function recordCompaction(chatId: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO chat_preferences (chat_id, usage_compactions, usage_updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       usage_compactions = COALESCE(usage_compactions, 0) + 1,
       usage_updated_at = excluded.usage_updated_at`,
  ).run(chatId, Date.now())
}

export function resetUsage(chatId: string): void {
  getDb()
    .prepare(
      `UPDATE chat_preferences SET
         usage_input_tokens = NULL,
         usage_output_tokens = NULL,
         usage_cache_read = NULL,
         usage_cache_create = NULL,
         usage_context_window = NULL,
         usage_compactions = 0,
         usage_updated_at = NULL
       WHERE chat_id = ?`,
    )
    .run(chatId)
}

export function getUsage(chatId: string): SessionUsage | null {
  const row = read(getDb(), chatId)
  if (!row || row.usage_updated_at === null) {
    if (row && row.usage_compactions && row.usage_compactions > 0) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        contextWindow: 0,
        compactions: row.usage_compactions,
        updatedAt: 0,
      }
    }
    return null
  }
  return {
    inputTokens: row.usage_input_tokens ?? 0,
    outputTokens: row.usage_output_tokens ?? 0,
    cacheReadTokens: row.usage_cache_read ?? 0,
    cacheCreateTokens: row.usage_cache_create ?? 0,
    contextWindow: row.usage_context_window ?? 0,
    compactions: row.usage_compactions ?? 0,
    updatedAt: row.usage_updated_at,
  }
}
