#!/usr/bin/env bash
# ClaudeClaw production deploy.
#
# Intended to run on the prod host from inside the prod clone
# (e.g. /home/claw/claudeclaw) as the `claw` user. It:
#   1. Fetches origin/main and fast-forwards (aborts on divergence).
#   2. Installs dependencies with npm ci (lockfile exact).
#   3. Typechecks, builds, runs tests — any failure stops the deploy
#      BEFORE touching the running service.
#   4. Restarts the systemd unit, then tails status.
#
# Exits non-zero on any step failure so CI / wrappers can detect it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="${CLAUDECLAW_SERVICE:-claudeclaw}"

cd "${PROJECT_ROOT}"

say() { printf "\n==> %s\n" "$*"; }

say "Deploying from ${PROJECT_ROOT} (service: ${SERVICE_NAME})"

# Fail-fast: verify we can restart the service via passwordless sudo BEFORE
# touching any code on disk. Otherwise a bad sudoers config lets us git-pull,
# npm-ci, and build a new version without ever restarting it — the service
# keeps running the old code while the filesystem has new code.
# Override with CLAUDECLAW_SKIP_SUDO_CHECK=1 if your environment is different
# (e.g. running under systemd with CAP_SYS_ADMIN, or deploying somewhere that
# restarts out-of-band).
if [ "${CLAUDECLAW_SKIP_SUDO_CHECK:-}" != "1" ]; then
  say "Checking passwordless sudo for systemctl"
  if ! sudo -n systemctl show "${SERVICE_NAME}" --property=LoadState > /dev/null 2>&1; then
    echo "!! sudo -n systemctl fails — passwordless sudo required to restart ${SERVICE_NAME}." >&2
    echo "   Configure /etc/sudoers.d/claudeclaw, e.g.:" >&2
    SYSTEMCTL="$(command -v systemctl 2>/dev/null || echo /usr/bin/systemctl)"
    echo "     claw ALL=(root) NOPASSWD: ${SYSTEMCTL} restart ${SERVICE_NAME}, ${SYSTEMCTL} status ${SERVICE_NAME}, ${SYSTEMCTL} show ${SERVICE_NAME}" >&2
    echo "   Or set CLAUDECLAW_SKIP_SUDO_CHECK=1 if restart happens out-of-band." >&2
    exit 1
  fi
fi

say "Fetching origin/main"
git fetch origin main

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"

if [ "${LOCAL}" = "${REMOTE}" ]; then
  echo "Already at ${LOCAL:0:8} — nothing to pull."
else
  say "Fast-forwarding ${LOCAL:0:8} -> ${REMOTE:0:8}"
  if ! git merge --ff-only origin/main; then
    echo "!! merge is not a fast-forward. Resolve local divergence manually, then re-run deploy." >&2
    exit 1
  fi
fi

say "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund

say "Typecheck"
npm run typecheck

say "Build"
npm run build

say "Test"
npm test

say "Restarting ${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

sleep 2

say "Service status"
sudo systemctl status "${SERVICE_NAME}" --no-pager | head -12

say "Deploy complete — now at $(git rev-parse --short HEAD)"
