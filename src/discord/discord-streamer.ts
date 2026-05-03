import { logger } from '../logger.js'

const EDIT_INTERVAL_MS = 2000
const DISCORD_MAX_LENGTH = 1900

interface DiscordMessage {
  edit(text: string): Promise<unknown>
}

interface DiscordChannel {
  send(text: string): Promise<DiscordMessage>
}

export class DiscordStreamer {
  private buffer = ''
  private inToolUse = false
  private message?: DiscordMessage
  private channel?: DiscordChannel
  private editTimer?: NodeJS.Timeout
  private dead = false

  async start(channel: DiscordChannel): Promise<void> {
    this.channel = channel
    try {
      this.message = await channel.send('⏳')
    } catch (err) {
      logger.warn({ err }, 'discord-streamer: failed to send placeholder')
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
    if (!this.message) return

    const effectiveText = text ?? (this.buffer || null)
    if (!effectiveText?.trim()) {
      const notice = aborted ? '🛑 Остановлено (без текста)' : '✅ Готово (без текста)'
      try { await this.message.edit(notice) } catch { /* ignore */ }
      return
    }

    const prefix = aborted ? '🛑 Остановлено\n\n' : ''
    const full = prefix + effectiveText
    const chunks = this.splitDiscord(full)

    try {
      await this.message.edit(chunks[0])
    } catch (err) {
      logger.warn({ err }, 'discord-streamer: final edit failed')
    }
    for (const chunk of chunks.slice(1)) {
      try { await this.channel?.send(chunk) } catch { /* ignore */ }
    }
  }

  private async editNow(): Promise<void> {
    if (this.dead || !this.message || !this.buffer) return
    let display = this.buffer
    if (display.length > DISCORD_MAX_LENGTH) display = display.slice(-DISCORD_MAX_LENGTH)
    const draftText = display + (this.inToolUse ? '...' : '')
    try {
      await this.message.edit(draftText)
    } catch (err: unknown) {
      if (!String(err).includes('not modified')) {
        logger.warn({ err }, 'discord-streamer: edit failed')
      }
    }
  }

  private splitDiscord(text: string): string[] {
    if (text.length <= DISCORD_MAX_LENGTH) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > DISCORD_MAX_LENGTH) {
      let cut = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH)
      if (cut < DISCORD_MAX_LENGTH * 0.5) cut = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH)
      if (cut < 0) cut = DISCORD_MAX_LENGTH
      chunks.push(remaining.slice(0, cut))
      remaining = remaining.slice(cut).replace(/^\s+/, '')
    }
    if (remaining) chunks.push(remaining)
    return chunks
  }
}
