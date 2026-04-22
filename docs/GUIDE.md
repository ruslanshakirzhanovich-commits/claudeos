# ClaudeOS — Guide

**[English](#english)** · **[Русский](#русский)**

---

<a id="english"></a>

## English

Reference manual for ClaudeOS — what features exist, how they're wired, and how to use them. This is a companion to the [README](../README.md) (installation) and [CHANGELOG](../CHANGELOG.md) (release history).

### 1. Architecture at a glance

```
Telegram  ─┐
           ├──► grammy bot ──► runAgent() ──► Claude Code CLI ──► skills / MCP servers
WhatsApp  ─┘                       │
                                   ▼
                        SQLite (store/claudeclaw.db)
                          • sessions — per-user Claude session resumption
                          • memories — dual-sector (semantic + episodic) with FTS5
                          • scheduled_tasks — cron-like jobs per chat_id
```

- **`src/bot.ts`** — Telegram handlers (text, voice, photo, document, commands)
- **`src/whatsapp/`** — WhatsApp bridge (provider-swappable: baileys now, Meta Cloud API later)
- **`src/agent.ts`** — wraps `@anthropic-ai/claude-agent-sdk`, spawns Claude CLI as subprocess
- **`src/memory.ts`** — dual-sector memory store, injects relevant facts into prompts
- **`src/scheduler.ts`** + **`src/schedule-cli.ts`** — cron-like task scheduler
- **`src/voice.ts`** — Groq Whisper (STT) + ElevenLabs (TTS) + ffmpeg for Opus encoding
- **`src/config.ts`** — single source of truth for env-driven config
- **`.mcp.json`** — project-level MCP servers (Playwright for browser control)

Runtime model: bot process stays up 24/7 via systemd (`claudeclaw.service`). Each Telegram message spawns a short-lived Claude Code session; the `session_id` is cached per `chat_id` so conversations continue across messages.

### 2. Telegram commands

| Command | What it does | Auth-gated |
|---|---|---|
| `/start` | Greeting + your chat ID + current auth state | no |
| `/chatid` | Echoes your chat ID (useful for new users before being whitelisted) | no |
| `/version` | Shows bot version and the latest 2 CHANGELOG entries | no |
| `/newchat` or `/forget` | Clears Claude session for this chat — next message starts fresh | yes |
| `/memory` | Shows how many long-term memories are stored for this chat | yes |
| `/voice on` | Enables voice replies (TTS) for this chat. Requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env` | yes |
| `/voice off` | Disables voice replies | yes |
| `/listusers` | Shows all authorised chats with date added and note | admin only |
| `/adduser <chat_id> [note]` | Whitelists a new chat immediately, no restart needed | admin only |
| `/removeuser <chat_id>` | Removes a chat from whitelist | admin only |
| `/stats` | Bot health: users, memory, scheduler, process RSS/uptime | yes |
| `/backup` | Creates a consistent SQLite copy in `store/backups/` + uploads it to the admin chat if < 50 MB | admin only |
| `/ping` | Quick liveness check — returns pid + uptime | no |

All other messages are treated as prompts: plain text goes straight to Claude, voice notes are transcribed first via Groq Whisper, photos/documents are downloaded and passed to Claude with a local path hint.

### 3. Features and how to enable each

#### 3.1 Multi-user mode

**What:** multiple Telegram chats can talk to the bot; each has isolated memory and its own scheduled tasks.

**How to enable:** list comma-separated chat IDs in `.env`:
```
ALLOWED_CHAT_IDS=110440505,987654321
```
Empty list = allow any chat (first-run mode). Legacy `ALLOWED_CHAT_ID` (singular) still reads as fallback.

**How it works:** every DB query is keyed on `chat_id` (the Telegram chat ID, as string). The check itself is one line in `src/config.ts` (`isAuthorised`). Every handler adds a child logger with `{chatId, userId, username}` so logs show who said what.

#### 3.2 Voice messages in (STT via Groq Whisper)

**What:** you send a Telegram voice note, the bot transcribes it and treats it as text.

**How to enable:** put `GROQ_API_KEY` in `.env`. Key is free at https://console.groq.com.

**UX:** the bot replies with `Heard: "..."` showing what it understood, then runs the transcribed text as a prompt.

#### 3.3 Voice replies (TTS via ElevenLabs)

**What:** bot responses come back as voice messages instead of text.

**How to enable:**
1. `ELEVENLABS_API_KEY=...` in `.env`
2. `ELEVENLABS_VOICE_ID=...` — copy from https://elevenlabs.io/app/voice-library (any voice works)
3. Optional: `ELEVENLABS_MODEL_ID` (`eleven_multilingual_v2` default, `eleven_turbo_v2_5` for faster/cheaper, `eleven_v3` for quality)
4. Optional: `TTS_MAX_CHARS=800` — voice reply is capped at this many characters; if the full reply is longer, it's still sent as text too
5. In Telegram: `/voice on`. Per-chat preference, stored in SQLite.

**Pipeline:** reply text → strip markdown → cap at `TTS_MAX_CHARS` → ElevenLabs MP3 → ffmpeg converts to OGG/Opus (Telegram voice format) → sent.

`ffmpeg` must be installed on the server: `sudo apt install -y ffmpeg`.

#### 3.4 WhatsApp bridge (experimental)

**What:** the bot is reachable via WhatsApp in addition to Telegram.

**How to enable:**
```
WHATSAPP_ENABLED=1
WHATSAPP_PROVIDER=baileys
ALLOWED_WHATSAPP_NUMBERS=491234567,15551234567   # or blank = allow any
```

On first start the bot prints a QR code in the logs (`journalctl -u claudeclaw -f` or `store/whatsapp-qr.png`). Scan it from WhatsApp → Linked devices. After connect, session is persisted in `store/whatsapp-auth/` — restart won't require rescan.

**⚠ Warning:** `baileys` is a reverse-engineered client. WhatsApp can ban numbers for unofficial access. Use a secondary phone number, not your main one. Our code is structured to swap to Meta Cloud API later (under `WHATSAPP_PROVIDER=meta`, not yet implemented) once your business is verified with Meta.

**Architecture:** the bridge lives in `src/whatsapp/`. `handler.ts` is provider-agnostic (accepts `(jid, text, sendReply)` and reuses `runAgent` + memory). Switching to Meta Cloud API means writing a new adapter file — message-handling logic doesn't change.

**V1 scope:** text messages in private chats only. Media, groups, reactions, edits — not yet.

#### 3.4b Video analysis (Gemini skill)

**What:** send the bot a video in Telegram, ask "what's happening here?" — it calls Google's Gemini 2.0 Flash which has native video understanding.

**How to enable:** `GEMINI_API_KEY=...` in `.env`. Get a free key at https://aistudio.google.com/apikey — free tier is generous (1500 req/day).

**Architecture note:** this isn't in bot code — it's a skill file at [`.claude/skills/video-gemini.md`](../.claude/skills/video-gemini.md). When the user sends a video, Claude reads that skill's instructions and drives the Gemini Files API through its own Bash tool. Same pattern we'll use for any future narrow integration.

**Limits:** ~1 hour per video (Gemini token budget), 20 MB if the file comes from Telegram Bot API, 50 MB for documents.

#### 3.4c Frontend preview server

**What:** bot builds a web page on demand and hosts it so you can open it in a browser from any device. "Сделай лендинг про X" → bot replies with a live URL.

**How to enable:**
```
PREVIEW_ENABLED=1
PREVIEW_HOST=<your.public.ip.or.domain>
PREVIEW_PORT=8080
```
Open the port in your firewall (`sudo ufw allow 8080/tcp` if you use ufw). Restart the bot.

**Architecture:** built-in Node HTTP server (no new deps) serves `workspace/previews/`. One skill drives the generation:
- [`.claude/skills/frontend-preview.md`](../.claude/skills/frontend-preview.md) — our skill that picks an aesthetic, generates a self-contained `index.html`, saves to the previews dir, and replies with the live URL.

**Optional — better design quality:** install Anthropic's `frontend-design` plugin under the user that runs the bot. It adds design-thinking guidance (bold aesthetic directions, rejection of "AI slop" patterns) that Claude picks up alongside our skill:
```bash
# dev (as root)
claude plugin install frontend-design@claude-plugins-official

# prod (as claw)
sudo -u claw bash -lc 'claude plugin install frontend-design@claude-plugins-official'
sudo systemctl restart claudeclaw
```
Without it the preview still works — designs are just more likely to trend toward generic defaults.

**Security:** the server is public (0.0.0.0:PORT). Anyone with the URL can see everything in `workspace/previews/`. Don't put secrets there. For private previews you'd need Tailscale (not built in yet).

**Turn it off:** remove `PREVIEW_ENABLED` or set to `0`, restart the bot.

#### 3.5 Browser control (Playwright MCP)

**What:** Claude can open web pages, click, scroll, extract text — full Playwright automation.

**How to enable:**
```bash
npx playwright install chromium          # one-time, ~630MB under $HOME/.cache/ms-playwright
sudo npx playwright install-deps chromium # apt packages, one-time per machine
```

No code in the bot — it's a project-level MCP server defined in `.mcp.json`. Claude Code auto-loads it when our bot spawns Claude with `cwd: PROJECT_ROOT + settingSources: ['project','user']` (see `src/agent.ts`).

**Usage:** message the bot like "open example.com and tell me the h1" — Claude decides when to call `playwright` tools and returns a structured result.

**Cost:** each browsing session launches a Chromium process (~200MB RAM). Processes are ephemeral — spun up per request, torn down after.

#### 3.6 Long-term memory

**What:** the bot remembers facts about you across conversations, even after `/newchat`.

**How it works (automatic — no opt-in needed):**
- Every message > 20 chars that isn't a `/command` is stored.
- Semantic memories (identity, preferences — detected via regex for "I am", "my", "I prefer", etc.) go in one sector; everything else is episodic.
- Relevant memories are auto-fetched via SQLite FTS5 when building the next prompt.
- Every 24h a decay sweep multiplies salience by 0.98; memories below 0.1 are deleted.

**Commands:**
- `/memory` — count of memories for this chat
- Scheduled decay runs automatically, no manual action needed.

#### 3.7 Scheduled tasks

**What:** the bot can fire prompts on a cron schedule. Useful for daily briefings, reminders, monitoring.

**How to use:** CLI only, run as the bot user:
```bash
node dist/schedule-cli.js create "Give me the morning briefing" "0 9 * * *" 110440505
node dist/schedule-cli.js list
node dist/schedule-cli.js pause <id>
node dist/schedule-cli.js resume <id>
node dist/schedule-cli.js delete <id>
node dist/schedule-cli.js show <id>
```

Cron syntax standard (`min hour day month weekday`). Each task runs under its owner's `chat_id` — scheduled responses are sent only to that chat.

### 4. Setup wizard

`npm run setup` — interactive wizard on `@clack/prompts`. What it does:
1. Checks Node ≥ 20 and `claude` CLI availability.
2. Shows existing `.env` values as pre-filled defaults (re-run friendly).
3. Validates Telegram bot token format and pings `getMe` to verify it's real — catches typos immediately.
4. Same live validation for ElevenLabs (`/v1/user` ping).
5. Writes `.env` with `chmod 600`.
6. Runs `npm install` + `npm run build`.
7. Does NOT install systemd service — that's `install.sh`'s job.

Use it whenever you want to change config without hand-editing `.env`.

### 5. Deploy flow (dev → production)

```
[dev: /root/claudeos-dev]                      [prod: /home/claw/claudeclaw]
     │                                               │
     │  npm run build + manual testing               │
     ▼                                               │
   git commit && git push                            │
     │                                               │
     └──► GitHub main ◄────── git pull ──────────────┤
                                                     │
                                                     ▼
                                             npm install
                                             npm run build
                                             sudo systemctl restart claudeclaw
```

**Golden rule:** edit code only in `/root/claudeos-dev`. Production pulls from git. Never edit `/home/claw/claudeclaw/src/*` by hand — that breaks the git-pull model.

**Full prod update command:**
```bash
sudo systemctl stop claudeclaw
sudo -u claw bash -lc 'cd /home/claw/claudeclaw && git pull && npm install && npm run build'
sudo systemctl start claudeclaw
sudo tail -15 /home/claw/claudeclaw/store/claudeclaw.log
```

Downtime: ~1-3 min depending on what `npm install` needs to do.

### 6. Adding a new user

Two paths:

**Runtime (preferred):** as admin, send the bot:
```
/adduser 123456789 Alice from work
```
Done — no restart, no SSH. `/listusers` shows the current whitelist. `/removeuser 123456789` takes them out.

**Static seed (bootstrap only):** `ALLOWED_CHAT_IDS` in `.env` is used to seed the DB on first startup. After the first boot the DB is the source of truth; editing `.env` has no effect unless you wipe `store/claudeclaw.db`. Use this only for fresh installs.

Flow for inviting someone new:
1. They DM `@iifam_bot` and send `/chatid`. Gets `Chat ID: 123456789`.
2. Admin sends `/adduser 123456789 name` in their own chat with the bot.
3. New user can now message the bot.

Memory is isolated per chat_id — your conversations and theirs don't mix.

**Caveat:** skills that use your OAuth credentials (Gmail, Calendar etc.) will run against *your* accounts from their chats. If that's not desired, disable or scope those skills.

### 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot silent to all commands | Service not running | `sudo systemctl status claudeclaw`; check `store/claudeclaw.log` |
| `/version` silent but `/start` works | Running OLD code (before `/version` shipped) | `git pull && npm run build && systemctl restart claudeclaw` |
| `/voice on` says "TTS not configured" | Missing `ELEVENLABS_API_KEY` or `ELEVENLABS_VOICE_ID` in `.env` | Add them, restart service |
| TTS fails with `ffmpeg` error | `ffmpeg` not on PATH | `sudo apt install -y ffmpeg` |
| WhatsApp prints QR every start | `store/whatsapp-auth/` got wiped or corrupted | Re-scan; auth persists from new QR |
| WhatsApp "logged out" | User logged out from phone → linked devices | Delete `store/whatsapp-auth/` and re-scan |
| "unauthorised chat" in logs | Sender's chat ID not in `ALLOWED_CHAT_IDS` | Add it or clear the var (open mode) |
| Memory count stuck at 0 | Messages shorter than 20 chars or all starting with `/` aren't stored | Expected behavior |
| `git pull` fails with permission error | Ownership issue in `.claude/` (ran as root before) | `sudo chown -R claw:claw /home/claw/claudeclaw/.claude` |

**Where to look for logs:**
- `sudo tail -f /home/claw/claudeclaw/store/claudeclaw.log` — application logs (pino JSON)
- `sudo journalctl -u claudeclaw -f` — systemd events (start/stop/crashes only)

---

<a id="русский"></a>

## Русский

Справочник по ClaudeOS — какие фичи есть, как всё устроено, как этим пользоваться. Дополняет [README](../README.md) (установка) и [CHANGELOG](../CHANGELOG.md) (история релизов).

### 1. Архитектура одним взглядом

```
Telegram  ─┐
           ├──► grammy bot ──► runAgent() ──► Claude Code CLI ──► скиллы / MCP серверы
WhatsApp  ─┘                       │
                                   ▼
                        SQLite (store/claudeclaw.db)
                          • sessions — возобновление сессий Claude по юзерам
                          • memories — семантика + эпизодика с FTS5-индексом
                          • scheduled_tasks — крон-задачи по chat_id
```

- **`src/bot.ts`** — Telegram-хендлеры (текст, голос, фото, документы, команды)
- **`src/whatsapp/`** — WhatsApp-мост с провайдер-агностичной структурой (сейчас baileys, потом Meta Cloud API)
- **`src/agent.ts`** — обёртка `@anthropic-ai/claude-agent-sdk`, спавнит Claude CLI как подпроцесс
- **`src/memory.ts`** — двусекторная память, подмешивает релевантные факты в промпты
- **`src/scheduler.ts`** + **`src/schedule-cli.ts`** — планировщик задач (cron-like)
- **`src/voice.ts`** — Groq Whisper (STT) + ElevenLabs (TTS) + ffmpeg для Opus-энкодинга
- **`src/config.ts`** — единственная точка правды для конфига из env
- **`.mcp.json`** — MCP-серверы на уровне проекта (Playwright для управления браузером)

Бот висит 24/7 через systemd (`claudeclaw.service`). На каждое сообщение спавнится короткая сессия Claude Code; `session_id` кэшируется по `chat_id`, чтобы разговоры продолжались через сообщения.

### 2. Команды в Telegram

| Команда | Что делает | Требует авторизации |
|---|---|---|
| `/start` | Приветствие + твой chat ID + состояние авторизации | нет |
| `/chatid` | Возвращает твой chat ID (полезно новым юзерам до добавления в whitelist) | нет |
| `/version` | Версия бота + последние 2 записи из CHANGELOG | нет |
| `/newchat` или `/forget` | Сбрасывает Claude-сессию для этого чата — следующее сообщение начнёт с нуля | да |
| `/memory` | Сколько долгосрочных воспоминаний для этого чата | да |
| `/voice on` | Включает голосовые ответы (TTS). Требует `ELEVENLABS_API_KEY` и `ELEVENLABS_VOICE_ID` в `.env` | да |
| `/voice off` | Отключает голосовые ответы | да |
| `/listusers` | Список авторизованных чатов с датой добавления и note | только admin |
| `/adduser <chat_id> [note]` | Добавляет чат в whitelist мгновенно, без рестарта | только admin |
| `/removeuser <chat_id>` | Удаляет чат из whitelist | только admin |
| `/stats` | Здоровье бота: юзеры, память, планировщик, RSS/uptime процесса | да |
| `/backup` | Консистентная копия SQLite в `store/backups/` + отправка файлом в чат админа если < 50 MB | только admin |
| `/ping` | Быстрая проверка жив ли — возвращает pid + uptime | нет |

Любое другое сообщение — промпт для Claude: текст идёт напрямую, голосовое сначала транскрибируется через Groq Whisper, фото/документы скачиваются и передаются с путём локального файла.

### 3. Фичи и как их включать

#### 3.1 Multi-user режим

**Что:** несколько Telegram-чатов могут говорить с ботом; у каждого своя изолированная память и свои крон-задачи.

**Как включить:** перечисли chat ID через запятую в `.env`:
```
ALLOWED_CHAT_IDS=110440505,987654321
```
Пустой список = пропускать любые чаты (режим первого запуска). Старый singular-ключ `ALLOWED_CHAT_ID` читается как fallback для совместимости.

**Как работает:** каждый SQL-запрос в БД фильтруется по `chat_id` (Telegram chat ID как строка). Сама проверка — одна функция в `src/config.ts` (`isAuthorised`). В каждый хендлер прикручен child-logger с `{chatId, userId, username}` — в логах видно кто что пишет.

#### 3.2 Голосовые сообщения боту (STT через Groq Whisper)

**Что:** присылаешь voice note в Telegram, бот транскрибирует и дальше обрабатывает как текст.

**Как включить:** `GROQ_API_KEY` в `.env`. Ключ бесплатный на https://console.groq.com.

**UX:** бот отвечает `Heard: "..."` (показывает что понял), потом выполняет транскрипцию как промпт.

#### 3.3 Голосовые ответы бота (TTS через ElevenLabs)

**Что:** ответы бота приходят голосовыми сообщениями вместо текста.

**Как включить:**
1. `ELEVENLABS_API_KEY=...` в `.env`
2. `ELEVENLABS_VOICE_ID=...` — возьми из https://elevenlabs.io/app/voice-library (любой голос)
3. Опционально: `ELEVENLABS_MODEL_ID` (по дефолту `eleven_multilingual_v2`, `eleven_turbo_v2_5` быстрее/дешевле, `eleven_v3` качественнее)
4. Опционально: `TTS_MAX_CHARS=800` — голосовой ответ обрезается до этого кол-ва символов; если оригинал длиннее, он также присылается текстом
5. В Telegram: `/voice on`. Хранится как per-chat настройка в SQLite.

**Pipeline:** текст ответа → убираем markdown → обрезаем до `TTS_MAX_CHARS` → ElevenLabs MP3 → ffmpeg конвертирует в OGG/Opus (формат Telegram voice) → отправка.

`ffmpeg` должен быть установлен: `sudo apt install -y ffmpeg`.

#### 3.4 WhatsApp-мост (экспериментально)

**Что:** к боту можно писать в WhatsApp в дополнение к Telegram.

**Как включить:**
```
WHATSAPP_ENABLED=1
WHATSAPP_PROVIDER=baileys
ALLOWED_WHATSAPP_NUMBERS=491234567,15551234567   # или пусто = любой
```

На первом старте бот выводит QR в логах (`journalctl -u claudeclaw -f` или `store/whatsapp-qr.png`). Сканируй из WhatsApp → Связанные устройства. После коннекта сессия сохраняется в `store/whatsapp-auth/` — рестарт не потребует повторного QR.

**⚠ Предупреждение:** `baileys` — reverse-engineered клиент. WhatsApp может забанить номер за неофициальный доступ. Используй **вторичный** номер, не основной. Код написан так, чтобы потом переключиться на Meta Cloud API (под `WHATSAPP_PROVIDER=meta`, пока не реализовано) когда пройдёт бизнес-верификация у Meta.

**Архитектура:** мост в `src/whatsapp/`. `handler.ts` не знает про baileys — принимает `(jid, text, sendReply)` и переиспользует `runAgent` + memory. Переход на Meta Cloud API = написать новый адаптер-файл, логика обработки не меняется.

**Объём v1:** только текст, только приватные чаты. Медиа, группы, реакции, редактирование — не в этом релизе.

#### 3.4b Анализ видео (Gemini skill)

**Что:** отправляешь боту видео в Telegram, спрашиваешь «что тут происходит?» — он зовёт Google Gemini 2.0 Flash, у которого нативная поддержка видео.

**Как включить:** `GEMINI_API_KEY=...` в `.env`. Бесплатный ключ на https://aistudio.google.com/apikey — free tier щедрый (1500 req/day).

**Архитектурная заметка:** это не код в боте — это skill-файл [`.claude/skills/video-gemini.md`](../.claude/skills/video-gemini.md). Когда юзер присылает видео, Claude читает инструкции из скилла и сам работает с Gemini Files API через свой Bash. Тот же паттерн будем использовать для любых узких интеграций в будущем.

**Лимиты:** ~1 час на видео (token budget Gemini), 20 MB если файл идёт через Telegram Bot API, 50 MB для документов.

#### 3.4c Preview-сервер для фронтенда

**Что:** бот генерит веб-страницу по запросу и сам хостит её — ты открываешь в браузере по IP:порту. «Сделай лендинг про X» → бот возвращает живой URL.

**Как включить:**
```
PREVIEW_ENABLED=1
PREVIEW_HOST=<твой.публичный.ip.или.домен>
PREVIEW_PORT=8080
```
Открой порт в firewall'е (`sudo ufw allow 8080/tcp` если используется ufw). Рестарт бота.

**Архитектура:** встроенный Node HTTP-сервер (0 новых deps) отдаёт `workspace/previews/`. Один скилл управляет генерацией:
- [`.claude/skills/frontend-preview.md`](../.claude/skills/frontend-preview.md) — наш скилл, который выбирает эстетику, генерит self-contained `index.html`, сохраняет в preview-папку и возвращает живой URL.

**Опционально — для качества дизайна получше:** поставить Anthropic'овский плагин `frontend-design` под юзером, от имени которого работает бот. Он добавляет инструкции по design-thinking (bold aesthetic directions, избегание «AI slop»), Claude подхватит его рядом с нашим скиллом:
```bash
# dev (под root)
claude plugin install frontend-design@claude-plugins-official

# prod (под claw)
sudo -u claw bash -lc 'claude plugin install frontend-design@claude-plugins-official'
sudo systemctl restart claudeclaw
```
Без него preview тоже работает — просто дизайн будет ближе к дефолтам.

**Безопасность:** сервер публичный (0.0.0.0:PORT). Любой с URL видит всё в `workspace/previews/`. Секреты туда класть не надо. Для приватных preview'ев понадобится Tailscale (пока не встроен).

**Выключить:** убери `PREVIEW_ENABLED` или поставь `0`, рестарт.

#### 3.5 Управление браузером (Playwright MCP)

**Что:** Claude может открывать веб-страницы, кликать, скроллить, вытаскивать текст — полная автоматизация через Playwright.

**Как включить:**
```bash
npx playwright install chromium          # разово, ~630MB в $HOME/.cache/ms-playwright
sudo npx playwright install-deps chromium # apt-пакеты, разово на машину
```

В боте нет своего кода для этого — это MCP-сервер на уровне проекта, прописанный в `.mcp.json`. Claude Code автоматически загружает его, потому что наш бот спавнит Claude с `cwd: PROJECT_ROOT + settingSources: ['project','user']` (см. `src/agent.ts`).

**Использование:** пишешь боту что-то вроде «открой example.com и скажи какой там h1» — Claude сам решает вызвать `playwright` tools и возвращает результат.

**Ресурсы:** каждая браузерная сессия = Chromium-процесс (~200MB RAM). Процессы эфемерные — стартуют по запросу, убиваются после.

#### 3.6 Долгосрочная память

**Что:** бот помнит факты о тебе между разговорами, даже после `/newchat`.

**Как работает (автоматом — включать не надо):**
- Каждое сообщение длиннее 20 символов, не `/команда`, сохраняется.
- Семантические воспоминания (личность, предпочтения — ловится regex'ом на «I am», «my», «I prefer» и т.д.) идут в один сектор; остальное эпизодическое.
- Релевантные воспоминания автоматически выбираются через SQLite FTS5 при построении промпта.
- Раз в сутки свип уменьшает salience × 0.98; воспоминания ниже 0.1 удаляются.

**Команды:**
- `/memory` — число воспоминаний для этого чата
- Decay выполняется автоматом, вручную ничего делать не надо.

#### 3.7 Крон-задачи

**Что:** бот может запускать промпты по расписанию. Полезно для утренних брифингов, напоминаний, мониторингов.

**Как использовать:** только через CLI от имени бота:
```bash
node dist/schedule-cli.js create "Утренний брифинг" "0 9 * * *" 110440505
node dist/schedule-cli.js list
node dist/schedule-cli.js pause <id>
node dist/schedule-cli.js resume <id>
node dist/schedule-cli.js delete <id>
node dist/schedule-cli.js show <id>
```

Cron-синтаксис стандартный (`min hour day month weekday`). Каждая задача привязана к `chat_id` — ответы приходят только в тот чат.

### 4. Setup wizard

`npm run setup` — интерактивный мастер на `@clack/prompts`. Что он делает:
1. Проверяет Node ≥ 20 и наличие `claude` CLI.
2. Показывает существующие значения из `.env` как пред-заполненные (re-run friendly).
3. Валидирует формат Telegram-токена и пингует `getMe` — ловит опечатки мгновенно.
4. Такая же live-валидация для ElevenLabs (`/v1/user` пинг).
5. Пишет `.env` с `chmod 600`.
6. Запускает `npm install` + `npm run build`.
7. **НЕ** ставит systemd-сервис — это дело `install.sh`.

Запускай когда надо поменять конфиг без ручной правки `.env`.

### 5. Деплой (dev → prod)

```
[dev: /root/claudeos-dev]                      [prod: /home/claw/claudeclaw]
     │                                               │
     │  npm run build + ручной тест                  │
     ▼                                               │
   git commit && git push                            │
     │                                               │
     └──► GitHub main ◄────── git pull ──────────────┤
                                                     │
                                                     ▼
                                             npm install
                                             npm run build
                                             sudo systemctl restart claudeclaw
```

**Золотое правило:** кодить только в `/root/claudeos-dev`. Прод подтягивает через git. Никогда не редактировать `/home/claw/claudeclaw/src/*` руками — это ломает модель git-pull.

**Полная команда обновления прода:**
```bash
sudo systemctl stop claudeclaw
sudo -u claw bash -lc 'cd /home/claw/claudeclaw && git pull && npm install && npm run build'
sudo systemctl start claudeclaw
sudo tail -15 /home/claw/claudeclaw/store/claudeclaw.log
```

Даунтайм: ~1-3 мин в зависимости от того что `npm install` должен сделать.

### 6. Добавление нового юзера

Два пути:

**Runtime (предпочтительный):** отправь боту от имени admin:
```
/adduser 123456789 Alice from work
```
Готово — без рестарта, без SSH. `/listusers` покажет текущий whitelist. `/removeuser 123456789` убирает.

**Статический seed (только для bootstrap'а):** `ALLOWED_CHAT_IDS` в `.env` используется для seed'а БД при первом старте. После первого бута БД — источник правды; редактирование `.env` эффекта не даёт пока не снести `store/claudeclaw.db`. Используй только при свежей установке.

Флоу приглашения нового юзера:
1. Он/она пишет `@iifam_bot` и отправляет `/chatid`. Получает `Chat ID: 123456789`.
2. Admin отправляет `/adduser 123456789 имя` в своём чате с ботом.
3. Новый юзер может писать боту.

Память изолирована по chat_id — твои разговоры и его не смешиваются.

**Оговорка:** скиллы, использующие твою OAuth-авторизацию (Gmail, Calendar и т.д.), из его чатов будут работать от **твоего** аккаунта. Если это нежелательно — отключи или ограничь такие скиллы.

### 7. Траблшутинг

| Симптом | Причина | Что делать |
|---|---|---|
| Бот молчит на все команды | Сервис не запущен | `sudo systemctl status claudeclaw`; смотри `store/claudeclaw.log` |
| `/version` молчит, `/start` работает | Запущен СТАРЫЙ код (до выкатки `/version`) | `git pull && npm run build && systemctl restart claudeclaw` |
| `/voice on` отвечает «TTS not configured» | Нет `ELEVENLABS_API_KEY` или `ELEVENLABS_VOICE_ID` в `.env` | Добавь и рестартни сервис |
| TTS падает с ошибкой `ffmpeg` | `ffmpeg` не в PATH | `sudo apt install -y ffmpeg` |
| WhatsApp каждый старт показывает QR | `store/whatsapp-auth/` пустой или битый | Сканируй заново; после этого сохранится |
| WhatsApp "logged out" | Юзер вышел из устройства в «связанных» на телефоне | Удали `store/whatsapp-auth/` и сканируй заново |
| «unauthorised chat» в логах | Chat ID отправителя не в `ALLOWED_CHAT_IDS` | Добавь или очисти переменную (открытый режим) |
| `/memory` всегда 0 | Сообщения короче 20 символов или все с `/` не сохраняются | Ожидаемое поведение |
| `git pull` падает с permission error | Owner'ы в `.claude/` поехали (писали под root) | `sudo chown -R claw:claw /home/claw/claudeclaw/.claude` |

**Где смотреть логи:**
- `sudo tail -f /home/claw/claudeclaw/store/claudeclaw.log` — логи приложения (pino JSON)
- `sudo journalctl -u claudeclaw -f` — события systemd (старт/стоп/падения)
