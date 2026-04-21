import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { GROQ_API_KEY } from './config.js'
import { logger } from './logger.js'

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return { stt: Boolean(GROQ_API_KEY), tts: false }
}

export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set')

  let sendPath = filePath
  if (sendPath.toLowerCase().endsWith('.oga')) {
    const ogg = sendPath.replace(/\.oga$/i, '.ogg')
    fs.renameSync(sendPath, ogg)
    sendPath = ogg
  }

  const fileBuffer = fs.readFileSync(sendPath)
  const filename = path.basename(sendPath)
  const boundary = `----claudeclaw${Date.now()}${Math.random().toString(36).slice(2)}`

  const parts: Buffer[] = []
  const pushField = (name: string, value: string) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    )
  }
  pushField('model', 'whisper-large-v3')
  pushField('response_format', 'json')

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`,
      'utf8',
    ),
  )
  parts.push(fileBuffer)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))

  const body = Buffer.concat(parts)

  const response: string = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(raw)
          } else {
            reject(new Error(`Groq STT ${res.statusCode}: ${raw}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  try {
    const parsed = JSON.parse(response) as { text?: string }
    return parsed.text?.trim() ?? ''
  } catch (err) {
    logger.warn({ err, response }, 'Groq STT response parse failed')
    return ''
  }
}
