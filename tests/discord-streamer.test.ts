import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/logger.js', () => {
  const l = { warn: () => {}, debug: () => {} }
  return { logger: l }
})

import { DiscordStreamer } from '../src/discord/discord-streamer.js'

function makeMessage() {
  const editFn = vi.fn().mockResolvedValue({})
  return {
    edit: editFn,
    _editFn: editFn,
  }
}

function makeChannel(messageObj = makeMessage()) {
  return {
    send: vi.fn().mockResolvedValue(messageObj),
    _message: messageObj,
  }
}

describe('DiscordStreamer', () => {
  it('sends placeholder on start', async () => {
    const ch = makeChannel()
    const streamer = new DiscordStreamer()
    await streamer.start(ch as any)
    expect(ch.send).toHaveBeenCalledWith('⏳')
  })

  it('accumulates text and edits on editNow', async () => {
    const ch = makeChannel()
    const streamer = new DiscordStreamer()
    await streamer.start(ch as any)
    streamer.onText('Hello ')
    streamer.onText('world')
    await (streamer as any).editNow()
    expect(ch._message.edit).toHaveBeenCalledWith('Hello world')
  })

  it('appends ... during tool use', async () => {
    const ch = makeChannel()
    const streamer = new DiscordStreamer()
    await streamer.start(ch as any)
    streamer.onText('Thinking')
    streamer.onToolUse()
    await (streamer as any).editNow()
    expect(ch._message.edit).toHaveBeenCalledWith('Thinking...')
  })

  it('finalize edits with final text', async () => {
    const ch = makeChannel()
    const streamer = new DiscordStreamer()
    await streamer.start(ch as any)
    await streamer.finalize('Done!')
    expect(ch._message.edit).toHaveBeenCalledWith('Done!')
  })

  it('finalize aborted=true adds 🛑 prefix', async () => {
    const ch = makeChannel()
    const streamer = new DiscordStreamer()
    await streamer.start(ch as any)
    streamer.onText('Partial')
    await streamer.finalize(null, true)
    const callArg = ch._message.edit.mock.calls[0][0] as string
    expect(callArg).toContain('🛑')
    expect(callArg).toContain('Partial')
  })

  it('finalize null with no buffer shows notice', async () => {
    const ch = makeChannel()
    const streamer = new DiscordStreamer()
    await streamer.start(ch as any)
    await streamer.finalize(null)
    expect(ch._message.edit).toHaveBeenCalledWith('✅ Готово (без текста)')
  })
})
