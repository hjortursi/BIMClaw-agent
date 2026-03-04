#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${PORT:-}" && -z "${BIMCLAW_API_PORT:-}" ]]; then
  export BIMCLAW_API_PORT="${PORT}"
fi

if [[ -z "${BIMCLAW_API_HOST:-}" ]]; then
  export BIMCLAW_API_HOST="0.0.0.0"
fi

echo "[bimclaw-agent] starting (API ${BIMCLAW_API_HOST}:${BIMCLAW_API_PORT})"
exec node dist/index.js
