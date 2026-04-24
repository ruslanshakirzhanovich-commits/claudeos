import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT } from './config.js'

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function readGitCommit(): string {
  const fromEnv = process.env.CLAUDECLAW_GIT_COMMIT
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().slice(0, 7)
  try {
    const out = execFileSync('git', ['-C', PROJECT_ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim()
  } catch {
    return 'unknown'
  }
}

export const BOT_VERSION = readPackageVersion()
export const BOT_COMMIT = readGitCommit()
