#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

NODE_BIN=""
for candidate in "$PWD/runtime/node" "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "Error: Node.js tidak ditemukan (atau arsitektur runtime/node tidak cocok dengan CPU Mac ini)."
  echo "Silakan install Node.js LTS dari https://nodejs.org"
  read -r -p "Tekan Enter untuk keluar..."
  exit 1
fi

echo "=================================================="
echo "  DM Audio — Digital Mixer Console"
echo "  Memulai Audio Engine & Desktop Console..."
echo "=================================================="

exec "$NODE_BIN" server.mjs --desktop
