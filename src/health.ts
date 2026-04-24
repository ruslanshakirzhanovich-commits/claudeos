import http from 'node:http'
import { logger } from './logger.js'

export interface HealthStatus {
  ok: boolean
  uptimeSec: number
  version: string
  schemaVersion: number
  channels: Record<string, 'ok' | 'disabled' | 'down' | 'unknown'>
  reason?: string
}

export type HealthStatusSource = () => HealthStatus

export interface HealthServer {
  port: number
  stop: () => Promise<void>
}

export interface StartHealthOptions {
  host: string
  port: number
  source: HealthStatusSource
}

// Tiny HTTP server on a localhost-only port so systemd / k8s / uptime
// monitors can probe the bot without shelling into the process. No auth:
// bind stays on 127.0.0.1 unless the operator opts into an external host.
export async function startHealthServer(opts: StartHealthOptions): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'

    if (url === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url === '/health') {
      let status: HealthStatus
      try {
        status = opts.source()
      } catch (err) {
        logger.warn({ err }, 'health source threw')
        status = {
          ok: false,
          uptimeSec: 0,
          version: 'unknown',
          schemaVersion: 0,
          channels: {},
          reason: 'status source failed',
        }
      }
      res.writeHead(status.ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
