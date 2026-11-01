#!/usr/bin/env bash
# Start/stop the three SLOT1 processes (api, worker, web) in the background with PID files.
# Use this when you want them detached; `pnpm dev` runs them in the foreground instead.
#
#   bash scripts/dev-stack.sh start|stop|restart|status [api|worker|web]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.data/run"
LOGS="$ROOT/.data/logs"
mkdir -p "$RUN" "$LOGS"

start_one() {
  local name="$1" dir cmd
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  case "$name" in
    api)    dir="$ROOT/apps/api";    cmd="npx tsx --env-file-if-exists=../../.env src/main.ts" ;;
    worker) dir="$ROOT/apps/worker"; cmd="npx tsx --env-file-if-exists=../../.env src/main.ts" ;;
    web)    dir="$ROOT/apps/web";    cmd="set -a; [ -f '$ROOT/.env' ] && . '$ROOT/.env'; set +a; exec npx next dev --port 3000" ;;
    *) echo "unknown service $name" >&2; return 1 ;;
  esac
  # The bash below becomes a session leader; its PID is the process-group id of everything it starts.
  setsid bash -c "echo \$\$ > '$RUN/$name.pid'; cd '$dir' && $cmd" >"$LOGS/$name.log" 2>&1 </dev/null &
  sleep 0.3
  echo "started $name (log: .data/logs/$name.log)"
}

stop_one() {
  local name="$1" pid
  [ -f "$RUN/$name.pid" ] || { echo "$name not running"; return; }
  pid="$(cat "$RUN/$name.pid")"
  # Kill the whole process group started by setsid.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$RUN/$name.pid"
  echo "stopped $name"
}

targets=("${@:2}")
[ ${#targets[@]} -eq 0 ] && targets=(api worker web)
case "${1:-status}" in
  start) for t in "${targets[@]}"; do start_one "$t"; done ;;
  stop) for t in "${targets[@]}"; do stop_one "$t"; done ;;
  restart) for t in "${targets[@]}"; do stop_one "$t"; start_one "$t"; done ;;
  status) for t in "${targets[@]}"; do if [ -f "$RUN/$t.pid" ] && kill -0 "$(cat "$RUN/$t.pid")" 2>/dev/null; then echo "$t running"; else echo "$t stopped"; fi; done ;;
  *) echo "usage: $0 start|stop|restart|status [api|worker|web]" >&2; exit 2 ;;
esac
