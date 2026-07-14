#!/bin/sh

set -eu

package_name="${1:-}"

case "$package_name" in
  @devvit/mcp | @ttsc/graph)
    ;;
  *)
    echo "Usage: tools/run-mcp-server.sh <@devvit/mcp|@ttsc/graph> [args...]" >&2
    exit 64
    ;;
esac

shift

if [ -n "${MPGD_MISE_BIN:-}" ] && [ -x "$MPGD_MISE_BIN" ]; then
  mise_bin="$MPGD_MISE_BIN"
elif command -v mise >/dev/null 2>&1; then
  mise_bin="$(command -v mise)"
elif [ -n "${HOME:-}" ] && [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
elif [ -x /opt/homebrew/bin/mise ]; then
  mise_bin="/opt/homebrew/bin/mise"
elif [ -x /usr/local/bin/mise ]; then
  mise_bin="/usr/local/bin/mise"
else
  echo "Unable to start $package_name MCP: mise was not found; set MPGD_MISE_BIN." >&2
  exit 127
fi

exec "$mise_bin" exec -- npx -y "$package_name" "$@"
