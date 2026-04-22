import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { WORKSPACE_DIR } from './config.js'
import { logger } from './logger.js'

const PREVIEWS_DIR = path.join(WORKSPACE_DIR, 'previews')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function ensurePreviewsDir(): void {
  if (!fs.existsSync(PREVIEWS_DIR)) fs.mkdirSync(PREVIEWS_DIR, { recursive: true })
}

export function cleanupOldPreviews(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): void {
  try {
    if (!fs.existsSync(PREVIEWS_DIR)) return
    const now = Date.now()
    let removed = 0
    for (const entry of fs.readdirSync(PREVIEWS_DIR)) {
      const full = path.join(PREVIEWS_DIR, entry)
      try {
        const stat = fs.statSync(full)
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true })
          removed++
        }
      } catch {
        /* ignore */
      }
    }
    if (removed > 0) logger.info({ removed }, 'cleanupOldPreviews removed stale preview dirs')
  } catch (err) {
    logger.warn({ err }, 'cleanupOldPreviews failed')
  }
}

function sendStatus(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function resolveSafePath(urlPath: string): string | null {
  try {
    const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
    const cleaned = decoded.replace(/\\/g, '/').replace(/\/+/g, '/')
    const resolved = path.resolve(PREVIEWS_DIR, '.' + cleaned)
    if (resolved !== PREVIEWS_DIR && !resolved.startsWith(PREVIEWS_DIR + path.sep)) {
      return null
    }
    return resolved
  } catch {
    return null
  }
}

function renderIndex(dir: string, urlPath: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const rows = entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((e) => {
      const name = e.isDirectory() ? `${e.name}/` : e.name
      const href = encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '')
      return `<li><a href="${href}">${name}</a></li>`
    })
    .join('\n')
  const parent = urlPath === '/' ? '' : '<li><a href="../">../</a></li>'
  return `<!doctype html>
<meta charset="utf-8">
<title>Previews${urlPath}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
h1{font-size:1rem;color:#555}ul{list-style:none;padding:0}li{padding:.25rem 0}a{text-decoration:none}a:hover{text-decoration:underline}</style>
<h1>Previews ${urlPath}</h1>
<ul>${parent}${rows}</ul>
`
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  const stat = fs.statSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME[ext] ?? 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(filePath).pipe(res)
}

export function createPreviewServer(port: number): http.Server {
  ensurePreviewsDir()

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendStatus(res, 405, 'Method Not Allowed')
      return
    }
    const urlPath = req.url ?? '/'
    const resolved = resolveSafePath(urlPath)
    if (!resolved) {
      sendStatus(res, 400, 'Bad Request')
      return
    }
    if (!fs.existsSync(resolved)) {
      sendStatus(res, 404, 'Not Found')
      return
    }
    try {
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) {
        const indexHtml = path.join(resolved, 'index.html')
        if (fs.existsSync(indexHtml)) {
          serveFile(res, indexHtml)
          return
        }
        const body = renderIndex(resolved, urlPath.split('?')[0] ?? '/')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(body)
        return
      }
      serveFile(res, resolved)
    } catch (err) {
      logger.warn({ err, urlPath }, 'preview-server request failed')
      sendStatus(res, 500, 'Internal Server Error')
    }
  })

  server.listen(port, () => {
    logger.info({ port, dir: PREVIEWS_DIR }, 'preview-server listening')
  })

  return server
}
