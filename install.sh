#!/usr/bin/env bash
# ClaudeOS one-click installer for Ubuntu 22.04 / 24.04
# Run as root: curl -fsSL https://raw.githubusercontent.com/ruslanshakirzhanovich-commits/claudeos/main/install.sh | bash

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

ok()   { echo "${GREEN}[OK]${RESET}    $*"; }
info() { echo "${BLUE}[..]${RESET}    $*"; }
warn() { echo "${YELLOW}[WARN]${RESET}  $*"; }
err()  { echo "${RED}[ERROR]${RESET} $*" >&2; }

REPO_URL="https://github.com/ruslanshakirzhanovich-commits/claudeos"
CLAW_USER="claw"
CLAW_HOME="/home/${CLAW_USER}"
INSTALL_DIR="${CLAW_HOME}/claudeos"
SERVICE_FILE="/etc/systemd/system/claudeclaw.service"

# ── Step 0: require root ───────────────────────────────────────────────────
if [[ ${EUID} -ne 0 ]]; then
  err "Запустите под root:  sudo bash install.sh"
  exit 1
fi

echo
echo "${BOLD}🦞  ClaudeOS installer${RESET}"
echo "    Репозиторий: ${REPO_URL}"
echo

# ── Step 1: OS check ───────────────────────────────────────────────────────
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    warn "Этот установщик рассчитан на Ubuntu. У вас: ${PRETTY_NAME:-unknown}. Продолжаем на свой страх и риск."
  elif [[ "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
    warn "Протестировано на Ubuntu 22.04 и 24.04. У вас: ${PRETTY_NAME}. Продолжаем."
  else
    ok "Обнаружена ${PRETTY_NAME}"
  fi
else
  warn "Не удалось определить ОС (нет /etc/os-release). Продолжаем."
fi

# ── Step 2: base packages + Node.js 22 ─────────────────────────────────────
info "Устанавливаю базовые пакеты и Node.js 22…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates build-essential python3 sudo

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  ok "Node.js $(node -v) установлен"
else
  ok "Node.js $(node -v) уже установлен"
fi

# ── Step 3: Claude Code CLI ────────────────────────────────────────────────
info "Устанавливаю @anthropic-ai/claude-code (глобально)…"
npm install -g @anthropic-ai/claude-code
ok "Claude Code CLI: $(claude --version 2>/dev/null || echo 'installed')"

# ── Step 4: create claw user ───────────────────────────────────────────────
if id "${CLAW_USER}" >/dev/null 2>&1; then
  ok "Пользователь ${CLAW_USER} уже существует"
else
  info "Создаю пользователя ${CLAW_USER}…"
  adduser "${CLAW_USER}" --disabled-password --gecos "" >/dev/null
  ok "Пользователь ${CLAW_USER} создан"
fi

# ── Step 5: Claude login (OAuth) ───────────────────────────────────────────
echo
echo "${BOLD}Шаг: авторизация в Anthropic${RESET}"
echo "Сейчас запустится 'claude login'. Откройте ссылку в браузере, войдите в свой"
echo "аккаунт Claude Pro / Max и вставьте код обратно в терминал."
echo

# Если уже залогинен под root — переиспользуем, иначе запускаем интерактивно.
if ! claude --help >/dev/null 2>&1; then
  err "claude CLI не установился корректно"
  exit 1
fi

if [[ -f "/root/.claude/.credentials.json" || -d "/root/.claude" ]]; then
  ok "Похоже, Claude уже авторизован под root (найден ~/.claude)"
else
  info "Запускаю 'claude login' (интерактивно)…"
  if ! claude login; then
    err "claude login не прошёл. Запустите вручную и перезапустите установщик."
    exit 1
  fi
fi

# ── Step 6: clone repo ─────────────────────────────────────────────────────
info "Клонирую ${REPO_URL} в ${INSTALL_DIR}…"
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  warn "${INSTALL_DIR} уже существует — делаю git pull"
  sudo -u "${CLAW_USER}" git -C "${INSTALL_DIR}" pull --rebase --autostash
else
  rm -rf "${INSTALL_DIR}"
  git clone "${REPO_URL}" "${INSTALL_DIR}"
  chown -R "${CLAW_USER}:${CLAW_USER}" "${INSTALL_DIR}"
fi
ok "Код на месте: ${INSTALL_DIR}"

# ── Step 7: copy ~/.claude to claw ─────────────────────────────────────────
if [[ -d "/root/.claude" ]]; then
  info "Копирую /root/.claude → ${CLAW_HOME}/.claude…"
  rm -rf "${CLAW_HOME}/.claude"
  cp -a /root/.claude "${CLAW_HOME}/.claude"
  chown -R "${CLAW_USER}:${CLAW_USER}" "${CLAW_HOME}/.claude"
  ok "Конфиг Claude перенесён пользователю ${CLAW_USER}"
else
  warn "Директория /root/.claude не найдена. Вы точно прошли 'claude login'?"
fi

# ── Step 8: interactive .env ───────────────────────────────────────────────
echo
echo "${BOLD}Шаг: заполняем .env${RESET}"
ENV_FILE="${INSTALL_DIR}/.env"

# Чтение из /dev/tty нужно на случай запуска через 'curl | bash'
read_tty() { read -r -p "$1" "$2" </dev/tty; }

read_tty "Telegram Bot Token (от @BotFather, обязательно): " TG_TOKEN
while [[ -z "${TG_TOKEN}" ]]; do
  warn "Токен не может быть пустым."
  read_tty "Telegram Bot Token: " TG_TOKEN
done

read_tty "Allowed Chat ID (можно оставить пустым — бот пришлёт свой): " TG_CHAT_ID
read_tty "Groq API Key (опционально, Enter чтобы пропустить): " GROQ_KEY

cat > "${ENV_FILE}" <<ENVEOF
# Generated by install.sh on $(date -u +'%Y-%m-%dT%H:%M:%SZ')
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
ALLOWED_CHAT_ID=${TG_CHAT_ID}
GROQ_API_KEY=${GROQ_KEY}
LOG_LEVEL=info
NODE_ENV=production
ENVEOF

chown "${CLAW_USER}:${CLAW_USER}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
ok ".env создан (${ENV_FILE}, chmod 600)"

# ── Step 9: npm install + build ────────────────────────────────────────────
info "Собираю проект (npm install + npm run build) под ${CLAW_USER}…"
sudo -u "${CLAW_USER}" bash -lc "cd '${INSTALL_DIR}' && npm install --no-audit --no-fund && npm run build"
ok "Сборка завершена"

# Убедимся, что store/ существует и принадлежит claw
mkdir -p "${INSTALL_DIR}/store"
chown -R "${CLAW_USER}:${CLAW_USER}" "${INSTALL_DIR}/store"

# ── Step 10: systemd unit ──────────────────────────────────────────────────
info "Устанавливаю systemd unit ${SERVICE_FILE}…"
cat > "${SERVICE_FILE}" <<'UNITEOF'
[Unit]
Description=ClaudeOS Telegram Bot
Documentation=https://github.com/ruslanshakirzhanovich-commits/claudeos
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=claw
Group=claw
WorkingDirectory=/home/claw/claudeos
ExecStart=/usr/bin/node /home/claw/claudeos/dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:/home/claw/claudeos/store/claudeclaw.log
StandardError=append:/home/claw/claudeos/store/claudeclaw.log
Environment=NODE_ENV=production

# Security
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable claudeclaw.service >/dev/null
systemctl restart claudeclaw.service
sleep 2

# ── Step 11: final report ──────────────────────────────────────────────────
echo
if systemctl is-active --quiet claudeclaw.service; then
  ok "Сервис claudeclaw.service запущен"
  PID=$(systemctl show --property=MainPID --value claudeclaw.service || echo '?')
  echo "    PID: ${PID}"
else
  err "Сервис не запустился. Смотрите:  journalctl -u claudeclaw -n 50 --no-pager"
fi

echo
echo "${BOLD}${GREEN}🦞  Готово.${RESET}"
echo
echo "Откройте вашего бота в Telegram и напишите /start."
if [[ -z "${TG_CHAT_ID}" ]]; then
  echo
  echo "${YELLOW}Chat ID в .env пустой — бот пришлёт вам ваш ID при первом сообщении.${RESET}"
  echo "Впишите его в ${ENV_FILE} (ALLOWED_CHAT_ID=...) и выполните:"
  echo "    systemctl restart claudeclaw"
fi
echo
echo "Полезные команды:"
echo "    systemctl status claudeclaw"
echo "    journalctl -u claudeclaw -f"
echo
