#!/usr/bin/env bash
# Run the nginx-rtmp ingest gateway locally (no Docker) with SLOT1's publish/play hooks.
# Needs nginx with the RTMP module (Debian/Ubuntu: apt install nginx libnginx-mod-rtmp) and
# INGEST_HOOK_SECRET in .env. Usage: scripts/ingest-gateway.sh start|stop|status
set -euo pipefail
cd "$(dirname "$0")/.."
RUN_DIR="$PWD/.local-services/nginx-rtmp"
CONF="$RUN_DIR/nginx.conf"
mkdir -p "$RUN_DIR"

env_value() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

case "${1:-status}" in
  start)
    secret="$(env_value INGEST_HOOK_SECRET)"
    [ -n "$secret" ] || { echo "Set INGEST_HOOK_SECRET in .env first." >&2; exit 1; }
    port="$(env_value SLOT1_API_PORT)"; port="${port:-4000}"
    # Substitute only the three known variables (same as the image's envsubst call).
    SLOT1_HOOK_BASE="http://127.0.0.1:$port" INGEST_HOOK_SECRET="$secret" INGEST_RTMP_PORT="${INGEST_RTMP_PORT:-1935}" NGINX_RUN_DIR="$RUN_DIR" \
      perl -pe 's/\$\{(SLOT1_HOOK_BASE|INGEST_HOOK_SECRET|INGEST_RTMP_PORT|NGINX_RUN_DIR)\}/$ENV{$1}/g' infra/nginx-rtmp/nginx.conf.template > "$CONF"
    chmod 600 "$CONF"
    nginx -t -c "$CONF" -p "$RUN_DIR" 2>&1 | grep -v "^$" | sed 's/^/  /'
    nginx -c "$CONF" -p "$RUN_DIR" 2>>"$RUN_DIR/error.log"
    echo "nginx-rtmp listening on rtmp://127.0.0.1:1935/live (logs: $RUN_DIR/error.log)"
    ;;
  stop)
    if [ -f "$RUN_DIR/nginx.pid" ]; then nginx -c "$CONF" -p "$RUN_DIR" -s quit 2>/dev/null || kill "$(cat "$RUN_DIR/nginx.pid")" 2>/dev/null || true; fi
    echo "stopped"
    ;;
  status)
    if [ -f "$RUN_DIR/nginx.pid" ] && kill -0 "$(cat "$RUN_DIR/nginx.pid")" 2>/dev/null; then echo "running"; else echo "stopped"; fi
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
