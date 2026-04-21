import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

export function readEnvFile(keys?: string[]): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!fs.existsSync(envPath)) return {}

  const out: Record<string, string> = {}
  let raw: string
  try {
    raw = fs.readFileSync(envPath, 'utf8')
  } catch {
    return {}
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }

  if (keys && keys.length) {
    const filtered: Record<string, string> = {}
    for (const k of keys) if (k in out) filtered[k] = out[k]!
    return filtered
  }
  return out
}

export function writeEnvFile(values: Record<string, string>): void {
  const envPath = path.join(PROJECT_ROOT, '.env')
  const existing = readEnvFile()
  const merged = { ...existing, ...values }
  const lines: string[] = []
  for (const [k, v] of Object.entries(merged)) {
    const needsQuote = /\s|["'#]/.test(v)
    lines.push(needsQuote ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`)
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8')
}
