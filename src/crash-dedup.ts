const CRASH_DEDUP_WINDOW_MS = 5 * 60 * 1000
const CRASH_DEDUP_MAX_ENTRIES = 100
const recentCrashes = new Map<string, number>()

export function crashSignature(kind: string, err: unknown): string {
  const stack = (err as Error)?.stack ?? String(err)
  return `${kind}::${stack.slice(0, 200)}`
}

export function shouldNotifyCrash(
  kind: string,
  err: unknown,
  now: number = Date.now(),
): boolean {
  const sig = crashSignature(kind, err)
  const last = recentCrashes.get(sig)
  if (last !== undefined && now - last < CRASH_DEDUP_WINDOW_MS) return false
  // Move-to-end on insertion: delete-then-set so JS Map's insertion-order
  // iteration acts as LRU for the eviction step below.
  recentCrashes.delete(sig)
  recentCrashes.set(sig, now)
  if (recentCrashes.size > CRASH_DEDUP_MAX_ENTRIES) {
    const oldestKey = recentCrashes.keys().next().value
    if (oldestKey !== undefined) recentCrashes.delete(oldestKey)
  }
  return true
}

export function resetCrashDedupForTest(): void {
  recentCrashes.clear()
}
