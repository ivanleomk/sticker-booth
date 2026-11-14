#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  exec node server.mjs
elif command -v op >/dev/null 2>&1; then
  exec op run --env-file=.env.op -- node server.mjs
else
  echo "Error: GEMINI_API_KEY is not set and 1Password CLI (op) was not found." >&2
  exit 1
fi
