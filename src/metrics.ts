const HOUR_MS = 60 * 60 * 1000

type EventKind =
  | 'agent_success'
  | 'agent_error'
  | 'scheduler_skip'
  | 'scheduler_run'
  | 'scheduler_missed'
  | 'scheduler_hang'
  | 'backup_ok'
  | 'backup_fail'

const totals: Record<EventKind, number> = {
  agent_success: 0,
  agent_error: 0,
  scheduler_skip: 0,
  scheduler_run: 0,
  scheduler_missed: 0,
  scheduler_hang: 0,
  backup_ok: 0,
  backup_fail: 0,
}

const recent: Record<EventKind, number[]> = {
  agent_success: [],
  agent_error: [],
  scheduler_skip: [],
  scheduler_run: [],
  scheduler_missed: [],
  scheduler_hang: [],
  backup_ok: [],
  backup_fail: [],
}

interface LastIncident {
  at: number
  kind: string
  message: string
}

let lastCrash: LastIncident | null = null
let lastBackupAt: number | null = null

export function recordEvent(kind: EventKind): void {
  totals[kind]++
  const arr = recent[kind]
  const now = Date.now()
  arr.push(now)
  const cutoff = now - HOUR_MS
  while (arr.length > 0 && arr[0]! < cutoff) arr.shift()
  if (kind === 'backup_ok') lastBackupAt = now
}

export function recordCrash(kind: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  lastCrash = { at: Date.now(), kind, message: message.slice(0, 500) }
}

export interface HealthSnapshot {
  counters: Record<EventKind, { total: number; lastHour: number }>
  lastCrash: LastIncident | null
  lastBackupAt: number | null
}

export function snapshot(): HealthSnapshot {
  const out: HealthSnapshot['counters'] = {} as HealthSnapshot['counters']
  const now = Date.now()
  const cutoff = now - HOUR_MS
  for (const kind of Object.keys(totals) as EventKind[]) {
    const arr = recent[kind]
    while (arr.length > 0 && arr[0]! < cutoff) arr.shift()
    out[kind] = { total: totals[kind], lastHour: arr.length }
  }
  return { counters: out, lastCrash, lastBackupAt }
}
