import { getDb } from './db.js'
import { logger } from './logger.js'

export interface MaintenanceResult {
  vacuumMs: number
  analyzeMs: number
  sizeBytes: number
}

export function runMaintenance(): MaintenanceResult {
  const db = getDb()
  const t0 = Date.now()
  db.exec('VACUUM')
  const vacuumMs = Date.now() - t0
  const t1 = Date.now()
  db.exec('ANALYZE')
  const analyzeMs = Date.now() - t1
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0
  const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 0
  const sizeBytes = pageCount * pageSize
  logger.info({ vacuumMs, analyzeMs, sizeBytes }, 'maintenance complete')
  return { vacuumMs, analyzeMs, sizeBytes }
}

export function initMaintenanceSchedule(intervalHours: number): NodeJS.Timeout {
  const intervalMs = intervalHours * 60 * 60 * 1000
  // Stagger the first run six hours after boot so it doesn't collide with
  // the 30-second-after-boot backup or the 24-hour decay sweep.
  const initialDelayMs = 6 * 60 * 60 * 1000
  const tick = (): void => {
    try {
      runMaintenance()
    } catch (err) {
      logger.error({ err }, 'maintenance failed')
    }
  }
  setTimeout(tick, initialDelayMs)
  return setInterval(tick, intervalMs)
}
