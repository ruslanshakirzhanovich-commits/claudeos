# Streaming + /stop — Design Spec

**Date:** 2026-05-03
**Scope:** Telegram + Discord channels

## Goal

Show Claude's response as it generates (streaming), instead of waiting for the full result.
Also add `/stop` to abort an in-progress agent call.

## Decisions

- **Edit interval:** 2 seconds (`editMessageText`). Standard Telegram Bot API, no rate-limit risk.
- **Draft loop (`sendMessageDraft`):** Not implemented — non-standard API, grammy doesn't support it.
- **Channels:** Telegram + Discord.
- **During tool calls:** Show accumulated text + `...` at the end.
- **Code blocks >500 chars:** Extracted and sent as separate files (same as vels-claude-light).
- **Draft text:** Plain HTML-escaped text during streaming. Markdown formatting applied only in `finalize()`.

---

## Architecture

```
Telegram/Discord message
    ↓
bot.ts / discord handler
    ├── AbortController (per chat, stored in activeAgents Map)
    ├── TelegramStreamer / DiscordStreamer (instantiated)
    └── runChatPipeline({ onTextDelta, onToolUse, abortController })
            ↓
        runAgent({ onTextDelta, onToolUse, abortController })
            ↓
        SDK event loop:
            stream_event + text_delta  → onTextDelta(delta)
            assistant + tool_use       → onToolUse(toolName)
            result                     → return text
            ↓
        streamer.finalize(text, aborted)
```

---

## Components

### 1. `agent.ts` — minimal changes

Add to `RunAgentOptions`:

```typescript
onTextDelta?: (delta: string) => void
onToolUse?: (toolName: string) => void
abortController?: AbortController
```

Add to event loop inside `runAgentInner`:

```typescript
if (event?.type === 'stream_event') {
  const delta = event?.event?.delta
  if (delta?.type === 'text_delta' && delta?.text) {
    opts.onTextDelta?.(delta.text)
  }
}
if (event?.type === 'assistant') {
  for (const block of event?.message?.content ?? []) {
    if (block?.type === 'tool_use') {
      opts.onToolUse?.(block?.name ?? 'tool')
    }
  }
}
```

External `abortController`: when provided, use `AbortSignal.any([external.signal, timeoutSignal])`
so timeout still fires independently.

### 2. `chat-pipeline.ts` — pass-through only

Add to `ChatTurnInput`:

```typescript
onTextDelta?: (delta: string) => void
onToolUse?: (toolName: string) => void
abortController?: AbortController
```

Thread directly into `runAgent`. No logic changes.

### 3. `src/telegram-streamer.ts` (new file)

```typescript
class TelegramStreamer {
  private buffer = ''
  private inToolUse = false
  private messageId?: number
  private editTimer?: NodeJS.Timeout

  async start(bot: Bot, chatId: string | number): Promise<void>
  // Sends "⏳" placeholder, starts editTimer at 2s interval

  onText(delta: string): void
  // buffer += delta; inToolUse = false

  onToolUse(): void
  // inToolUse = true

  async finalize(text: string | null, aborted?: boolean): Promise<void>
  // Cancels timer
  // Final edit with formatForTelegram(text)
  // text null → "✅ Готово (без текста)"
  // aborted=true → "🛑 Остановлено\n\n" + text (or buffer if text null)
  // Code blocks >500 chars → extracted, sent as sendDocument

  private async editNow(): Promise<void>
  // Edits message with: html.escape(buffer) + ("..." if inToolUse)
  // If buffer > 4000 chars — show last 4000 chars
  // Ignores "message is not modified" errors silently
}
```

**Helper:** `escapeHtml(text: string): string` — escapes `&`, `<`, `>` for Telegram HTML parse mode.

### 4. `src/discord/discord-streamer.ts` (new file)

Same pattern as `TelegramStreamer` but uses Discord.js `message.edit()`.

```typescript
class DiscordStreamer {
  private buffer = ''
  private inToolUse = false
  private message?: Message  // Discord.js Message

  async start(channel: TextChannel | DMChannel): Promise<void>
  // Sends "⏳" placeholder

  onText(delta: string): void
  onToolUse(): void
  async finalize(text: string | null, aborted?: boolean): Promise<void>
  private async editNow(): Promise<void>
  // Discord message limit is 2000 chars
}
```

### 5. `bot.ts` — changes

```typescript
const activeAgents = new Map<string, AbortController>()

// In handleMessageInner:
const abortController = new AbortController()
activeAgents.set(chatId, abortController)
const streamer = new TelegramStreamer()
await streamer.start(bot.api, chatId)

try {
  const result = await runChatPipeline({
    ...,
    onTextDelta: (d) => streamer.onText(d),
    onToolUse: () => streamer.onToolUse(),
    abortController,
  })
  // ... handle rate-limited / error as before
  await streamer.finalize(result.text, false)
} catch (err) {
  // If aborted by /stop — show accumulated text with 🛑, don't show raw error.
  // finalize(null, true) uses internal buffer if non-empty.
  if (abortController.signal.aborted) {
    await streamer.finalize(null, true)
  } else {
    await streamer.finalize(null, false)
    throw err  // non-abort errors still propagate to handleMessageInner error handler
  }
} finally {
  activeAgents.delete(chatId)
  clearInterval(typingInterval)  // keep as fallback for non-streaming turns
}
```

Remove `typingInterval` for normal message flow (streamer replaces it).
Keep `replyWithChatAction('typing')` only for the initial moment before streamer starts.

### 6. `src/commands/stop.ts` (new file)

```typescript
export function registerStop(bot: Bot, activeAgents: Map<string, AbortController>): void {
  bot.command('stop', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!isAuthorised(chatId)) return
    const ctrl = activeAgents.get(chatId)
    if (!ctrl) {
      await ctx.reply('Ничего не запущено.')
      return
    }
    ctrl.abort()
    await ctx.reply('🛑 Останавливаю...')
  })
}
```

`activeAgents` is created in `bot.ts` and passed to `registerStop`.

---

## Error handling

| Case | Behaviour |
|------|-----------|
| `editMessageText` fails (message deleted) | Log warn, stop timer, continue to finalize |
| Agent aborted via `/stop` | `finalize(buffer, aborted=true)` → shows accumulated text with 🛑 prefix |
| Agent timeout | `AbortController.abort()` fires via timeout signal → same as abort |
| No text generated | `finalize(null)` → "✅ Готово (без текста)" |
| SDK event format mismatch (text_delta not found) | Callbacks never fire; falls back to current behaviour (no streaming) |

---

## Out of scope

- `sendMessageDraft` (non-standard API)
- Voice TTS streaming
- Scheduler-triggered messages (no interactive UI to stream into)
- WhatsApp streaming (no message editing API in baileys)
