import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { spawn } from 'node:child_process'
import {
  GROQ_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  ELEVENLABS_MODEL_ID,
  TTS_MAX_CHARS,
} from './config.js'
import { logger } from './logger.js'
import { withRetry } from './retry.js'

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: Boolean(GROQ_API_KEY),
    tts: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
  }
}

export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncateForSpeech(
  text: string,
  max = TTS_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max).trimEnd() + '…', truncated: true }
}

async function fetchElevenLabsMp3(text: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set')
  if (!ELEVENLABS_VOICE_ID) throw new Error('ELEVENLABS_VOICE_ID is not set')

  const body = JSON.stringify({
    text,
    model_id: ELEVENLABS_MODEL_ID,
    output_format: 'mp3_44100_128',
  })

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`,
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf)
          } else {
            reject(
              new Error(`ElevenLabs TTS ${res.statusCode}: ${buf.toString('utf8').slice(0, 500)}`),
            )
          }
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function mp3ToOggOpus(mp3: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-application',
        'voip',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const out: Buffer[] = []
    const err: Buffer[] = []
    ff.stdout.on('data', (c) => out.push(c))
    ff.stderr.on('data', (c) => err.push(c))
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else
        reject(
          new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString('utf8').slice(-500)}`),
        )
    })

    ff.stdin.on('error', reject)
    ff.stdin.write(mp3)
    ff.stdin.end()
  })
}

export interface SynthesisResult {
  audio: Buffer
  truncated: boolean
  spokenChars: number
}

export async function synthesizeSpeech(text: string): Promise<SynthesisResult> {
  const cleaned = stripMarkdownForSpeech(text)
  if (!cleaned) throw new Error('nothing to speak after stripping markdown')
  const { text: capped, truncated } = truncateForSpeech(cleaned)
  const mp3 = await withRetry(() => fetchElevenLabsMp3(capped), { label: 'elevenlabs-tts' })
  const ogg = await mp3ToOggOpus(mp3)
  return { audio: ogg, truncated, spokenChars: capped.length }
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

  const response: string = await withRetry(
    () =>
      new Promise<string>((resolve, reject) => {
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
      }),
    { label: 'groq-stt' },
  )

  try {
    const parsed = JSON.parse(response) as { text?: string }
    return parsed.text?.trim() ?? ''
  } catch (err) {
    logger.warn({ err, response }, 'Groq STT response parse failed')
    return ''
  }
}
