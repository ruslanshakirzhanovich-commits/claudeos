# ClaudeOS 🦞

Персональный AI-ассистент на базе Claude Code, управляемый через Telegram. Ваш собственный Jarvis на вашем сервере.

Пишете боту в Telegram — он отвечает как полноценный агент: читает файлы, планирует задачи, помнит вас, выполняет скиллы, работает круглосуточно. Весь стейт живёт на вашей машине, никаких облачных прокладок.

---

## ⚠️ Что нужно до установки

- **Ubuntu 22.04 или 24.04** (свежий сервер или VPS)
- **Root-доступ** к машине (установщик запускается под root)
- **Подписка Claude Pro или Max** — бот использует ваш аккаунт Anthropic через `claude login`, отдельный API-ключ не нужен
- **Telegram-аккаунт** и бот, созданный через [@BotFather](https://t.me/BotFather)
- *Опционально:* **Groq API-ключ** (бесплатный, [console.groq.com](https://console.groq.com)) — для расшифровки голосовых сообщений через Whisper

---

## 🚀 Быстрая установка (один клик)

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

## 📋 Что он делает

- **Отвечает в Telegram** — текст, код, команды, всё как в обычном Claude Code, только с мобилы
- **Голосовые через Groq Whisper** — скидываете voice note, он транскрибирует и выполняет
- **Долгосрочная память** — SQLite с FTS5, два сектора (семантический и эпизодический), релевантные факты подтягиваются автоматически
- **Планировщик задач** — cron-подобный scheduler (`schedule-cli.js`), бот может сам себе ставить напоминания и утренние саммари
- **Скиллы** — всё, что лежит в `~/.claude/skills/`, доступно боту: Gmail, Calendar, Obsidian, agent-browser, всё, что вы сами подключите
- **Автозапуск 24/7** — `systemd` поднимает сервис после ребута и перезапускает при падении

---

## 🛠 Управление

```bash
systemctl status claudeclaw      # Проверить, жив ли
systemctl restart claudeclaw     # Перезапустить (после правки .env)
systemctl stop claudeclaw        # Остановить
systemctl start claudeclaw       # Запустить
journalctl -u claudeclaw -f      # Смотреть логи в реальном времени
```

Логи также пишутся в файл: `/home/claw/claudeos/store/claudeclaw.log`.

---

## 📂 Структура

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

## 🙏 Благодарности

Под капотом — [Claude Code](https://docs.claude.com/en/docs/claude-code), продукт [Anthropic](https://www.anthropic.com/). ClaudeOS — обёртка, превращающая Claude Code в персонального ассистента в Telegram.

Основные библиотеки: [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), [`grammy`](https://grammy.dev), [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

---

## 📜 Лицензия

[MIT](LICENSE) — делайте что хотите, только не ломайте друг другу серверы.
