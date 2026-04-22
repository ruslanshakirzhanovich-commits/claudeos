# Changelog

Все заметные изменения ClaudeClaw.

## [1.2.0] - 2026-04-22
- Команда `/version` показывает версию бота и последние записи CHANGELOG
- Голосовые ответы (TTS) через ElevenLabs, команды `/voice on|off`
- Onboarding wizard на `@clack/prompts` с live-проверкой токенов
- WhatsApp-мост: неофициальный адаптер через baileys и официальный через Meta Cloud API
- Управление браузером через Playwright MCP (`.mcp.json`)
- Admin-команды `/adduser`, `/removeuser`, `/listusers` — whitelist редактируется из чата
- Команды `/backup` (с проверкой консистентности), `/stats`, `/ping`
- Skill для анализа видео через Gemini 2.0 Flash
- Preview-сервер для сгенерированных фронтенд-страниц (опциональный, с HTTP Basic Auth)
- Два уровня доступа: admin получает `bypassPermissions`, обычные юзеры — `plan` mode
- Миграции схемы БД через `PRAGMA user_version`
- `last_seen_at` в `/listusers` — видно когда юзер последний раз писал
- Документация: [docs/GUIDE.md](docs/GUIDE.md) на EN и RU
- Prompt-injection защита: memory-context помечается как untrusted data
- Preview-папки старше 30 дней автоматически удаляются при старте
- Парсер `.env` заменён на `dotenv`

## [1.1.0] - 2026-04-22
- Multi-user support через переменную окружения `ALLOWED_CHAT_IDS`

## [1.0.0] - 2026-04-21
- Initial release
