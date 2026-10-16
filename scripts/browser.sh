#!/bin/bash
# Persistent sandbox browser (deploy/browser/compose.yml) on OrbStack.
#   bash scripts/browser.sh up        create the env file if needed, pull and start (idempotent)
#   bash scripts/browser.sh status    container state and the DevTools endpoint's browser version
#   bash scripts/browser.sh viewer    how to open the sign-in viewer (never prints the password)
#   bash scripts/browser.sh down      stop (profile and sign-ins are kept)
#   bash scripts/browser.sh logs      recent container logs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="${YB_DATA_DIR:-$HOME/Library/Application Support/Yeackbot}"
ENV_FILE="$DATA_DIR/browser.env"
COMPOSE="$ROOT/deploy/browser/compose.yml"
DOCKER="${DOCKER:-$HOME/.orbstack/bin/docker}"
VIEWER_URL="https://127.0.0.1:4330"
CDP_URL="http://127.0.0.1:4331"

[ -x "$DOCKER" ] || { echo "OrbStack's docker CLI not found at $DOCKER (open OrbStack once to finish setup)." >&2; exit 1; }
# OrbStack's credential helper (docker-credential-osxkeychain) and compose plugin live next to its docker CLI.
export PATH="$(dirname "$DOCKER"):$PATH"
compose() { "$DOCKER" compose --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }

ensure_env() {
  mkdir -p "$DATA_DIR/browser"
  chmod 700 "$DATA_DIR" "$DATA_DIR/browser"
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    {
      echo "# Sandbox browser settings (scripts/browser.sh). The viewer password protects your signed-in sessions."
      echo "YB_DATA_DIR=\"$DATA_DIR\""
      echo "YB_UID=$(id -u)"
      echo "YB_GID=$(id -g)"
      echo "YB_TZ=$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
      echo "YB_BROWSER_USER=yeackbot"
      echo "YB_BROWSER_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    } > "$ENV_FILE"
    echo "created $ENV_FILE (0600)"
  fi
}

cdp_version() { curl -fsS --max-time 3 "$CDP_URL/json/version" 2>/dev/null | sed -n 's/.*"Browser": *"\([^"]*\)".*/\1/p'; }

case "${1:-status}" in
  up)
    ensure_env
    compose pull --quiet
    compose up -d
    for _ in $(seq 1 30); do v="$(cdp_version)"; [ -n "$v" ] && break; sleep 2; done
    if [ -n "${v:-}" ]; then echo "DevTools ready: $v at $CDP_URL"; else echo "DevTools not answering yet; try: bash scripts/browser.sh status" >&2; fi
    ;;
  status)
    compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
    v="$(cdp_version)"; echo "DevTools: ${v:-not reachable} ($CDP_URL)"
    ;;
  viewer)
    echo "Open $VIEWER_URL (accept the self-signed certificate warning)."
    echo "User: yeackbot. Password: the YB_BROWSER_PASSWORD line in $ENV_FILE"
    ;;
  down) compose stop ;;
  logs) compose logs --tail 100 ;;
  *) echo "usage: $0 up|status|viewer|down|logs" >&2; exit 2 ;;
esac
