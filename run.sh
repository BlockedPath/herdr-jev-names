#!/usr/bin/env bash
# Entry point for every hook and action in herdr-plugin.toml.
# Herdr starts plugin commands with the server's PATH, which may not include
# bun, so look in the usual install locations too.
set -u
dir="$(cd "$(dirname "$0")" && pwd)"
for b in "${BUN:-}" "$(command -v bun 2>/dev/null)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -n "$b" ] && [ -x "$b" ]; then
    exec "$b" "$dir/src/main.ts" "$@"
  fi
done
echo "jev-names: bun not found; install it from https://bun.sh" >&2
exit 1
