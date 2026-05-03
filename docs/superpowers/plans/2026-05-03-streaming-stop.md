# Streaming + /stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time streaming of Claude's responses to Telegram and Discord, plus a `/stop` command to abort an in-progress generation.

**Architecture:** Callback-based — `onTextDelta` and `onToolUse` callbacks thread from the channel handler through `runChatPipeline` into `runAgent`. Each channel owns a `Streamer` that sends a placeholder message, edits it every 2 seconds with accumulated text, and does a final formatted edit on completion. An `AbortController` per active chat is stored in a module-level Map; `/stop` calls `abort()` on it.

**Tech Stack:** TypeScript, grammy (Telegram), discord.js (Discord), Node 22 (`AbortSignal`), vitest

---

## File Map

**New files:**
- `src/telegram-streamer.ts` — `TelegramStreamer`, `escapeHtml`, `extractCodeBlocks`
- `src/discord/discord-streamer.ts` — `DiscordStreamer`
- `src/commands/stop.ts` — `/stop` command registration
- `tests/telegram-streamer.test.ts` — unit tests for TelegramStreamer
- `tests/discord-streamer.test.ts` — unit tests for DiscordStreamer
- `tests/stop-command.test.ts` — unit tests for /stop

**Modified files:**
- `src/agent.ts` — add `onTextDelta`, `onToolUse`, external `abortController` to `RunAgentOptions`
- `src/chat-pipeline.ts` — pass new fields through to `runAgent`
- `src/bot.ts` — create `activeAgents` Map, wire `TelegramStreamer`, register `/stop`
- `src/discord/types.ts` — add `DiscordSendReturning`, `DiscordEditMessage` types
- `src/discord/handler.ts` — wire `DiscordStreamer`
- `src/discord/index.ts` — implement new streaming callbacks

---

## Task 1: agent.ts — streaming callbacks + external AbortController

**Files:**
- Modify: `src/agent.ts`
- Modify: `tests/agent-stream-e2e.test.ts` (add tests at the bottom)

- [ ] **Step 1: Write failing tests for text delta and tool use callbacks**

Append to the bottom of `tests/agent-stream-e2e.test.ts`, before the closing `})`:

```typescript
  it('fires onTextDelta for each stream_event text_delta', async () => {
    querySpy.mockReturnValue(
      recordedStream([
        { type: 'system', subtype: 'init', session_id: 'sess-d' },
        { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello ' } } },
        { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'world' } } },
        { type: 'result', result: 'Hello world', session_id: 'sess-d' },
      ]),
    )

    const deltas: string[] = []
    await runAgent('hi', {
      permissionMode: 'plan',
      chatId: 'chat-e2e',
      onTextDelta: (d) => deltas.push(d),
    })
    expect(deltas).toEqual(['Hello ', 'world'])
  })

  it('fires onToolUse for tool_use blocks in assistant events', async () => {
    querySpy.mockReturnValue(
      recordedStream([
        { type: 'system', subtype: 'init', session_id: 'sess-t' },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash' }] },
        },
        { type: 'result', result: 'done', session_id: 'sess-t' },
      ]),
    )

    const tools: string[] = []
    await runAgent('hi', {
      permissionMode: 'plan',
      chatId: 'chat-e2e',
      onToolUse: (name) => tools.push(name),
    })
    expect(tools).toEqual(['Bash'])
  })

  it('aborts early when external AbortController is aborted', async () => {
    const externalCtrl = new AbortController()
    querySpy.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-ab' }
        externalCtrl.abort()
        // SDK would normally throw AbortError after signal fires;
        // simulate by checking signal in a loop
        await new Promise<never>((_, reject) => {
          if (externalCtrl.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      },
    })

    await expect(
      runAgent('hi', { permissionMode: 'plan', chatId: 'chat-e2e', abortController: externalCtrl }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /root/claudeos-dev && npx vitest run tests/agent-stream-e2e.test.ts 2>&1 | tail -20
```

Expected: 3 new tests FAIL (callbacks not implemented, AbortError not wired).

- [ ] **Step 3: Update `RunAgentOptions` in `src/agent.ts`**

Add three fields after `chatId?`:

```typescript
  chatId?: string
  onTextDelta?: (delta: string) => void
  onToolUse?: (toolName: string) => void
  abortController?: AbortController
```

