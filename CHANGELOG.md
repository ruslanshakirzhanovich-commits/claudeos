# Changelog

Все заметные изменения ClaudeClaw.

## [1.5.1] - 2026-04-24
- 🛠 `/update` перестал самоубиваться посреди деплоя: `deploy.sh` теперь спавнится через `sudo systemd-run --scope --collect --unit=claudeclaw-deploy-<ts>`, попадая в собственный transient scope. `systemctl restart claudeclaw` внутри скрипта больше не прибивает deploy-процесс вместе с ботом.
- 📒 Deploy-лог переехал из `/tmp/claudeclaw-deploy.log` в `store/deploy.log`. systemd `PrivateTmp=true` больше не прячет лог — его видно с хоста и через новую команду.
- 🩹 `/updatelog` — возвращает последние ~200 строк `store/deploy.log`, обрезая до ~3500 байт чтобы не упереться в 4096-символьный лимит Telegram.
- ⚙️ Sudoers нужна новая строчка на prod: `claw ALL=(root) NOPASSWD: /usr/bin/systemd-run --scope *` (ставится одноразово перед первым апдейтом на 1.5.1).

## [1.5.0] - 2026-04-24
- 🧠 Русский в классификаторе identity: `classifyMemory()` с Unicode-aware границами (JS `\b` не работает на кириллице). Identity-факты русскоязычных пользователей больше не тонут в episodic.
- 💰 CLAUDE.md через SDK `systemPrompt` preset вместо ручной инъекции в user prompt — автоматический system-prompt cache заработал, двойной токен-счёт устранён.
- 🔁 `runAgent` обёрнут в `withRetry` с `streamStarted`-гардом: ретрай только для 429/529/5xx/ECONN* и только пока SDK не начал эмитить события (tool-calls не повторяются).
- ⛑ `maxTurns=25` и `AbortController` с таймаутом 120с: агент не может уйти в бесконечный tool-use loop или повиснуть на пустом стриме.
- 🗝 `identity_facts` — новая curated-таблица + команды `/remember <fact>`, `/facts`, `/forgetfact <id>`. Факты идут отдельным блоком в memory-context и не подвержены decay/cap.
- 🛡 `assertSafeBackupPath()` — валидация абсолютного пути, allowed-dir prefix, whitelist-regex имени файла перед `VACUUM INTO`.
- 📊 `recordUsage` стал кумулятивным: `COALESCE(x,0) + excluded.x` + `MAX()` для contextWindow. Race с `recordCompaction` невозможна по построению.
- 🛌 Decay и delete теперь только на episodic: semantic-факты больше не испаряются по времени.
- 🧹 `capEpisodicMemoriesBatched` — async, LIMIT + `setImmediate` между пассами. Дневной sweep не блокирует event loop.
- 🚧 Protection для episodic cap: `protectMinSalience` + `protectCreatedAfterMs` — свежие и high-salience записи переживают cap.
- 🪣 Rate-limit buckets бэкнуты LRU (`RATE_LIMIT_MAX_TRACKED=10000`): высококардинальный поток chat_id не течёт в OOM.
- 👉 Typing-indicator в Discord (`channel.sendTyping()`) и WhatsApp/baileys (`sendPresenceUpdate('composing')`) — паритет с Telegram.
- 🩺 Health endpoint на `127.0.0.1:9090`: `/health` (JSON snapshot + 503 при ok=false), `/ready` (liveness). Интегрирован в graceful shutdown.
- 🧰 ESLint 9 (flat config) + Prettier + pre-commit hook (`npm run install-hooks`, без husky); CI расширен lint + format:check шагами.
- 🗂 Миграция 6: таблица `identity_facts` с unique `(chat_id, fact_normalized)`.
- 🧪 264 теста (было 177 в 1.4.0): agent-system-prompt, agent-retry, agent-guards, agent-stream-e2e, backup-path-validation, usage-cumulative, memory-classify, memory-decay-semantic, memory-identity-context, identity-facts, rate-limit-lru, discord-typing, whatsapp-typing, health.

## [1.4.0] - 2026-04-24
- 🔐 Preview-сервер: fail-fast на публичный bind без `PREVIEW_PASSWORD`, дефолт 127.0.0.1, 401 вместо pass-through
- 🛡 `permissionMode` обязателен в `runAgent` — убран дефолт `bypassPermissions`, runtime-guard для JS-вызовов
- 🔁 Гонка `usage_compactions` устранена: `recordUsage` больше не трогает счётчик, им владеет только атомарный `recordCompaction`
- 🚦 Per-chat serialization запросов к агенту: два сообщения в одном чате больше не делят sessionId
- ✂️ Единый `splitMessage` во всех каналах — WhatsApp больше не теряет длинные ответы
- 🚨 CI: `npm audit --omit=dev --audit-level=high`, закрыты 3 critical CVE через `protobufjs` override
- 🔏 `pino.redact` для токенов, Authorization и Telegram webhook secret — секреты больше не утекают в логи
- ⏱ Token-bucket rate-limit на chatId (дефолт 10 burst, 10/мин) — защита от флуда при компрометации токена
- 🧱 `runChatPipeline` — единое ядро для Telegram/Discord/WhatsApp (rate-limit, memory, agent, session, save)
- 📏 Hard cap episodic per chat (дефолт 1000) + еженедельная консолидация episodic→semantic через agent SDK (off by default, `MEMORY_SUMMARIZE_ENABLED=1`)
- 🔍 FTS sanitizer чинит русский: floor 3→2 chars, блок FTS5-keywords (AND/OR/NOT/NEAR), cap 5→6 токенов
- 💾 Backup restore roundtrip test: проверяем FTS5 shadow tables после VACUUM INTO, отказ на битом/отсутствующем файле
- 🔑 `ADMIN_DISCORD_USERS` и `ADMIN_WHATSAPP_NUMBERS` — явная admin-модель для Discord/WhatsApp, fail-closed дефолт
- 🧪 177 тестов (было 67 в 1.3.0): chat-queue, chat-pipeline, rate-limit, logger-redact, memory-cap, backup-restore, fts-sanitizer, memory-summarize, whatsapp-handler

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
