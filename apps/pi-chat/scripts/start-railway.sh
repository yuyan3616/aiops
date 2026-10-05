#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV="${NODE_ENV:-production}"
export PI_CHAT_HOST="${PI_CHAT_HOST:-127.0.0.1}"
export PI_CHAT_PORT="${PI_CHAT_PORT:-4328}"
export PI_CHAT_ROOT_DIR="${PI_CHAT_ROOT_DIR:-/tmp/pi-chat}"
export RCA_INVESTIGATIONS_DIR="${RCA_INVESTIGATIONS_DIR:-/tmp/pi-chat/data/rca/investigations}"

PUBLIC_PORT="${PORT:-3000}"

MIGRATION_RECEIPT="$PI_CHAT_ROOT_DIR/agent-config/release-backups/migration-result.json"
LEGACY_PROFILE="$PI_CHAT_ROOT_DIR/agent-config/013e27faf865a0cc38a6f99fc4075e220679d1b9.json"
if [[ -n "${AGENT_CONFIG_MIGRATE_EXTENSION_SHA:-}" ]] || [[ -f "$LEGACY_PROFILE" && ! -f "$MIGRATION_RECEIPT" ]]; then
  export AGENT_CONFIG_MIGRATE_EXTENSION_SHA="${AGENT_CONFIG_MIGRATE_EXTENSION_SHA:-491f8147d308717c22c042fdbbed5895e0a3214b}"
  pnpm exec tsx --tsconfig tsconfig.node.json scripts/migrate-agent-config-release.ts
fi

pnpm exec tsx --tsconfig tsconfig.node.json server/index.ts &
API_PID=$!

pnpm exec vite preview --host 0.0.0.0 --port "$PUBLIC_PORT" &
WEB_PID=$!

cleanup() {
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$API_PID" "$WEB_PID"
