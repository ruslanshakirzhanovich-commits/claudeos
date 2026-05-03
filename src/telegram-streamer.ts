import { InputFile, type Api } from 'grammy'
import { formatForTelegram, splitMessage } from './format.js'
import { logger } from './logger.js'

const EDIT_INTERVAL_MS = 2000
const MAX_DRAFT_LENGTH = 4000
const CODE_BLOCK_THRESHOLD = 500

const LANG_EXT: Record<string, string> = {
  python: 'py', javascript: 'js', typescript: 'ts',
  bash: 'sh', shell: 'sh', json: 'json', yaml: 'yaml',
  html: 'html', css: 'css', sql: 'sql', go: 'go',
  rust: 'rs', java: 'java', cpp: 'cpp', c: 'c',
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function extractCodeBlocks(
  text: string,
  threshold = CODE_BLOCK_THRESHOLD,
): { text: string; files: Array<{ filename: string; content: string }> } {
  const files: Array<{ filename: string; content: string }> = []
  const result = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    if (code.length < threshold) return _m
    const ext = LANG_EXT[(lang ?? '').toLowerCase()] ?? 'txt'
    const filename = `code_${files.length + 1}.${ext}`
    files.push({ filename, content: code })
    return `[код отправлен файлом: ${filename}]`
  })
  return { text: result, files }
}

export class TelegramStreamer {
  private buffer = ''
  private inToolUse = false
  private messageId?: number
  private chatIdStr?: string
  private editTimer?: NodeJS.Timeout
  private api?: Api
  private dead = false

  async start(api: Api, chatId: string | number): Promise<void> {
    this.api = api
    this.chatIdStr = String(chatId)
    try {
      const msg = await api.sendMessage(this.chatIdStr, '⏳', undefined)
      this.messageId = msg.message_id
    } catch (err) {
      logger.warn({ err }, 'streamer: failed to send placeholder')
      return
    }
    this.editTimer = setInterval(() => void this.editNow(), EDIT_INTERVAL_MS)
  }

  onText(delta: string): void {
    this.buffer += delta
    this.inToolUse = false
  }

  onToolUse(): void {
    this.inToolUse = true
  }

  async finalize(text: string | null, aborted = false): Promise<void> {
    this.dead = true
    if (this.editTimer) {
      clearInterval(this.editTimer)
      this.editTimer = undefined
    }
    if (!this.api || !this.messageId || !this.chatIdStr) return

    const effectiveText = text ?? (this.buffer || null)

    if (!effectiveText?.trim()) {
      const notice = aborted ? '🛑 Остановлено (без текста)' : '✅ Готово (без текста)'
      try {
        await this.api.editMessageText(this.chatIdStr, this.messageId, notice)
      } catch {
        await this.api.sendMessage(this.chatIdStr, notice).catch(() => {})
      }
      return
    }

    const prefix = aborted ? '🛑 <i>Остановлено</i>\n\n' : ''
    const { text: stripped, files } = extractCodeBlocks(effectiveText)
    const formatted = prefix + formatForTelegram(stripped)
    const chunks = splitMessage(formatted)

    try {
      await this.api.editMessageText(this.chatIdStr, this.messageId, chunks[0], {
        parse_mode: 'HTML',
      })
    } catch (err: unknown) {
      if (!String(err).includes('message is not modified')) {
        logger.warn({ err }, 'streamer: final edit failed, sending new')
        await this.api.sendMessage(this.chatIdStr, chunks[0], { parse_mode: 'HTML' }).catch(() => {})
      }
    }

    for (const chunk of chunks.slice(1)) {
      await this.api.sendMessage(this.chatIdStr, chunk, { parse_mode: 'HTML' }).catch(() => {})
    }

    for (const file of files) {
      try {
        await this.api.sendDocument(
          this.chatIdStr,
          new InputFile(Buffer.from(file.content, 'utf-8'), file.filename),
        )
      } catch (err) {
        logger.warn({ err, filename: file.filename }, 'streamer: code file send failed')
      }
    }
  }

  async editNow(): Promise<void> {
    if (this.dead || !this.api || !this.messageId || !this.chatIdStr || !this.buffer) return
    let display = this.buffer
    if (display.length > MAX_DRAFT_LENGTH) display = display.slice(-MAX_DRAFT_LENGTH)
    const draftText = escapeHtml(display) + (this.inToolUse ? '...' : '')
    try {
      await this.api.editMessageText(this.chatIdStr, this.messageId, draftText, {
        parse_mode: 'HTML',
      })
    } catch (err: unknown) {
      if (!String(err).includes('message is not modified')) {
        logger.warn({ err }, 'streamer: edit failed')
      }
    }
  }
}
