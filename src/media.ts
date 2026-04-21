import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { UPLOADS_DIR } from './config.js'
import { logger } from './logger.js'

export function ensureUploadsDir(): void {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
}

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (err) {
            reject(err)
          }
        })
      })
      .on('error', reject)
  })
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          fs.unlinkSync(dest)
          downloadBinary(res.headers.location, dest).then(resolve, reject)
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      })
      .on('error', (err) => {
        file.close()
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
        reject(err)
      })
  })
}

export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string,
): Promise<string> {
  ensureUploadsDir()

  const info = await fetchJson(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  )
  if (!info?.ok || !info?.result?.file_path) {
    throw new Error(`getFile failed: ${JSON.stringify(info)}`)
  }

  const remotePath = info.result.file_path as string
  const baseName = sanitizeName(originalFilename ?? path.basename(remotePath))
  const localPath = path.join(UPLOADS_DIR, `${Date.now()}_${baseName}`)
  const url = `https://api.telegram.org/file/bot${botToken}/${remotePath}`
  await downloadBinary(url, localPath)
  return localPath
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const prefix = caption ? `${caption}\n\n` : ''
  return `${prefix}[User sent a photo. Local path: ${localPath}. Read it with your vision tools or analyze as needed.]`
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  const prefix = caption ? `${caption}\n\n` : ''
  return `${prefix}[User sent a document: ${filename}. Local path: ${localPath}. Read it with your file tools.]`
}

export function cleanupOldUploads(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return
    const now = Date.now()
    for (const entry of fs.readdirSync(UPLOADS_DIR)) {
      const full = path.join(UPLOADS_DIR, entry)
      try {
        const stat = fs.statSync(full)
        if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full)
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'cleanupOldUploads failed')
  }
}
