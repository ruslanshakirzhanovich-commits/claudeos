import http from 'node:http'
import { afterEach, describe, it, expect } from 'vitest'
import { startHealthServer, type HealthStatusSource } from '../src/health.js'

function fetchJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null })
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

let stop: (() => Promise<void>) | null = null

afterEach(async () => {
  if (stop) await stop()
  stop = null
})

describe('health endpoint', () => {
  it('responds 200 with a JSON snapshot from the status source', async () => {
    const source: HealthStatusSource = () => ({
      ok: true,
      uptimeSec: 42,
      version: '1.4.0',
      schemaVersion: 9,
      channels: { telegram: 'ok', discord: 'disabled', whatsapp: 'disabled' },
    })
    const server = await startHealthServer({ host: '127.0.0.1', port: 0, source })
    stop = server.stop

    const res = await fetchJson(server.port, '/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      uptimeSec: 42,
      version: '1.4.0',
      schemaVersion: 9,
      channels: { telegram: 'ok' },
    })
  })

  it('responds 503 when the source reports ok=false', async () => {
    const source: HealthStatusSource = () => ({
      ok: false,
      uptimeSec: 1,
      version: '0',
      schemaVersion: 0,
      channels: {},
      reason: 'db unavailable',
    })
    const server = await startHealthServer({ host: '127.0.0.1', port: 0, source })
    stop = server.stop

    const res = await fetchJson(server.port, '/health')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ ok: false, reason: 'db unavailable' })
  })

  it('serves a minimal /ready probe for liveness checks', async () => {
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      source: () => ({ ok: true, uptimeSec: 0, version: '0', schemaVersion: 0, channels: {} }),
    })
    stop = server.stop

    const res = await fetchJson(server.port, '/ready')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('returns 404 for unknown paths', async () => {
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      source: () => ({ ok: true, uptimeSec: 0, version: '0', schemaVersion: 0, channels: {} }),
    })
    stop = server.stop

    const res = await fetchJson(server.port, '/something-else')
    expect(res.status).toBe(404)
  })
})