- [ ] **Step 4: Update `runAgentInner` to relay external abort and fire callbacks**

Replace the `abortController` + `timeoutTimer` block (lines 83–84) and add event handlers.

Old code at lines 83–84:
```typescript
  const abortController = new AbortController()
  const timeoutTimer = setTimeout(() => abortController.abort(), AGENT_STREAM_TIMEOUT_MS)
```

Replace with:
```typescript
  const internalAbort = new AbortController()
  const timeoutTimer = setTimeout(() => internalAbort.abort(), AGENT_STREAM_TIMEOUT_MS)
  if (opts.abortController) {
    opts.abortController.signal.addEventListener('abort', () => internalAbort.abort(), { once: true })
  }
```

Then find `abortController,` inside the `options` object (around line 96) and replace:
```typescript
      abortController,
```
with:
```typescript
      abortController: internalAbort,
```

Now add event handlers inside the `for await` loop, right after `onStreamStart()`:

Find this block (lines 105–109):
```typescript
      onStreamStart()
      if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
        newSessionId = event.session_id
      } else if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
```

Replace with:
```typescript
      onStreamStart()
      if (event?.type === 'stream_event') {
        const delta = event?.event?.delta
        if (delta?.type === 'text_delta' && typeof delta?.text === 'string' && delta.text) {
          opts.onTextDelta?.(delta.text)
        }
      } else if (event?.type === 'assistant') {
        for (const block of (event?.message?.content ?? []) as Array<{ type?: string; name?: string }>) {
          if (block?.type === 'tool_use') {
            opts.onToolUse?.(block?.name ?? 'tool')
          }
        }
      } else if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
        newSessionId = event.session_id
      } else if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd /root/claudeos-dev && npx vitest run tests/agent-stream-e2e.test.ts 2>&1 | tail -20
```

Expected: all tests PASS (including the 3 new ones).

- [ ] **Step 6: Run full test suite to catch regressions**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

Expected: all passing.

- [ ] **Step 7: Commit**

```bash
cd /root/claudeos-dev && git add src/agent.ts tests/agent-stream-e2e.test.ts && git commit -m "feat(agent): add onTextDelta/onToolUse callbacks and external AbortController"
```

---

## Task 2: chat-pipeline.ts — pass-through

**Files:**
- Modify: `src/chat-pipeline.ts`

- [ ] **Step 1: Add new optional fields to `ChatTurnInput`**

In `src/chat-pipeline.ts`, after the `log: Logger` field in the `ChatTurnInput` interface, add:

```typescript
  onTextDelta?: (delta: string) => void
  onToolUse?: (toolName: string) => void
  abortController?: AbortController
```

- [ ] **Step 2: Thread the fields into `runAgent`**

Find the `runAgent(messageForAgent, {` call and add the three fields:

Old:
```typescript
      const { text, newSessionId } = await runAgent(messageForAgent, {
        sessionId,
        permissionMode: input.permissionMode,
        log: input.log,
        model,
        effort,
        chatId: input.chatId,
      })
```

New:
```typescript
      const { text, newSessionId } = await runAgent(messageForAgent, {
        sessionId,
        permissionMode: input.permissionMode,
        log: input.log,
        model,
        effort,
        chatId: input.chatId,
        onTextDelta: input.onTextDelta,
        onToolUse: input.onToolUse,
        abortController: input.abortController,
      })
```

- [ ] **Step 3: Run tests to verify nothing broke**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

Expected: all passing.

- [ ] **Step 4: Commit**

```bash
cd /root/claudeos-dev && git add src/chat-pipeline.ts && git commit -m "feat(pipeline): thread streaming callbacks and AbortController through ChatTurnInput"
```

---

## Task 3: TelegramStreamer

**Files:**
- Create: `src/telegram-streamer.ts`
- Create: `tests/telegram-streamer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/telegram-streamer.test.ts`:

