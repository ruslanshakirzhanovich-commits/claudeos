import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, it, expect } from 'vitest'
import { buildDeployCommand, deployLogPath, readDeployLogTail } from '../src/commands/update.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-update-cmd-'))

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('deployLogPath', () => {
  it('returns <storeDir>/deploy.log so the log lives outside the systemd PrivateTmp', () => {
    expect(deployLogPath('/home/claw/claudeclaw/store')).toBe(
      '/home/claw/claudeclaw/store/deploy.log',
    )
  })
})

describe('buildDeployCommand', () => {
  it('wraps the script in sudo systemd-run --scope so it survives systemctl restart', () => {
    const { cmd, args } = buildDeployCommand(
      '/home/claw/claudeclaw/scripts/deploy.sh',
      1_700_000_000_000,
    )

    expect(cmd).toBe('sudo')
    // --scope puts the child in its own transient cgroup; --collect cleans
    // the unit up after exit so old scopes don't pile up; --unit makes the
    // scope name deterministic per-timestamp so we can inspect it in
    // `systemctl list-units --scope`.
    expect(args).toEqual([
      'systemd-run',
      '--scope',
      '--collect',
      '--unit',
      'claudeclaw-deploy-1700000000000',
      'bash',
      '/home/claw/claudeclaw/scripts/deploy.sh',
    ])
  })

  it('uses the current timestamp if none is passed', () => {
    const before = Date.now()
    const { args } = buildDeployCommand('/x.sh')
    const after = Date.now()

    const unitArg = args[args.indexOf('--unit') + 1]
    expect(unitArg).toMatch(/^claudeclaw-deploy-\d+$/)
    const ts = Number(unitArg!.slice('claudeclaw-deploy-'.length))
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

describe('readDeployLogTail', () => {
  let storeDir: string
  let logFile: string

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(tmpDir, 'store-'))
    logFile = path.join(storeDir, 'deploy.log')
  })

  it('returns the last N lines of deploy.log', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(logFile, lines.join('\n'))

    const out = await readDeployLogTail(storeDir, 5)
    expect(out.split('\n')).toEqual(['line 36', 'line 37', 'line 38', 'line 39', 'line 40'])
  })

  it('returns the full file if the file has fewer lines than maxLines', async () => {
    fs.writeFileSync(logFile, 'only\nthree\nlines')
    const out = await readDeployLogTail(storeDir, 100)
    expect(out.split('\n')).toEqual(['only', 'three', 'lines'])
  })

  it('returns a clear placeholder when the log does not exist yet', async () => {
    // Fresh storeDir, no deploy has ever run.
    const out = await readDeployLogTail(storeDir, 100)
    expect(out).toMatch(/no deploy log yet/i)
  })

  it('caps returned bytes so a runaway deploy log cannot blow past Telegram limits', async () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `line-${i}`).join('\n')
    fs.writeFileSync(logFile, huge)
    const out = await readDeployLogTail(storeDir, 500)
    // Telegram caps at 4096 chars per message. Our helper should stay well
    // under that so the caller can prepend a header without splitting.
    expect(out.length).toBeLessThanOrEqual(3_500)
  })
})
