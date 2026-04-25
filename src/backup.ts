import fs from 'node:fs'
import path from 'node:path'
import { STORE_DIR } from './config.js'
import { backupDatabase, verifyBackup, type BackupVerification } from './db.js'
import { logger } from './logger.js'
import { recordEvent } from './metrics.js'

const BACKUPS_SUBDIR = 'backups'
const BACKUP_FILENAME_RE = /^claudeclaw-[\dT:-]+\.db$/

export interface BackupResult {
  path: string
  sizeBytes: number
  verification: BackupVerification
}

export function backupsDir(): string {
  return path.join(STORE_DIR, BACKUPS_SUBDIR)
}

export function createAndVerifyBackup(): BackupResult {
  const dir = backupsDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const destPath = path.join(dir, `claudeclaw-${stamp}.db`)
  backupDatabase(destPath, dir)
  const verification = verifyBackup(destPath)
  const sizeBytes = fs.statSync(destPath).size
  return { path: destPath, sizeBytes, verification }
}

export interface RotationResult {
  requested: number
  removed: number
  failed: number
}

export function rotateBackups(keep: number): RotationResult {
  const dir = backupsDir()
  if (!fs.existsSync(dir)) return { requested: 0, removed: 0, failed: 0 }
  const files = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((f) => ({
      name: f,
      full: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
  const toRemove = files.slice(Math.max(0, keep))
  let removed = 0
  let failed = 0
  for (const f of toRemove) {
    try {
      fs.unlinkSync(f.full)
      removed++
    } catch (err) {
      failed++
      logger.warn({ err, file: f.name }, 'failed to remove old backup')
    }
  }
  return { requested: toRemove.length, removed, failed }
}

export function initBackupSchedule(intervalHours: number, keep: number): NodeJS.Timeout {
  const intervalMs = intervalHours * 60 * 60 * 1000
  const run = () => {
    try {
      const result = createAndVerifyBackup()
      const rotation = rotateBackups(keep)
      recordEvent('backup_ok')
      const logFn =
        rotation.failed > 0 ? logger.warn.bind(logger) : logger.info.bind(logger)
      logFn(
        {
          path: result.path,
          sizeBytes: result.sizeBytes,
          schemaVersion: result.verification.schemaVersion,
          memories: result.verification.memories,
          rotation,
        },
        'scheduled backup ok',
      )
    } catch (err) {
      recordEvent('backup_fail')
      logger.error({ err }, 'scheduled backup FAILED')
    }
  }
  setTimeout(run, 30_000)
  return setInterval(run, intervalMs)
}
