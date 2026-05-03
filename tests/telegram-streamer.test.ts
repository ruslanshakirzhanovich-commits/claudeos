import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/format.js', () => ({
  formatForTelegram: (t: string) => `<b>formatted:</b> ${t}`,
  splitMessage: (t: string, limit = 4096) => {
    if (t.length <= limit) return [t]
    const chunks: string[] = []
    let r = t
    while (r.length > limit) { chunks.push(r.slice(0, limit)); r = r.slice(limit) }
    if (r) chunks.push(r)
    return chunks
  },
}))

vi.mock('../src/logger.js', () => {
  const l = { warn: () => {}, debug: () => {} }
  return { logger: l }
})

import { escapeHtml, extractCodeBlocks, TelegramStreamer } from '../src/telegram-streamer.js'

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
  it('leaves normal text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

describe('extractCodeBlocks', () => {
  it('leaves short code blocks in place', () => {
    const short = '```js\nconsole.log("hi")\n```'
    const { text, files } = extractCodeBlocks(short)
    expect(files).toHaveLength(0)
    expect(text).toContain('console.log')
  })

  it('extracts long code blocks as files', () => {
    const longCode = 'x'.repeat(600)
    const input = `before\n\`\`\`typescript\n${longCode}\n\`\`\`\nafter`
    const { text, files } = extractCodeBlocks(input)
    expect(files).toHaveLength(1)
    expect(files[0].filename).toBe('code_1.ts')
    expect(files[0].content).toBe(longCode + '\n')
    expect(text).toContain('[код отправлен файлом: code_1.ts]')
    expect(text).toContain('before')
    expect(text).toContain('after')
  })

  it('maps language to correct extension', () => {
    const longCode = 'y'.repeat(600)
    const { files } = extractCodeBlocks(`\`\`\`python\n${longCode}\n\`\`\``)
    expect(files[0].filename).toBe('code_1.py')
  })

  it('uses .txt for unknown languages', () => {
    const longCode = 'z'.repeat(600)
    const { files } = extractCodeBlocks(`\`\`\`brainfuck\n${longCode}\n\`\`\``)
    expect(files[0].filename).toBe('code_1.txt')
  })
})

describe('TelegramStreamer', () => {
  let sendMessage: ReturnType<typeof vi.fn>
  let editMessageText: ReturnType<typeof vi.fn>
  let sendDocument: ReturnType<typeof vi.fn>
  let api: { sendMessage: typeof sendMessage; editMessageText: typeof editMessageText; sendDocument: typeof sendDocument }

  beforeEach(() => {
    sendMessage = vi.fn().mockResolvedValue({ message_id: 42 })
    editMessageText = vi.fn().mockResolvedValue({})
    sendDocument = vi.fn().mockResolvedValue({})
    api = { sendMessage, editMessageText, sendDocument }
  })

  it('sends placeholder on start', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    expect(sendMessage).toHaveBeenCalledWith('123', '⏳', undefined)
  })

  it('accumulates text via onText', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    streamer.onText('Hello ')
    streamer.onText('world')
    // editNow should show accumulated buffer
    await (streamer as any).editNow()
    expect(editMessageText).toHaveBeenCalledWith('123', 42, 'Hello world', { parse_mode: 'HTML' })
  })

  it('appends ... during tool use', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    streamer.onText('Thinking')
    streamer.onToolUse()
    await (streamer as any).editNow()
    expect(editMessageText).toHaveBeenCalledWith('123', 42, 'Thinking...', { parse_mode: 'HTML' })
  })

  it('clears tool use flag on next onText', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    streamer.onToolUse()
    streamer.onText('Result')
    await (streamer as any).editNow()
    const call = editMessageText.mock.calls[0][2] as string
    expect(call).not.toContain('...')
  })

  it('finalize sends formatted text', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    await streamer.finalize('Final answer')
    expect(editMessageText).toHaveBeenCalledWith('123', 42, '<b>formatted:</b> Final answer', { parse_mode: 'HTML' })
  })

  it('finalize with aborted=true adds stop prefix', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    streamer.onText('Partial text')
    await streamer.finalize(null, true)
    const callArg = editMessageText.mock.calls[0][2] as string
    expect(callArg).toContain('🛑')
    expect(callArg).toContain('Partial text')
  })

  it('finalize with null text and no buffer shows "без текста" notice', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    await streamer.finalize(null)
    expect(editMessageText).toHaveBeenCalledWith('123', 42, '✅ Готово (без текста)')
  })

  it('escapes html in draft', async () => {
    const streamer = new TelegramStreamer()
    await streamer.start(api as any, '123')
    streamer.onText('<script>alert(1)</script>')
    await (streamer as any).editNow()
    const callArg = editMessageText.mock.calls[0][2] as string
    expect(callArg).toContain('&lt;script&gt;')
  })
})
