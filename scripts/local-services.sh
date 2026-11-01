#!/usr/bin/env bash
# Run PostgreSQL and Redis from locally installed binaries (no Docker), for development and
# integration tests. Data lives in .local-services/ inside the repo and is git-ignored.
#
#   bash scripts/local-services.sh start|stop|status
#
# Ports: Postgres 5433, Redis 6380 (deliberately not the defaults, to avoid clashing with
# services you may already run). Matching URLs:
#   DATABASE_URL=postgres://slot1:slot1@127.0.0.1:5433/slot1
#   REDIS_URL=redis://127.0.0.1:6380
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.local-services"
PG_PORT="${SLOT1_LOCAL_PG_PORT:-5433}"
REDIS_PORT="${SLOT1_LOCAL_REDIS_PORT:-6380}"

find_pg_bin() {
  if command -v pg_ctl >/dev/null 2>&1; then dirname "$(command -v pg_ctl)"; return; fi
  for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin; do
    [ -x "$d/pg_ctl" ] && { echo "$d"; return; }
  done
  echo "PostgreSQL binaries (pg_ctl/initdb) not found. Install PostgreSQL 15+ or use 'docker compose --profile infra up -d'." >&2
  exit 1
}

run_as_pg_user() {
  # initdb/postgres refuse to run as root; use an unprivileged account when needed.
  if [ "$(id -u)" = "0" ]; then
    local user="${SLOT1_LOCAL_PG_USER:-postgres}"
    id "$user" >/dev/null 2>&1 || user="nobody"
    chown -R "$user" "$DATA/pg" "$DATA/pg-run" 2>/dev/null || true
    runuser -u "$user" -- "$@"
  else
    "$@"
  fi
}

start() {
  mkdir -p "$DATA/pg" "$DATA/pg-run" "$DATA/redis"
  local bin; bin="$(find_pg_bin)"
  if [ ! -f "$DATA/pg/PG_VERSION" ]; then
    echo "Initialising PostgreSQL cluster in $DATA/pg"
    local pwfile="$DATA/pg-run/pw"
    echo "slot1" > "$pwfile"; chmod 600 "$pwfile"
    run_as_pg_user "$bin/initdb" -D "$DATA/pg" -U slot1 --pwfile="$pwfile" -A scram-sha-256 >/dev/null
    rm -f "$pwfile"
  fi
  if ! run_as_pg_user "$bin/pg_ctl" -D "$DATA/pg" status >/dev/null 2>&1; then
    run_as_pg_user "$bin/pg_ctl" -D "$DATA/pg" -l "$DATA/pg-run/postgres.log" \
      -o "-p $PG_PORT -k $DATA/pg-run -c listen_addresses=127.0.0.1" start >/dev/null
  fi
  for _ in $(seq 1 30); do
    PGPASSWORD=slot1 psql -h 127.0.0.1 -p "$PG_PORT" -U slot1 -d postgres -Atc "select 1" >/dev/null 2>&1 && break
    sleep 0.5
  done
  PGPASSWORD=slot1 psql -h 127.0.0.1 -p "$PG_PORT" -U slot1 -d postgres -Atc "select 1 from pg_database where datname='slot1'" | grep -q 1 \
    || PGPASSWORD=slot1 psql -h 127.0.0.1 -p "$PG_PORT" -U slot1 -d postgres -c "create database slot1" >/dev/null
  PGPASSWORD=slot1 psql -h 127.0.0.1 -p "$PG_PORT" -U slot1 -d postgres -Atc "select 1 from pg_database where datname='slot1_test'" | grep -q 1 \
    || PGPASSWORD=slot1 psql -h 127.0.0.1 -p "$PG_PORT" -U slot1 -d postgres -c "create database slot1_test" >/dev/null

  if ! command -v redis-server >/dev/null 2>&1; then
    echo "redis-server not found. Install Redis 7+ or use 'docker compose --profile infra up -d'." >&2
    exit 1
  fi
  if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --daemonize yes --dir "$DATA/redis" \
      --logfile "$DATA/redis/redis.log" --save "" --appendonly no >/dev/null
  fi
  for _ in $(seq 1 20); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break; sleep 0.25; done
  echo "PostgreSQL: postgres://slot1:slot1@127.0.0.1:$PG_PORT/slot1 (test db: slot1_test)"
  echo "Redis:      redis://127.0.0.1:$REDIS_PORT"
}

stop() {
  local bin; bin="$(find_pg_bin)"
  run_as_pg_user "$bin/pg_ctl" -D "$DATA/pg" stop -m fast >/dev/null 2>&1 || true
  redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  echo "Stopped local services."
}

status() {
  local bin; bin="$(find_pg_bin)"
  run_as_pg_user "$bin/pg_ctl" -D "$DATA/pg" status || true
  redis-cli -p "$REDIS_PORT" ping || true
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
