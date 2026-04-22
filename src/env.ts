import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as dotenvParse } from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

export function readEnvFile(keys?: string[]): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!fs.existsSync(envPath)) return {}

  let parsed: Record<string, string>
  try {
    parsed = dotenvParse(fs.readFileSync(envPath))
  } catch {
    return {}
  }

  if (keys && keys.length) {
    const filtered: Record<string, string> = {}
    for (const k of keys) if (k in parsed) filtered[k] = parsed[k]!
    return filtered
  }
  return parsed
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