```typescript
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
    expect(editMessageText).toHaveBeenCalledWith('123', 42, '✅ Готово (без текста)', undefined)
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /root/claudeos-dev && npx vitest run tests/telegram-streamer.test.ts 2>&1 | tail -20
```

Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/telegram-streamer.ts`**

```typescript
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
    if (code.length <= threshold) return _m
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
        await this.api.editMessageText(this.chatIdStr, this.messageId, notice, undefined)
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
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /root/claudeos-dev && npx vitest run tests/telegram-streamer.test.ts 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 5: Run full test suite**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
cd /root/claudeos-dev && git add src/telegram-streamer.ts tests/telegram-streamer.test.ts && git commit -m "feat: add TelegramStreamer with escapeHtml and extractCodeBlocks"
```

---

## Task 4: /stop command

**Files:**
- Create: `src/commands/stop.ts`
- Create: `tests/stop-command.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/stop-command.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({
  isAuthorised: (chatId: string) => chatId === 'allowed-chat',
}))

// We test the logic directly without a real bot, by calling the handler
// that registerStop would register.
async function simulateStop(
  chatId: string,
  activeAgents: Map<string, AbortController>,
): Promise<string> {
  let reply = ''
  const ctx = {
    chat: { id: chatId },
    reply: (text: string) => { reply = text; return Promise.resolve() },
  }
  // Import and invoke directly
  const { handleStopCommand } = await import('../src/commands/stop.js')
  await handleStopCommand(ctx as any, activeAgents)
  return reply
}

beforeEach(() => vi.resetModules())

