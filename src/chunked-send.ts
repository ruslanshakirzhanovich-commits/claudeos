import { withRetry } from './retry.js'
import type { Logger } from './logger.js'

export async function sendAllChunksOrMark(
  chunks: string[],
  send: (text: string) => Promise<void>,
  log: Logger,
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    try {
      await withRetry(() => send(chunks[i]!), {
        attempts: 3,
        baseMs: 250,
        label: 'send-chunk',
        log,
      })
    } catch (err) {
      log.error({ err, sentChunks: i, totalChunks: chunks.length }, 'send failed mid-chunk')
      try {
        await send(`[…truncated: ${chunks.length - i} chunk(s) lost]`)
      } catch {
        /* marker also failed — error log above already records it */
      }
      return
    }
  }
}
