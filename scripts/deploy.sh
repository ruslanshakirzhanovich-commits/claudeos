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