describe('handleStopCommand', () => {
  it('replies "Ничего не запущено" when no active agent', async () => {
    const reply = await simulateStop('allowed-chat', new Map())
    expect(reply).toBe('Ничего не запущено.')
  })

  it('calls abort and replies 🛑 when agent is active', async () => {
    const ctrl = new AbortController()
    const abortSpy = vi.spyOn(ctrl, 'abort')
    const map = new Map([['allowed-chat', ctrl]])
    const reply = await simulateStop('allowed-chat', map)
    expect(abortSpy).toHaveBeenCalled()
    expect(reply).toContain('🛑')
  })

  it('does nothing for unauthorised chat', async () => {
    const ctrl = new AbortController()
    const abortSpy = vi.spyOn(ctrl, 'abort')
    const map = new Map([['banned-chat', ctrl]])
    const reply = await simulateStop('banned-chat', map)
    expect(abortSpy).not.toHaveBeenCalled()
    expect(reply).toBe('')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd /root/claudeos-dev && npx vitest run tests/stop-command.test.ts 2>&1 | tail -15
```

Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/commands/stop.ts`**

```typescript
import type { Context } from 'grammy'
import { isAuthorised } from '../db.js'

export async function handleStopCommand(
  ctx: Context,
  activeAgents: Map<string, AbortController>,
): Promise<void> {
  const chatId = String(ctx.chat?.id ?? '')
  if (!isAuthorised(chatId)) return
  const ctrl = activeAgents.get(chatId)
  if (!ctrl) {
    await ctx.reply('Ничего не запущено.')
    return
  }
  ctrl.abort()
  await ctx.reply('🛑 Останавливаю...')
}

export function registerStop(
  bot: { command: (cmd: string, handler: (ctx: Context) => Promise<void>) => void },
  activeAgents: Map<string, AbortController>,
): void {
  bot.command('stop', (ctx) => handleStopCommand(ctx, activeAgents))
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd /root/claudeos-dev && npx vitest run tests/stop-command.test.ts 2>&1 | tail -15
```

Expected: all PASS.

- [ ] **Step 5: Run full suite**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
cd /root/claudeos-dev && git add src/commands/stop.ts tests/stop-command.test.ts && git commit -m "feat: add /stop command to abort in-progress agent calls"
```

---

## Task 5: Wire streaming into bot.ts

**Files:**
- Modify: `src/bot.ts`

- [ ] **Step 1: Add imports at the top of bot.ts**

After the existing imports, add:

```typescript
import { TelegramStreamer } from './telegram-streamer.js'
import { registerStop } from './commands/stop.js'
```

- [ ] **Step 2: Add `activeAgents` map at module level**

After the `openModeWarnedChats` Set declaration (around line 74), add:

```typescript
const activeAgents = new Map<string, AbortController>()
```

- [ ] **Step 3: Rewrite `handleMessageInner` to use TelegramStreamer**

Replace the entire body of `handleMessageInner` from the typing indicator setup through `sendResponse` (lines 136–187) with:

```typescript
  touchAllowedChat(chatId)
  const memoryText = opts.memoryText ?? agentInput
  log.info({ preview: memoryText.slice(0, 80) }, 'message received')

  await ctx.replyWithChatAction('typing').catch(() => {})

  const wantVoice = (opts.forceVoice || getTtsEnabled(chatId)) && voiceCapabilities().tts

  // Voice path: skip streaming, keep typing indicator (TTS needs the full text first)
  if (wantVoice) {
    const sendTyping = nonOverlapping(async () => {
      await ctx.replyWithChatAction('typing').catch(() => {})
    })
    const typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS)
    try {
      const result = await runChatPipeline({
        chatId,
        userMessage: memoryText,
        wrappedUserMessage: agentInput,
        permissionMode: isAdmin(chatId) ? 'bypassPermissions' : 'plan',
        log,
      })
      if (result.kind === 'rate-limited') {
        await ctx.reply(rateLimitMessage(result.retryAfterMs)).catch(() => {})
        return
      }
      if (result.kind === 'error') {
        log.error({ err: result.error }, 'handleMessage failed')
        await ctx.reply(`Error: ${result.error.message.slice(0, 500)}`).catch(() => {})
        return
      }
      const text = result.text
      if (text) {
        try {
          await ctx.replyWithChatAction('record_voice').catch(() => {})
          const { audio, truncated } = await synthesizeSpeech(text)
          await ctx.replyWithVoice(new InputFile(audio, 'voice.ogg'))
          if (truncated) await sendResponse(ctx, text)
        } catch (err) {
          log.warn({ err }, 'TTS failed, falling back to text')
          await sendResponse(ctx, text)
        }
      } else {
        await ctx.reply('(no output)').catch(() => {})
      }
    } finally {
      clearInterval(typingInterval)
    }
    return
  }

  // Streaming text path
  const abortController = new AbortController()
  activeAgents.set(chatId, abortController)
  const streamer = new TelegramStreamer()
  await streamer.start(ctx.api, chatId)

  try {
    const result = await runChatPipeline({
      chatId,
      userMessage: memoryText,
      wrappedUserMessage: agentInput,
      permissionMode: isAdmin(chatId) ? 'bypassPermissions' : 'plan',
      log,
      onTextDelta: (d) => streamer.onText(d),
      onToolUse: () => streamer.onToolUse(),
      abortController,
    })

    if (result.kind === 'rate-limited') {
      await streamer.finalize(null)
      await ctx.reply(rateLimitMessage(result.retryAfterMs)).catch(() => {})
      return
    }
    if (result.kind === 'error') {
      log.error({ err: result.error }, 'handleMessage failed')
      await streamer.finalize(null)
      await ctx.reply(`Error: ${result.error.message.slice(0, 500)}`).catch(() => {})
      return
    }

    await streamer.finalize(result.text)
  } catch (err) {
    if (abortController.signal.aborted) {
      await streamer.finalize(null, true)
    } else {
      log.error({ err }, 'handleMessage failed')
      await streamer.finalize(null)
      await ctx.reply(`Error: ${(err as Error).message?.slice(0, 500) ?? 'Unknown error'}`).catch(() => {})
    }
  } finally {
    activeAgents.delete(chatId)
  }
```

- [ ] **Step 4: Register /stop in `createBot()`**

In `createBot()`, after all `register*` calls (around the area where `registerVersion`, `registerVoice`, etc. are called), add:

```typescript
  registerStop(bot, activeAgents)
```

Also add `'stop'` to the bot command list if there's a `setMyCommands` call, or leave it — the command works without listing.

- [ ] **Step 5: Build and check types**

```bash
cd /root/claudeos-dev && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 6: Run full test suite**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

Expected: all passing.

- [ ] **Step 7: Commit**

```bash
cd /root/claudeos-dev && git add src/bot.ts && git commit -m "feat(bot): wire TelegramStreamer and /stop command for real-time streaming"
```

---

## Task 6: DiscordStreamer

**Files:**
- Create: `src/discord/discord-streamer.ts`
- Create: `tests/discord-streamer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/discord-streamer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
```

- [ ] **Step 2: Run — verify it fails**

```bash
cd /root/claudeos-dev && npx vitest run tests/discord-streamer.test.ts 2>&1 | tail -15
```

Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/discord/discord-streamer.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /root/claudeos-dev && npx vitest run tests/discord-streamer.test.ts 2>&1 | tail -15
```

- [ ] **Step 5: Run full suite**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
cd /root/claudeos-dev && git add src/discord/discord-streamer.ts tests/discord-streamer.test.ts && git commit -m "feat: add DiscordStreamer for real-time Discord response streaming"
```

---

## Task 7: Wire DiscordStreamer into Discord handler

**Files:**
- Modify: `src/discord/types.ts`
- Modify: `src/discord/handler.ts`
- Modify: `src/discord/index.ts`

- [ ] **Step 1: Add streaming callback types to `src/discord/types.ts`**

Append to the end of the file:

```typescript
// edit() is captured in closure over the sent Message — no re-fetch needed per edit.
export type DiscordSendReturning = (
  channelId: string,
  text: string,
) => Promise<{ id: string; edit: (newText: string) => Promise<void> }>

export interface DiscordStreamingCallbacks {
  sendReturning: DiscordSendReturning
  sendNew: (channelId: string, text: string) => Promise<void>
}
```

- [ ] **Step 2: Update `handleDiscordMessage` signature and implementation in `src/discord/handler.ts`**

Add import at the top:
```typescript
import { DiscordStreamer } from './discord-streamer.js'
```

Add `streaming?: DiscordStreamingCallbacks` as the 4th parameter to both `handleDiscordMessage` and `handleDiscordMessageInner`, and add `DiscordStreamingCallbacks` to the import from `./types.js`.

Replace `handleDiscordMessageInner` body from the typing indicator block to the end of `try` with:

```typescript
  const chatId = chatIdForDiscordUser(msg.userId)
  if (isOpenMode()) {
    log.warn({ author: msg.authorTag }, 'OPEN MODE accepted new discord chat')
    addUserChat({
      chatId,
      channel: 'discord',
      addedBy: 'open-mode',
      note: `auto-added from ${msg.authorTag}`,
    })
  }
  log.info({ preview: msg.text.slice(0, 80) }, 'message received')

  const typingSafe = sendTyping ? (id: string) => sendTyping(id).catch(() => {}) : undefined
  if (typingSafe) await typingSafe(msg.channelId)

  const permissionMode = isDiscordUserAdmin(msg.userId) ? 'bypassPermissions' : 'plan'
  const wrappedText = wrapUntrusted(msg.text, 'discord_message', { from: msg.authorTag })

  // Streaming path when callbacks are available
  if (streaming) {
    const abortController = new AbortController()
    // Build a minimal channel-like object for DiscordStreamer
    const channelProxy = {
      send: async (text: string) => {
        // sendReturning closes over the Discord Message — edit() is direct, no re-fetch
        const m = await streaming.sendReturning(msg.channelId, text)
        return { edit: m.edit }
      },
    }
    const streamer = new DiscordStreamer()
    await streamer.start(channelProxy as any)

    try {
      const result = await runChatPipeline({
        chatId,
        userMessage: msg.text,
        wrappedUserMessage: wrappedText,
        permissionMode,
        log,
        onTextDelta: (d) => streamer.onText(d),
        onToolUse: () => streamer.onToolUse(),
        abortController,
      })
      if (result.kind === 'rate-limited') {
        await streamer.finalize(null)
        await streaming.sendNew(msg.channelId, rateLimitMessage(result.retryAfterMs))
        return
      }
      if (result.kind === 'error') {
        log.error({ err: result.error }, 'handleDiscordMessage failed')
        await streamer.finalize(null)
        await streaming.sendNew(msg.channelId, `Error: ${result.error.message.slice(0, 500)}`)
        return
      }
      await streamer.finalize(result.text)
    } catch (err) {
      if (abortController.signal.aborted) {
        await streamer.finalize(null, true)
      } else {
        log.error({ err }, 'discord streaming failed')
        await streamer.finalize(null)
        await streaming.sendNew(msg.channelId, `Error: ${(err as Error).message?.slice(0, 500) ?? 'Unknown error'}`)
      }
    }
    return
  }

  // Non-streaming fallback (no streaming callbacks provided)
  const typingInterval = typingSafe
    ? setInterval(() => void typingSafe(msg.channelId), TYPING_REFRESH_MS)
    : null

  try {
    const result = await runChatPipeline({
      chatId,
      userMessage: msg.text,
      wrappedUserMessage: wrappedText,
      permissionMode,
      log,
    })
    if (result.kind === 'rate-limited') {
      await send(msg.channelId, rateLimitMessage(result.retryAfterMs))
      return
    }
    if (result.kind === 'error') {
      log.error({ err: result.error }, 'handleDiscordMessage failed')
      await send(msg.channelId, `Error: ${result.error.message.slice(0, 500)}`)
      return
    }
    const replyText = result.text ?? '(no output)'
    await sendAllChunksOrMark(chunkForDiscord(replyText), (text) => send(msg.channelId, text), log)
  } catch (err) {
    log.error({ err }, 'discord send failed')
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
```

Also update the outer `handleDiscordMessage` to pass `streaming` through:
```typescript
export async function handleDiscordMessage(
  msg: DiscordIncomingMessage,
  send: DiscordSendReply,
  sendTyping?: DiscordSendTyping,
  streaming?: DiscordStreamingCallbacks,
): Promise<void> {
  return trackInflight(handleDiscordMessageInner(msg, send, sendTyping, streaming))
}
```

- [ ] **Step 3: Implement streaming callbacks in `src/discord/index.ts`**

In the `client.on(Events.MessageCreate, ...)` handler, after building the `send` callback and `sendTyping` callback, build a `streaming` object and pass it as the 4th arg to `handler(...)`:

Find the `await handler(` call and replace it with:

```typescript
          type SendableCh = { send: (t: string) => Promise<{ id: string; edit: (t: string) => Promise<unknown> }> }
          const fetchSendable = async (channelId: string): Promise<SendableCh | null> => {
            if (!client) return null
            const ch = await client.channels.fetch(channelId)
            if (ch && 'send' in ch && typeof (ch as SendableCh).send === 'function') {
              return ch as SendableCh
            }
            return null
          }
          const streaming: import('./types.js').DiscordStreamingCallbacks = {
            sendReturning: async (channelId, text) => {
              const ch = await fetchSendable(channelId)
              if (!ch) return { id: '', edit: async () => {} }
              const m = await ch.send(text)
              // Close over `m` so edit() calls m.edit() directly without re-fetching
              return { id: m.id, edit: (newText: string) => m.edit(newText).then(() => {}) }
            },
            sendNew: async (channelId, text) => {
              const ch = await fetchSendable(channelId)
              if (ch) await ch.send(text)
            },
          }
          await handler(
            { userId: m.author.id, channelId: m.channelId, text: m.content, isDM: m.channel.type === ChannelType.DM, messageId: m.id, authorTag: m.author.tag },
            async (channelId: string, text: string) => {
              if (!client) return
              const ch = await client.channels.fetch(channelId)
              if (ch && 'send' in ch && typeof (ch as { send?: unknown }).send === 'function') {
                await (ch as { send: (t: string) => Promise<unknown> }).send(text)
              }
            },
            async (channelId: string) => {
              if (!client) return
              const ch = await client.channels.fetch(channelId)
              if (ch && 'sendTyping' in ch && typeof (ch as { sendTyping?: unknown }).sendTyping === 'function') {
                await (ch as { sendTyping: () => Promise<unknown> }).sendTyping()
              }
            },
            streaming,
          )
```

- [ ] **Step 4: Build TypeScript — check for errors**

```bash
cd /root/claudeos-dev && npx tsc --noEmit 2>&1 | head -40
```

Fix any type errors before proceeding.

- [ ] **Step 5: Run full test suite**

```bash
cd /root/claudeos-dev && npx vitest run 2>&1 | tail -10
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
cd /root/claudeos-dev && git add src/discord/types.ts src/discord/handler.ts src/discord/index.ts && git commit -m "feat(discord): wire DiscordStreamer for real-time streaming"
```

---

## Task 8: Final check

- [ ] **Step 1: Run full check (typecheck + lint + format + tests)**

```bash
cd /root/claudeos-dev && npm run check 2>&1 | tail -20
```

Expected: all passing. Fix any lint/format issues:
```bash
cd /root/claudeos-dev && npx prettier --write src/telegram-streamer.ts src/discord/discord-streamer.ts src/commands/stop.ts
```

- [ ] **Step 2: Build production artifact**

```bash
cd /root/claudeos-dev && npm run build 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 3: Final commit if any formatting fixes were made**

```bash
cd /root/claudeos-dev && git add -p && git commit -m "style: prettier format streaming files"
```
