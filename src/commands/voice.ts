import type { Bot } from 'grammy'
import { isAuthorised, getTtsEnabled, setTtsEnabled } from '../db.js'
import { voiceCapabilities } from '../voice.js'

export function registerVoice(bot: Bot): void {
  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const caps = voiceCapabilities()
    const arg = (ctx.message?.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? 'status'

    if (arg === 'on') {
      if (!caps.tts) {
        await ctx.reply(
          'TTS not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env.',
        )
        return
      }
      setTtsEnabled(chatId, true)
      await ctx.reply('Voice replies: ON')
      return
    }
    if (arg === 'off') {
      setTtsEnabled(chatId, false)
      await ctx.reply('Voice replies: OFF')
      return
    }
    const enabled = getTtsEnabled(chatId)
    const lines = [
      `Voice replies: ${enabled ? 'ON' : 'OFF'}`,
      `TTS available: ${caps.tts ? 'yes' : 'no (ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing)'}`,
      'Usage: /voice on | /voice off | /voice status',
    ]
    await ctx.reply(lines.join('\n'))
  })
}
