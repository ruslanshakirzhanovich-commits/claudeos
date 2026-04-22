# ClaudeOS 🦞

**[English](#english)** · **[Русский](#русский)**

---

<a id="english"></a>

## English

Personal AI assistant powered by Claude Code, controlled via Telegram. Your own Jarvis, running on your server.

Text your bot on Telegram and it responds as a full agent: reads files, schedules tasks, remembers you, runs skills, works 24/7. All state lives on your machine, no cloud middleman.

**Want the full reference?** See [docs/GUIDE.md](docs/GUIDE.md) — commands, features, deploy flow, troubleshooting.

---

### ⚠️ Prerequisites

- **Ubuntu 22.04 or 24.04** (fresh server or VPS)
- **Root access** to the machine (the installer runs as root)
- **Claude Pro or Max subscription** — the bot uses your Anthropic account via `claude login`, no separate API key needed
- **Telegram account** and a bot created via [@BotFather](https://t.me/BotFather)
- *Optional:* **Groq API key** (free, [console.groq.com](https://console.groq.com)) — for voice-message transcription via Whisper

---

### 🚀 One-click install

On a fresh Ubuntu machine, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/ruslanshakirzhanovich-commits/claudeos/main/install.sh | bash
```

The installer will ask you to:
1. Run `claude login` — open the URL in your browser and authenticate with your Anthropic account
2. Paste your **Telegram Bot Token** (get one from [@BotFather](https://t.me/BotFather) with `/newbot`)
3. Paste your **Allowed Chat ID** (can be left empty — on first run the bot will send you your ID; put it in `.env` and restart the service)
4. Paste a **Groq API Key** (optional, skip with Enter)

After 2–3 minutes `claudeclaw.service` is up and will auto-start on reboot.

---

### 📋 What it does

- **Telegram conversations** — text, code, commands, everything Claude Code does, from your phone
- **Voice messages via Groq Whisper** — send a voice note, the bot transcribes and acts on it
- **Long-term memory** — SQLite with FTS5, dual-sector (semantic + episodic), relevant facts auto-injected into prompts
- **Task scheduler** — cron-like scheduler (`schedule-cli.js`), the bot can set its own reminders and morning summaries
- **Skills** — everything in `~/.claude/skills/` is available: Gmail, Calendar, Obsidian, agent-browser, plus anything you plug in
- **Multi-user mode** — whitelist multiple Telegram chats via `ALLOWED_CHAT_IDS` (comma-separated); each user gets an isolated memory bucket, and user identity is tagged in every log line
- **Browser control via Playwright MCP** — optional. `.mcp.json` ships a `playwright` server; activate with `npx playwright install chromium` (one-time, ~300MB). The bot can then open pages, click, scroll, extract text. Skip if you don't want Chromium on the server.
- **24/7 autostart** — `systemd` brings the service back up on reboot or crash

---

### 🛠 Management

```bash
systemctl status claudeclaw      # Is it alive?
systemctl restart claudeclaw     # Restart (after editing .env)
systemctl stop claudeclaw        # Stop
systemctl start claudeclaw       # Start
journalctl -u claudeclaw -f      # Tail logs live
```

Logs are also written to `/home/claw/claudeos/store/claudeclaw.log`.

---

### 📂 Layout

```
/home/claw/claudeos/         ← project code (cloned repo)
  ├── src/                   ← TypeScript sources
  ├── dist/                  ← compiled JS (after npm run build)
  ├── scripts/               ← helper CLIs (setup, status, notify)
  ├── store/                 ← SQLite memory + logs (gitignored)
  │   └── claudeclaw.db      ← long-term memory
  └── .env                   ← your tokens (chmod 600, gitignored)

/home/claw/.claude/skills/   ← Claude Code skills available to the bot

/etc/systemd/system/claudeclaw.service   ← autostart unit
```

---

### 🙏 Credits

Under the hood: [Claude Code](https://docs.claude.com/en/docs/claude-code), a product of [Anthropic](https://www.anthropic.com/). ClaudeOS is a wrapper that turns Claude Code into a personal Telegram assistant.

Main libraries: [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), [`grammy`](https://grammy.dev), [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

---

### 📜 License

[MIT](LICENSE) — do what you want, just don't break each other's servers.

---

<a id="русский"></a>

## Русский

Персональный AI-ассистент на базе Claude Code, управляемый через Telegram. Ваш собственный Jarvis на вашем сервере.

Пишете боту в Telegram — он отвечает как полноценный агент: читает файлы, планирует задачи, помнит вас, выполняет скиллы, работает круглосуточно. Весь стейт живёт на вашей машине, никаких облачных прокладок.

**Нужен полный справочник?** См. [docs/GUIDE.md](docs/GUIDE.md) — команды, фичи, деплой, траблшутинг.

---

### ⚠️ Что нужно до установки

- **Ubuntu 22.04 или 24.04** (свежий сервер или VPS)
- **Root-доступ** к машине (установщик запускается под root)
- **Подписка Claude Pro или Max** — бот использует ваш аккаунт Anthropic через `claude login`, отдельный API-ключ не нужен
- **Telegram-аккаунт** и бот, созданный через [@BotFather](https://t.me/BotFather)
- *Опционально:* **Groq API-ключ** (бесплатный, [console.groq.com](https://console.groq.com)) — для расшифровки голосовых сообщений через Whisper

---

### 🚀 Быстрая установка (один клик)

На свежей Ubuntu-машине под root:

```bash
curl -fsSL https://raw.githubusercontent.com/ruslanshakirzhanovich-commits/claudeos/main/install.sh | bash
```

По ходу установщик спросит:
1. Запустит `claude login` — откройте ссылку в браузере и авторизуйтесь через свой аккаунт Anthropic
2. Попросит **Telegram Bot Token** (получите у [@BotFather](https://t.me/BotFather) командой `/newbot`)
3. Попросит **Allowed Chat ID** (можно оставить пустым — на первом запуске бот сам пришлёт ваш ID, вставите в `.env` и перезапустите сервис)
4. Попросит **Groq API Key** (опционально, пропускается Enter-ом)

Через 2-3 минуты сервис `claudeclaw.service` будет запущен и подхватится при перезагрузке.

---

### 📋 Что он делает

- **Отвечает в Telegram** — текст, код, команды, всё как в обычном Claude Code, только с мобилы
- **Голосовые через Groq Whisper** — скидываете voice note, он транскрибирует и выполняет
- **Долгосрочная память** — SQLite с FTS5, два сектора (семантический и эпизодический), релевантные факты подтягиваются автоматически
- **Планировщик задач** — cron-подобный scheduler (`schedule-cli.js`), бот может сам себе ставить напоминания и утренние саммари
- **Скиллы** — всё, что лежит в `~/.claude/skills/`, доступно боту: Gmail, Calendar, Obsidian, agent-browser, всё, что вы сами подключите
- **Мульти-юзер режим** — несколько разрешённых Telegram-чатов через `ALLOWED_CHAT_IDS` (через запятую); у каждого пользователя изолированная память, а в логах видно от какого юзера сообщение
- **Управление браузером через Playwright MCP** — опционально. В `.mcp.json` уже прописан `playwright`-сервер; для активации одной командой поставьте Chromium: `npx playwright install chromium` (~300MB, разово). После этого бот сможет открывать страницы, кликать, скроллить, вытаскивать текст. Пропустите, если Chromium на сервере не нужен
- **Автозапуск 24/7** — `systemd` поднимает сервис после ребута и перезапускает при падении

---

### 🛠 Управление

```bash
systemctl status claudeclaw      # Проверить, жив ли
systemctl restart claudeclaw     # Перезапустить (после правки .env)
systemctl stop claudeclaw        # Остановить
systemctl start claudeclaw       # Запустить
journalctl -u claudeclaw -f      # Смотреть логи в реальном времени
```

Логи также пишутся в файл: `/home/claw/claudeos/store/claudeclaw.log`.

---

### 📂 Структура

```
/home/claw/claudeos/         ← код проекта (клон репы)
  ├── src/                   ← TypeScript исходники
  ├── dist/                  ← скомпилированный JS (после npm run build)
  ├── scripts/               ← вспомогательные CLI (setup, status, notify)
  ├── store/                 ← SQLite-база памяти и логи (не в git)
  │   └── claudeclaw.db      ← долгосрочная память бота
  └── .env                   ← ваши токены (600, не в git)

/home/claw/.claude/skills/   ← скиллы Claude Code, доступные боту

/etc/systemd/system/claudeclaw.service   ← юнит автозапуска
```

---

### 🙏 Благодарности

Под капотом — [Claude Code](https://docs.claude.com/en/docs/claude-code), продукт [Anthropic](https://www.anthropic.com/). ClaudeOS — обёртка, превращающая Claude Code в персонального ассистента в Telegram.

Основные библиотеки: [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), [`grammy`](https://grammy.dev), [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

---

### 📜 Лицензия

[MIT](LICENSE) — делайте что хотите, только не ломайте друг другу серверы.
