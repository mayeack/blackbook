#!/bin/bash
# Runs the yeackbot server as a macOS LaunchAgent (com.yeackbot.server): it starts at login and launchd restarts
# it if it ever stops. Plain node on the prebuilt bundle (no npm or tsx at runtime). The plist comes from
# deploy/com.yeackbot.server.plist with REPO_PATH filled in. Production runs from a stable checkout
# (e.g. ~/Blackbook on main), never from .claude/worktrees/…: cleaning up a worktree would delete production.
#
#   bash scripts/service.sh install    test, build, write the LaunchAgent and start it
#   bash scripts/service.sh restart    test, build, then restart (use after changing the code)
#   bash scripts/service.sh start      start without building
#   bash scripts/service.sh reload     restart without building (e.g. after changing .env)
#   bash scripts/service.sh stop       stop until the next start or login
#   bash scripts/service.sh status     launchd state and a health check
#   bash scripts/service.sh uninstall  stop and remove the LaunchAgent
set -euo pipefail

LABEL="com.yeackbot.server"
# Physical path (-P): a symlink to a worktree must not slip past require_stable_checkout.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE="$ROOT/deploy/$LABEL.plist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE="/opt/homebrew/bin/node"
BUNDLE="$ROOT/packages/server/dist/index.js"

say() { printf '%s\n' "$*"; }
die() { printf 'service: %s\n' "$*" >&2; exit 1; }

# PORT from .env if set there (the server reads the same file), else the default.
env_port() {
  local p=""
  [ -f "$ROOT/.env" ] && p="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/.env" | tail -n1)"
  printf '%s' "${p:-4320}"
}
PORT="$(env_port)"
URL="http://127.0.0.1:$PORT"

# Refuses to run production from a disposable worktree: any linked git worktree (its git dir differs from the
# common dir), wherever it lives, and anything under .claude/worktrees.
require_stable_checkout() {
  case "$ROOT/" in
    */.claude/worktrees/*)
      die "refusing: $ROOT is a .claude/worktrees checkout. Install from the stable checkout (e.g. ~/Blackbook on main)."
      ;;
  esac
  local git_dir common_dir
  git_dir="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  common_dir="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$git_dir" ] && [ "$git_dir" != "$common_dir" ]; then
    die "refusing: $ROOT is a linked git worktree. Install from the main checkout (e.g. ~/Blackbook on main)."
  fi
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

port_owner() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true; }

# launchctl bootout returns before the job is fully gone; wait so a following bootstrap doesn't race it.
unload() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 40); do
    loaded || return 0
    sleep 0.25
  done
  die "launchd did not unload $LABEL within 10s."
}

service_pid() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tpid = / { print $3; exit }'; }

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
sed_escape() { sed -e 's/[\\|&]/\\&/g' <<<"$1"; }

# Tests must pass before a new build replaces the running server.
build() {
  say "Testing…"
  (cd "$ROOT" && npx vitest run --reporter=dot) || die "tests failed; the running server was left as it was."
  say "Building…"
  (cd "$ROOT" && npm run build --silent) || die "build failed; the running server was left as it was."
}

write_plist() {
  require_stable_checkout
  [ -x "$NODE" ] || die "$NODE not found (brew install node, then brew pin node)."
  [ -f "$TEMPLATE" ] || die "missing template $TEMPLATE"
  mkdir -p "$(dirname "$PLIST")"
  sed "s|REPO_PATH|$(sed_escape "$(xml_escape "$ROOT")")|g" "$TEMPLATE" >"$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "wrote an invalid plist: $PLIST"
}

# Refuses to start while something other than this service holds the port (e.g. "npm run dev" in a terminal).
check_port_free() {
  local owner svc
  owner="$(port_owner)"
  [ -z "$owner" ] && return 0
  svc="$(service_pid || true)"
  [ -n "$svc" ] && [ "$owner" = "$svc" ] && return 0
  die "port $PORT is in use by pid $owner. Stop it first."
}

wait_healthy() {
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 "$URL/healthz" >/dev/null 2>&1; then
      say "Running at $URL"
      return 0
    fi
    sleep 0.5
  done
  die "no answer at $URL/healthz within 20s. Logs: ~/Library/Application Support/Yeackbot/logs; or stop the service and run \"NODE_ENV=production node --env-file-if-exists=.env packages/server/dist/index.js\" to see boot errors."
}

start() {
  [ -f "$BUNDLE" ] || build
  [ -f "$PLIST" ] || write_plist
  if loaded; then
    launchctl kickstart "$DOMAIN/$LABEL"
  else
    check_port_free
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  wait_healthy
}

case "${1:-}" in
  install)
    require_stable_checkout
    build
    unload
    check_port_free
    write_plist
    launchctl bootstrap "$DOMAIN" "$PLIST"
    wait_healthy
    say "Installed: starts at login and restarts automatically ($PLIST)."
    ;;
  restart)
    require_stable_checkout
    build
    if loaded; then
      launchctl kickstart -k "$DOMAIN/$LABEL" # SIGTERM → graceful shutdown → launchd starts it again
      wait_healthy
    else
      start
    fi
    ;;
  start)
    require_stable_checkout
    start
    ;;
  reload)
    require_stable_checkout
    if loaded; then
      launchctl kickstart -k "$DOMAIN/$LABEL"
      wait_healthy
    else
      start
    fi
    ;;
  stop)
    if loaded; then
      unload
      say "Stopped. It starts again at next login, or with \"npm run service:start\"."
    else
      say "Not running."
    fi
    ;;
  status)
    if loaded; then
      launchctl print "$DOMAIN/$LABEL" | awk '/^\t(state|pid|runs|last exit code) = / { sub(/^\t/, ""); print }'
    else
      say "Not loaded (run \"npm run service:install\" from the stable checkout)."
    fi
    if curl -fsS --max-time 2 "$URL/healthz" 2>/dev/null; then echo; else say "No answer at $URL/healthz"; fi
    ;;
  uninstall)
    unload
    rm -f "$PLIST"
    say "Removed the LaunchAgent."
    ;;
  *)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
