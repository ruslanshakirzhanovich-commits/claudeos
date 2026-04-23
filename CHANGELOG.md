# Changelog

Все заметные изменения ClaudeClaw.

## [1.3.0] - 2026-04-23
- 🎚 Команда `/models` с инлайн-клавиатурой: переключение Claude Opus/Sonnet/Haiku per-chat, выбор сохраняется в БД
- ⚡ Команда `/effort` с 4 уровнями thinking budget (Low/Medium/High/Extra high), дефолт для чатов — Medium
- 🩺 Команда `/health` для админа: счётчики за час и с момента старта (агент-вызовы, ошибки, скипы скедулера, бэкапы, inflight)
- 📊 Редизайн `/status` в стиле openclaw: эмодзи + компактные строки, версия/коммит, модель, effort, сессия, роль
- 🆔 Активная модель инжектится в system prompt — Claude честно отвечает на «какая ты модель?»
- 🔁 `/models` при смене модели сбрасывает сессию, чтобы новая модель действительно начала работать
- 🛡 Scheduler overlap guard: таски не запускаются повторно пока предыдущий тик ещё бежит
- 🧪 verifyBackup теперь проверяет `PRAGMA integrity_check` и `foreign_key_check`
- 🔄 Exponential backoff retry на Telegram/Groq/ElevenLabs/Meta (3 попытки, 500ms/1s/2s)
- 🚫 Prompt-injection: voice-транскрипты, WhatsApp-сообщения, caption/filename в `<untrusted_user_input>`
- 📢 Громкий WARN при пустом whitelist (open mode) на старте и per-chat при первом контакте
- 💾 Daily auto-backups с ротацией (`BACKUP_KEEP=7`) + `/backup` теперь через общий helper
- 🔍 FTS5 incremental merge в daily decay sweep — индекс не фрагментируется
- 🧩 Memory-операции в транзакциях (insertMemories/touchMemories batch, decayMemories atomic)
- 📝 Pino `stdSerializers.err` — в JSON-логах полный стек Error-объектов
- 🪂 Graceful shutdown: SIGTERM ждёт до 30 сек inflight агентов, потом exit
- 🚨 uncaughtException/unhandledRejection → алерт админу в Telegram со стеком
- 🗂 Рефакторинг `src/bot.ts` (612 → 332 LOC): команды вынесены в `src/commands/`
- 🚀 `npm run deploy` — fail-fast прод-деплой (git pull + ci + build + test → только потом рестарт)
- ⚙️ GitHub Actions CI: typecheck + build + test на каждый PR и push в main
- 🧵 Typing-indicator с `nonOverlapping` guard — не копится очередь API-вызовов
- 🧫 67 тестов (было 0 в начале ветки): permissions, scheduler failures, backup rotation, retry, inflight, metrics, models, effort, transactions, verify-backup

## [1.2.0] - 2026-04-22
- 📜 Команда `/version` показывает версию бота и последние записи CHANGELOG
- 🔊 Голосовые ответы (TTS) через ElevenLabs, команды `/voice on|off`
- 🧙 Onboarding wizard на `@clack/prompts` с live-проверкой токенов
- 💬 WhatsApp-мост: неофициальный адаптер через baileys и официальный через Meta Cloud API
- 🌐 Управление браузером через Playwright MCP (`.mcp.json`)
- 👥 Admin-команды `/adduser`, `/removeuser`, `/listusers` — whitelist редактируется из чата
- 💾 Команды `/backup` (с проверкой консистентности), `/stats`, `/ping`
- 🎬 Skill для анализа видео через Gemini 2.0 Flash
- 🖼 Preview-сервер для сгенерированных фронтенд-страниц (опциональный, с HTTP Basic Auth)
- 🔐 Два уровня доступа: admin получает `bypassPermissions`, обычные юзеры — `plan` mode
- 🗄 Миграции схемы БД через `PRAGMA user_version`
- 👁 `last_seen_at` в `/listusers` — видно когда юзер последний раз писал
- 📚 Документация: [docs/GUIDE.md](docs/GUIDE.md) на EN и RU
- 🛡 Prompt-injection защита: memory-context помечается как untrusted data
- 🧹 Preview-папки старше 30 дней автоматически удаляются при старте
- 📦 Парсер `.env` заменён на `dotenv`

## [1.1.0] - 2026-04-22
- 👨‍👩‍👧 Multi-user support через переменную окружения `ALLOWED_CHAT_IDS`

## [1.0.0] - 2026-04-21
- 🎉 Initial release
