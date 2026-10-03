#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV="${NODE_ENV:-production}"
export PI_CHAT_HOST="${PI_CHAT_HOST:-127.0.0.1}"
export PI_CHAT_PORT="${PI_CHAT_PORT:-4328}"
export PI_CHAT_ROOT_DIR="${PI_CHAT_ROOT_DIR:-/tmp/pi-chat}"
export RCA_INVESTIGATIONS_DIR="${RCA_INVESTIGATIONS_DIR:-/tmp/pi-chat/data/rca/investigations}"

PUBLIC_PORT="${PORT:-3000}"

pnpm exec tsx --tsconfig tsconfig.node.json server/index.ts &
API_PID=$!

pnpm exec vite preview --host 0.0.0.0 --port "$PUBLIC_PORT" &
WEB_PID=$!

cleanup() {
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$API_PID" "$WEB_PID"
