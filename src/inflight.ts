import { logger } from './logger.js'

const inflight = new Set<Promise<unknown>>()

export function trackInflight<T>(promise: Promise<T>): Promise<T> {
  inflight.add(promise)
  promise.finally(() => inflight.delete(promise)).catch(() => {})
  return promise
}

export function inflightCount(): number {
  return inflight.size
}

export async function waitForInflight(timeoutMs: number): Promise<number> {
  if (inflight.size === 0) return 0
  logger.info({ count: inflight.size, timeoutMs }, 'waiting for inflight work to drain')
  const start = Date.now()
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const drain = Promise.allSettled([...inflight]).then(() => 'drained' as const)
  const result = await Promise.race([timeout, drain])
  if (timer) clearTimeout(timer)
  const elapsed = Date.now() - start
  if (result === 'timeout') {
    logger.warn({ remaining: inflight.size, elapsedMs: elapsed }, 'inflight drain timed out')
    return inflight.size
  }
  logger.info({ elapsedMs: elapsed }, 'inflight drained cleanly')
  return 0
}
