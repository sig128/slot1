#!/usr/bin/env bash
# SLOT1 on one Ubuntu server (written for Hetzner Cloud; any Ubuntu/Debian host with a public IPv4
# works). Run as root. See docs/DEPLOY_HETZNER.md.
#
# First install: downloads the code, writes .env with fresh random secrets, builds, starts:
#   curl -fsSL https://raw.githubusercontent.com/sig128/slot1/main/scripts/server-setup.sh | bash
#
# The server updates itself: every minute it checks the branch it was installed from, and when
# there is a new version it rebuilds and restarts by itself (see "slot1 autodeploy").
#
# The `slot1` command on the server:
#   slot1 update        get the latest code now, rebuild and restart (keeps .env and all data)
#   slot1 autodeploy on|off|status   automatic updates (on by default)
#   slot1 twitch        enter your Twitch app's Client ID and Secret (turns on "Sign in with Twitch")
#   slot1 ai            enter an Anthropic API key (turns on the AI that watches streams)
#   slot1 domain NAME   move to your own domain (point its A record at this server first)
#   slot1 admins NAMES  set the Twitch usernames that are SLOT1 admins (comma-separated)
#   slot1 admin-password  set (or change) the password for the /admin dashboard
#   slot1 admin-link    print a one-time link that signs you in to the /admin dashboard
#   slot1 legal         business name, address, contact email and governing law for the legal pages
#   slot1 seo           Google / Bing site-verification codes
#   slot1 status        what is running, and whether the site answers
#   slot1 logs [name]   follow the logs (api, worker, web, inference, mediamtx, caddy, ...)
#
# First-install overrides: SLOT1_DOMAIN (default <ip-with-dashes>.sslip.io, a free name that points
# at this server), SLOT1_GATEWAY (mediamtx = sub-second video on the site, default; or nginx-rtmp),
# SLOT1_DIR (default /opt/slot1), SLOT1_BRANCH (default main).
set -euo pipefail

REPO_URL="${SLOT1_REPO_URL:-https://github.com/sig128/slot1.git}"
BRANCH="${SLOT1_BRANCH:-main}"
DIR="${SLOT1_DIR:-/opt/slot1}"
ENV_FILE="$DIR/.env"

say() { printf '\n\033[1;95m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\n\033[1;91mSLOT1 setup stopped:\033[0m %s\n' "$*" >&2
  exit 1
}

need_root() {
  [ "$(id -u)" -eq 0 ] || die "run this as root (ssh root@<server>), or put sudo in front of it."
}

need_env() {
  [ -f "$ENV_FILE" ] || die "SLOT1 is not installed in $DIR yet. Run the install command first (docs/DEPLOY_HETZNER.md)."
}

# --- .env helpers ----------------------------------------------------------------------------

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

# env_set KEY VALUE: replace the KEY= line in .env, or append it. Values are written verbatim.
env_set() {
  local tmp
  tmp="$(mktemp "$DIR/.env.XXXXXX")"
  KEY="$1" VALUE="$2" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

rand_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_key32() { openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '@ '; }

# --- server preparation ----------------------------------------------------------------------

wait_for_first_boot() {
  # A brand-new server may still be running its first-boot setup (cloud-init installs Docker).
  if command -v cloud-init >/dev/null 2>&1 && ! cloud-init status 2>/dev/null | grep -q -E "done|disabled"; then
    say "Waiting for the server's first-boot setup to finish"
    cloud-init status --wait >/dev/null 2>&1 || true
  fi
}

ensure_tools() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  if [ "${#missing[@]}" -gt 0 ]; then
    say "Installing ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" ca-certificates
  fi
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  if ! docker compose version >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose is missing (apt-get install docker-compose-plugin)."
}

ensure_swap() {
  # Building the web app needs more memory than small servers have; swap prevents a crash.
  local mem_mb
  mem_mb="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
  if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ "$mem_mb" -lt 12000 ] && [ ! -f /swapfile ]; then
    say "Adding a 4 GB swap file (this server has ${mem_mb} MB of memory)"
    fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
}

fetch_code() {
  if [ -d "$DIR/.git" ]; then
    say "Getting the latest code"
    git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH"
    git -C "$DIR" reset --quiet --hard FETCH_HEAD
  else
    say "Downloading SLOT1 into $DIR"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$DIR" ||
      die "could not download $REPO_URL. If the repository is private, the server needs access to it."
  fi
  note "Version: $(git -C "$DIR" log -1 --format='%h, %cd' --date=format:'%Y-%m-%d %H:%M')"
}

public_ipv4() {
  local ip
  ip="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
  case "$ip" in
    "" | 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.*)
      ip="$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
      ;;
  esac
  printf '%s' "$ip"
}

# The `slot1` command. It stays small and changes rarely: it is also what deploys new versions, so
# a broken server script in a later version can't stop the next fix from arriving.
install_cli() {
  local cli="${SLOT1_CLI:-/usr/local/bin/slot1}" tmp
  tmp="$(mktemp "$(dirname "$cli")/.slot1.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'SLOT1_DIR=%q\n' "$DIR"
    cat <<'EOF'
# The slot1 command, installed by SLOT1's scripts/server-setup.sh ("slot1 help" lists commands).
# It runs the server script from a copy, so an update can replace the script safely.
# "slot1 tick" runs every minute (slot1-tick.timer) and deploys new versions by itself.
set -euo pipefail
DIR="$SLOT1_DIR"
STATE="$DIR/state"
LOCK="${SLOT1_LOCK:-/run/slot1.lock}"

run_script() {
  local tmp rc=0
  tmp="$(mktemp)"
  cp "$DIR/scripts/server-setup.sh" "$tmp"
  SLOT1_DIR="$DIR" bash "$tmp" "$@" || rc=$?
  rm -f "$tmp"
  return "$rc"
}

get_latest() {
  git -C "$DIR" fetch --quiet --depth 1 origin "$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
  git -C "$DIR" reset --quiet --hard FETCH_HEAD
}

deploy_status() {
  mkdir -p "$STATE/outbox"
  printf '{"state":"%s","commit":"%s","at":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATE/outbox/deploy.json.tmp"
  chmod 644 "$STATE/outbox/deploy.json.tmp"
  mv -f "$STATE/outbox/deploy.json.tmp" "$STATE/outbox/deploy.json"
}

tick() {
  exec 9>"$LOCK"
  flock -n 9 || return 0 # an update is already running
  if compgen -G "$STATE/inbox/*.settings" >/dev/null; then
    SLOT1_UNATTENDED=1 run_script apply-settings || true
  fi
  if grep -q '^SLOT1_AUTODEPLOY=false' "$DIR/.env" 2>/dev/null; then return 0; fi
  local branch remote deployed head f_sha="" f_tries=0 f_at=0
  branch="$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
  remote="$(timeout 60 git -C "$DIR" ls-remote origin "refs/heads/$branch" 2>/dev/null | cut -f1 || true)"
  # No answer from GitHub: try again next minute.
  [[ "$remote" =~ ^[0-9a-f]{40}$ ]] || return 0
  deployed="$(cat "$STATE/deployed" 2>/dev/null || true)"
  [ "$remote" != "$deployed" ] || return 0
  if [ -f "$STATE/deploy-failed" ]; then
    read -r f_sha f_tries f_at <"$STATE/deploy-failed" || true
    [[ "${f_tries:-}" =~ ^[0-9]+$ ]] || f_tries=0
    [[ "${f_at:-}" =~ ^[0-9]+$ ]] || f_at=0
    if [ "$f_sha" = "$remote" ]; then
      # A version that failed is tried at most 3 times, 10 minutes apart.
      [ "${f_tries:-0}" -lt 3 ] || return 0
      [ $(($(date +%s) - ${f_at:-0})) -ge 600 ] || return 0
    else
      f_tries=0
    fi
  fi
  deploy_status building "$remote"
  export SLOT1_UNATTENDED=1
  if { get_latest && run_script update; } >"$STATE/outbox/deploy.log" 2>&1; then
    rm -f "$STATE/deploy-failed"
    deploy_status live "$(git -C "$DIR" rev-parse HEAD)"
  else
    head="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || printf '%s' "$remote")"
    printf '%s %s %s\n' "$head" "$((${f_tries:-0} + 1))" "$(date +%s)" >"$STATE/deploy-failed"
    deploy_status failed "$head"
  fi
  chmod 644 "$STATE/outbox/deploy.log" 2>/dev/null || true
}

case "${1:-}" in
  tick)
    tick
    exit 0
    ;;
  update)
    exec 9>"$LOCK"
    if ! flock -n 9; then
      echo "An automatic update is running. Waiting for it to finish..."
      flock 9
    fi
    get_latest
    ;;
esac
run_script "$@"
EOF
  } >"$tmp"
  if ! bash -n "$tmp"; then
    rm -f "$tmp"
    die "the new slot1 command didn't pass a syntax check; keeping the old one."
  fi
  chmod 755 "$tmp"
  # A new file, not an in-place rewrite: a running slot1 keeps reading its own copy.
  mv -f "$tmp" "$cli"
}

# Every minute: deploy new versions (unless SLOT1_AUTODEPLOY=false) and apply waiting settings.
install_autodeploy() {
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    note "Automatic updates need systemd, which this server doesn't run. Use slot1 update instead."
    return 0
  fi
  cat >/etc/systemd/system/slot1-tick.service <<'EOF'
[Unit]
Description=SLOT1 automatic updates
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/usr/local/bin/slot1 tick
Nice=5
TimeoutStartSec=90min
EOF
  cat >/etc/systemd/system/slot1-tick.timer <<'EOF'
[Unit]
Description=SLOT1 automatic updates: check every minute

[Timer]
OnActiveSec=30s
OnUnitInactiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now slot1-tick.timer >/dev/null 2>&1 || note "Couldn't start the update timer (systemctl status slot1-tick.timer)."
  if [ "$(env_get SLOT1_AUTODEPLOY)" = "false" ]; then
    note "Automatic updates: off (turn on with: slot1 autodeploy on)"
  else
    note "Automatic updates: on. New versions go live by themselves within a few minutes."
  fi
}

# The state folder is shared with the API container (user 1000): it reads the deploy status from
# outbox/, and inbox/ is where it leaves settings saved in /admin for the server to apply.
ensure_state_dir() {
  install -d -m 755 "$DIR/state" "$DIR/state/outbox"
  install -d -m 700 -o 1000 -g 1000 "$DIR/state/inbox"
}

record_deployed() {
  local sha
  sha="$(git -C "$DIR" rev-parse HEAD)"
  printf '%s\n' "$sha" >"$DIR/state/deployed"
  printf '{"state":"live","commit":"%s","at":"%s"}\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$DIR/state/outbox/deploy.json"
  chmod 644 "$DIR/state/outbox/deploy.json"
}

# --- configuration ---------------------------------------------------------------------------

apply_domain() {
  local domain="$1" ip="$2"
  env_set SLOT1_DOMAIN "$domain"
  env_set SLOT1_PUBLIC_ORIGIN "https://$domain"
  env_set TWITCH_REDIRECT_URI "https://$domain/api/auth/twitch/callback"
  env_set TWITCH_EVENTSUB_CALLBACK_URL "https://$domain/api/twitch/eventsub"
  env_set TWITCH_EMBED_PARENTS "$domain"
  env_set INGEST_PUBLIC_RTMP_URL "rtmp://$domain:1935/live"
  # WebRTC media (UDP 8189) is offered to browsers at this address.
  env_set MEDIAMTX_PUBLIC_HOST "$ip"
}

apply_gateway() {
  case "$1" in
    mediamtx)
      env_set INGEST_GATEWAY mediamtx
      env_set INGEST_READ_URL_TEMPLATE 'rtsp://{user}:{password}@mediamtx:8554/{path}'
      # Caddy serves MediaMTX's WHEP/WHIP under https://<domain>/live/* (infra/caddy/Caddyfile).
      env_set INGEST_PUBLIC_WEBRTC_URL "$(env_get SLOT1_PUBLIC_ORIGIN)"
      ;;
    nginx-rtmp)
      env_set INGEST_GATEWAY nginx-rtmp
      env_set INGEST_READ_URL_TEMPLATE 'rtmp://ingest:1935/{path}?reader={password}'
      env_set INGEST_PUBLIC_WEBRTC_URL ""
      ;;
    *) die "SLOT1_GATEWAY must be mediamtx or nginx-rtmp (got: $1)." ;;
  esac
}

# Settings added after a server's first install get their defaults here; existing values stay.
ensure_env_defaults() {
  # The demo stream was removed (SLOT1 shows real streams only): switch it off on older installs.
  if [ "$(env_get SLOT1_DEMO)" != "false" ]; then env_set SLOT1_DEMO false; fi
  if [ -z "$(env_get SLOT1_AUTODEPLOY)" ]; then env_set SLOT1_AUTODEPLOY true; fi
}

# Free text for .env: one line, without characters the env-file format would interpret.
clean_text() { printf '%s' "$1" | tr -d '\r\n$`"\\#' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# ask_keep KEY "Question": shows the current value; Enter keeps it, "-" clears it.
ask_keep() {
  local key="$1" question="$2" current answer
  current="$(env_get "$key")"
  read -r -p "$question [${current:-not set}]: " answer </dev/tty
  case "$answer" in
    "") ;;
    -) env_set "$key" "" ;;
    *) env_set "$key" "$(clean_text "$answer")" ;;
  esac
}

create_env() {
  local domain="$1" ip="$2" gateway="$3"
  cp "$DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  env_set NODE_ENV production
  env_set SLOT1_TRUST_PROXY true
  env_set SLOT1_ALLOW_LOCAL_LOGIN false
  env_set SLOT1_SESSION_SECRET "$(rand_hex 32)"
  env_set SLOT1_TOKEN_ENCRYPTION_KEYS "k1:$(rand_key32)"
  env_set POSTGRES_PASSWORD "$(rand_hex 24)"
  env_set TWITCH_EVENTSUB_SECRET "$(rand_hex 32)"
  env_set INGEST_READ_PASSWORD "$(rand_hex 24)"
  env_set INGEST_HOOK_SECRET "$(rand_hex 32)"
  # Workers share one GTA-model service instead of each loading the model.
  env_set INFERENCE_URL http://inference:4100
  env_set INFERENCE_SHARED_SECRET "$(rand_hex 32)"
  apply_domain "$domain" "$ip"
  apply_gateway "$gateway"
}

# --- docker compose --------------------------------------------------------------------------

compose() {
  local extra=()
  case "$(env_get INGEST_GATEWAY)" in
    mediamtx) extra+=(--profile mediamtx) ;;
    nginx-rtmp) extra+=(--profile ingest) ;;
  esac
  docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" \
    --profile infra --profile app --profile edge "${extra[@]}" "$@"
}

start_stack() {
  # Only one ingest gateway can hold port 1935: remove the one that is not in use.
  case "$(env_get INGEST_GATEWAY)" in
    mediamtx) docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --profile ingest rm -sf ingest >/dev/null 2>&1 || true ;;
    nginx-rtmp) docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --profile mediamtx rm -sf mediamtx >/dev/null 2>&1 || true ;;
  esac
  # The demo stream was removed from SLOT1: take down a demo container left by an older version.
  docker ps -aq --filter label=com.docker.compose.project=slot1 --filter label=com.docker.compose.service=demo |
    xargs -r docker rm -f >/dev/null 2>&1 || true
  say "Building SLOT1 (the first build takes about 5 to 15 minutes)"
  # The API image builds the shared stages once; the worker, inference and web images reuse them.
  compose build api
  compose build
  say "Starting SLOT1"
  compose up -d --remove-orphans
}

# The legal and SEO settings are read by the web server on each request: only it needs recreating.
restart_web() {
  say "Restarting the website with the new settings"
  compose up -d --force-recreate --no-deps web
  wait_healthy
}

restart_apps() {
  say "Restarting SLOT1 with the new settings"
  # Recreate (not just restart) so the containers read the updated .env.
  compose up -d --force-recreate --no-deps api worker inference web
  wait_healthy
}

wait_healthy() {
  local domain _
  domain="$(env_get SLOT1_DOMAIN)"
  say "Checking that SLOT1 answers"
  for _ in $(seq 1 60); do
    curl -fsS --max-time 5 http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break
    sleep 5
  done
  if ! curl -fsS --max-time 5 http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    compose ps
    compose logs --tail 80 api
    die "the API did not start (its log is above). Paste it to whoever is helping you."
  fi
  note "API: ok"
  for _ in $(seq 1 36); do
    if curl -fsS --max-time 10 "https://$domain/api/health" >/dev/null 2>&1; then
      note "Website over HTTPS: ok"
      return 0
    fi
    sleep 5
  done
  compose logs --tail 40 caddy
  note "The website is not answering over HTTPS yet. Usually the certificate is still being issued."
  note "Check that TCP ports 80 and 443 are open in the server's firewall, wait a minute, then run: slot1 status"
  return 0
}

print_summary() {
  local domain origin
  domain="$(env_get SLOT1_DOMAIN)"
  origin="https://$domain"
  printf '\n\033[1;95m  SLOT1 is live:  %s\033[0m\n\n' "$origin"
  if [ -z "$(env_get TWITCH_CLIENT_ID)" ]; then
    cat <<EOF
  To turn on "Sign in with Twitch" (once, about 2 minutes):
    1. Open https://dev.twitch.tv/console/apps/create (Twitch asks for two-factor login first).
    2. Name: any unique name. OAuth Redirect URLs: $origin/api/auth/twitch/callback
       Category: Website Integration. Client Type: Confidential. Click Create.
    3. Click Manage, copy the Client ID, click "New Secret" and copy the secret.
    4. Back here, run:  slot1 twitch

EOF
  fi
  if [ "$(env_get VISION_PROVIDER)" = "none" ] || [ -z "$(env_get VISION_PROVIDER)" ]; then
    cat <<EOF
  To let the AI watch streams, run:  slot1 ai   (asks for an Anthropic API key)

EOF
  fi
  cat <<EOF
  Admin dashboard: $origin/admin (your admin password, or sign in with an admin Twitch
  username). A one-time sign-in link: slot1 admin-link
  Business details on the legal pages: slot1 legal
  Updates: automatic. New versions go live by themselves (slot1 autodeploy status).

  Streaming from OBS: sign in, open Studio, then "Stream setup" does it in one click.
  Server for OBS: rtmp://$domain:1935/live (the stream key is shown in Studio).
  Firewall: TCP 22, 80, 443, 1935 and UDP 8189 must be open.

  Useful: slot1 status | slot1 logs api | slot1 update
EOF
}

# --- commands --------------------------------------------------------------------------------

cmd_install() {
  need_root
  wait_for_first_boot
  ensure_tools
  ensure_docker
  ensure_swap
  # Asked before the long build, so nobody has to wait at the terminal for the questions.
  if [ -f "$ENV_FILE" ]; then first_time_questions; fi
  fetch_code
  local ip domain gateway
  ip="$(public_ipv4)"
  [ -n "$ip" ] || die "could not find this server's public IPv4 address."
  if [ ! -f "$ENV_FILE" ]; then
    domain="${SLOT1_DOMAIN:-${ip//./-}.sslip.io}"
    gateway="${SLOT1_GATEWAY:-mediamtx}"
    say "Writing $ENV_FILE with new random secrets"
    create_env "$domain" "$ip" "$gateway"
    note "Address: https://$domain"
  else
    note "Keeping $ENV_FILE (secrets and settings unchanged)"
    if [ -n "${SLOT1_DOMAIN:-}" ] && [ "$SLOT1_DOMAIN" != "$(env_get SLOT1_DOMAIN)" ]; then
      apply_domain "$SLOT1_DOMAIN" "$ip"
      apply_gateway "$(env_get INGEST_GATEWAY)"
    fi
    if [ -n "${SLOT1_GATEWAY:-}" ]; then apply_gateway "$SLOT1_GATEWAY"; fi
    if [ "$(env_get MEDIAMTX_PUBLIC_HOST)" != "$ip" ]; then env_set MEDIAMTX_PUBLIC_HOST "$ip"; fi
  fi
  ensure_env_defaults
  ensure_state_dir
  # Shown in /admin → System, so it's clear which version is running.
  env_set SLOT1_VERSION "$(git -C "$DIR" rev-parse --short HEAD)"
  install_cli
  start_stack
  wait_healthy
  save_pending_admin_password
  record_deployed
  install_autodeploy
  if [ -z "${SLOT1_UNATTENDED:-}" ]; then print_summary; fi
}

# Only in a terminal (never during an automatic update) and only once per server.
interactive() {
  [ -z "${SLOT1_UNATTENDED:-}" ] && [ -t 1 ] && { true </dev/tty; } 2>/dev/null
}

PENDING_ADMIN_PW=""
first_time_questions() {
  interactive || return 0
  [ ! -f "$DIR/state/setup-asked" ] || return 0
  local current answer pw pw2
  say "Two quick questions (only this once)"
  current="$(env_get SLOT1_OPERATOR_TWITCH_LOGINS)"
  read -r -p "    Your Twitch username, for admin access [${current:-not set}]: " answer </dev/tty
  answer="$(lower "$answer")"
  if [ -n "$answer" ]; then
    env_set SLOT1_OPERATOR_TWITCH_LOGINS "$answer"
    note "Admin Twitch username: $answer"
  fi
  if [ -z "$(env_get SLOT1_ADMIN_PASSWORD_HASH)" ]; then
    while :; do
      read -r -s -p "    A password for your admin page (12+ characters, not shown; Enter skips): " pw </dev/tty
      printf '\n'
      if [ -z "$pw" ]; then
        note "Skipped. Set one any time with: slot1 admin-password"
        break
      fi
      if [ "${#pw}" -lt 12 ]; then
        note "That's ${#pw} characters. Use at least 12."
        continue
      fi
      read -r -s -p "    Same again: " pw2 </dev/tty
      printf '\n'
      if [ "$pw" = "$pw2" ]; then
        PENDING_ADMIN_PW="$pw"
        break
      fi
      note "Those didn't match. Once more."
    done
    unset pw pw2
  fi
  mkdir -p "$DIR/state"
  : >"$DIR/state/setup-asked"
  note "Thanks. The rest runs by itself (about 5 to 15 minutes)."
}

# Hashes a password with the API's own tool (scrypt) and stores the hash in .env.
store_admin_password() {
  local out line
  # The password goes in on stdin (never as an argument), so it can't show up in the process list.
  if ! out="$(printf '%s' "$1" | compose exec -T api node dist/admin-password.js 2>&1)"; then
    printf '%s\n' "$out" >&2
    return 1
  fi
  line="$(printf '%s\n' "$out" | tail -n 1)"
  case "$line" in
    SLOT1_ADMIN_PASSWORD_HASH=scrypt\$*) ;;
    *) return 1 ;;
  esac
  # Single quotes: the hash contains "$", which Compose would otherwise read as variables.
  env_set SLOT1_ADMIN_PASSWORD_HASH "'${line#SLOT1_ADMIN_PASSWORD_HASH=}'"
}

save_pending_admin_password() {
  [ -n "$PENDING_ADMIN_PW" ] || return 0
  if store_admin_password "$PENDING_ADMIN_PW"; then
    PENDING_ADMIN_PW=""
    compose up -d --force-recreate --no-deps api >/dev/null 2>&1
    wait_healthy
    note "Admin password saved. Sign in at $(env_get SLOT1_PUBLIC_ORIGIN)/admin"
  else
    PENDING_ADMIN_PW=""
    note "Couldn't save the admin password. Set it with: slot1 admin-password"
  fi
}

cmd_twitch() {
  need_root
  need_env
  local id secret me bot
  printf 'Twitch app (https://dev.twitch.tv/console/apps). Redirect URL to register:\n  %s/api/auth/twitch/callback\n\n' "$(env_get SLOT1_PUBLIC_ORIGIN)"
  read -r -p "Client ID: " id </dev/tty
  read -r -s -p "Client Secret (hidden while you paste): " secret </dev/tty
  printf '\n'
  read -r -p "Your Twitch username: makes you a SLOT1 admin (several: comma-separated; Enter to skip): " me </dev/tty
  read -r -p "The bot account's Twitch username (Enter to skip): " bot </dev/tty
  id="$(printf '%s' "$id" | tr -d '[:space:]')"
  secret="$(printf '%s' "$secret" | tr -d '[:space:]')"
  if [ -z "$id" ] || [ -z "$secret" ]; then die "both the Client ID and the Client Secret are needed."; fi
  env_set TWITCH_CLIENT_ID "$id"
  env_set TWITCH_CLIENT_SECRET "$secret"
  if [ -n "$me" ]; then env_set SLOT1_OPERATOR_TWITCH_LOGINS "$(lower "$me")"; fi
  if [ -n "$bot" ]; then env_set SLOT1_BOT_TWITCH_LOGIN "$(lower "$bot")"; fi
  restart_apps
  note "Done. Open $(env_get SLOT1_PUBLIC_ORIGIN) and sign in with Twitch."
}

cmd_ai() {
  need_root
  need_env
  local key
  read -r -s -p "Anthropic API key (hidden while you paste): " key </dev/tty
  printf '\n'
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  [ -n "$key" ] || die "no key entered."
  env_set VISION_PROVIDER anthropic
  env_set ANTHROPIC_API_KEY "$key"
  restart_apps
  note "Done. The AI analyzes streams and replays from now on (usage is billed by Anthropic)."
}

cmd_domain() {
  need_root
  need_env
  local domain="${1:-}" ip resolved
  [ -n "$domain" ] || die "usage: slot1 domain slot1.example.com"
  domain="$(lower "$domain")"
  ip="$(public_ipv4)"
  resolved="$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
  if [ "$resolved" != "$ip" ] && [ "${SLOT1_FORCE:-}" != 1 ]; then
    # Switching early makes the certificate requests fail, and Let's Encrypt then pauses new
    # attempts for that name for up to an hour.
    die "$domain points to ${resolved:-nothing}, not this server ($ip). Set its A record (host @) to $ip, wait until it shows up (a few minutes to half an hour), then run this again. To switch anyway: SLOT1_FORCE=1 slot1 domain $domain"
  fi
  local www
  www="$(getent ahostsv4 "www.$domain" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
  if [ "$www" != "$ip" ]; then
    note "Note: www.$domain doesn't point here yet. Add an A record for host www to $ip so www.$domain redirects to $domain."
  fi
  apply_domain "$domain" "$ip"
  apply_gateway "$(env_get INGEST_GATEWAY)"
  say "Switching to https://$domain"
  compose up -d --force-recreate
  wait_healthy
  note "Also update the OAuth Redirect URL on your Twitch app to https://$domain/api/auth/twitch/callback"
  print_summary
}

cmd_admin_password() {
  need_root
  need_env
  local pw pw2
  read -r -s -p "New admin password (12+ characters): " pw </dev/tty
  printf '\n'
  read -r -s -p "Same again: " pw2 </dev/tty
  printf '\n'
  if [ "$pw" != "$pw2" ]; then die "the passwords don't match."; fi
  if [ "${#pw}" -lt 12 ]; then die "use at least 12 characters."; fi
  if ! store_admin_password "$pw"; then
    unset pw pw2
    die "could not set the password. Is SLOT1 up to date and running? Try: slot1 update"
  fi
  unset pw pw2
  say "Restarting the API with the new password"
  compose up -d --force-recreate --no-deps api
  wait_healthy
  note "Done. Sign in at $(env_get SLOT1_PUBLIC_ORIGIN)/admin (earlier admin sessions are signed out)."
}

cmd_admin_link() {
  need_root
  need_env
  local out
  if ! out="$(compose exec -T api node dist/admin-link.js 2>&1)"; then
    printf '%s\n' "$out"
    die "could not create the admin link. Is the API running? Check with: slot1 status"
  fi
  printf '\n  Open this link within 15 minutes. It works once and signs you in to /admin:\n\n  %s\n\n' \
    "$(printf '%s\n' "$out" | tail -n 1)"
}

cmd_demo() {
  note "The demo stream was removed: SLOT1 shows real streams only."
}

cmd_autodeploy() {
  need_root
  need_env
  case "${1:-status}" in
    on)
      env_set SLOT1_AUTODEPLOY true
      install_autodeploy
      ;;
    off)
      env_set SLOT1_AUTODEPLOY false
      install_autodeploy
      ;;
    status)
      printf 'Automatic updates: %s\n' "$([ "$(env_get SLOT1_AUTODEPLOY)" = "false" ] && echo off || echo on)"
      printf 'Running version:   %s\n' "$(cut -c1-7 "$DIR/state/deployed" 2>/dev/null || echo unknown)"
      printf 'Last update:       %s\n' "$(cat "$DIR/state/outbox/deploy.json" 2>/dev/null || echo none)"
      if [ -f "$DIR/state/deploy-failed" ]; then
        printf 'Failed version:    %s (the last lines of its log follow)\n' "$(cut -c1-7 "$DIR/state/deploy-failed")"
        tail -n 30 "$DIR/state/outbox/deploy.log" 2>/dev/null || true
      fi
      systemctl list-timers slot1-tick.timer --no-pager 2>/dev/null | head -n 2 || true
      ;;
    *) die "usage: slot1 autodeploy on|off|status" ;;
  esac
}

# --- settings saved in /admin ----------------------------------------------------------------
#
# The API can't edit .env itself. When an admin saves settings in the browser, it writes a request
# to state/inbox/<id>.settings; "slot1 tick" (every minute) checks it here and applies it:
#   slot1-settings v1
#   set KEY BASE64-VALUE
#   clear KEY
# Only the keys below are accepted, each with its own format check, and a request with anything
# else is refused as a whole. The answer goes to state/outbox/settings-<id>.json.

setting_ok() {
  local key="$1" v="$2"
  case "$key" in
    TWITCH_CLIENT_ID | TWITCH_CLIENT_SECRET) [[ "$v" =~ ^[a-z0-9]{20,64}$ ]] ;;
    SLOT1_OPERATOR_TWITCH_LOGINS) [[ "$v" =~ ^[a-z0-9_]{1,25}(,[a-z0-9_]{1,25}){0,9}$ ]] ;;
    SLOT1_BOT_TWITCH_LOGIN) [[ "$v" =~ ^[a-z0-9_]{1,25}$ ]] ;;
    ANTHROPIC_API_KEY) [[ "$v" =~ ^[A-Za-z0-9_-]{20,300}$ ]] ;;
    VISION_PROVIDER) [[ "$v" =~ ^(anthropic|none)$ ]] ;;
    SLOT1_AUTODEPLOY) [[ "$v" =~ ^(true|false)$ ]] ;;
    SLOT1_GOOGLE_SITE_VERIFICATION | SLOT1_BING_SITE_VERIFICATION) [[ "$v" =~ ^[A-Za-z0-9_-]{1,120}$ ]] ;;
    SLOT1_CONTACT_EMAIL) [[ "$v" =~ ^[^[:space:][:cntrl:]@\"\'\`\$\\#]{1,64}@[^[:space:][:cntrl:]@\"\'\`\$\\#]{1,190}$ ]] ;;
    SLOT1_LEGAL_NAME | SLOT1_LEGAL_ADDRESS | SLOT1_GOVERNING_LAW) [[ "$v" =~ ^[^[:cntrl:]\"\'\`\$\\#]{1,200}$ ]] ;;
    SLOT1_ADMIN_PASSWORD_HASH) [[ "$v" =~ ^scrypt\$[A-Za-z0-9+/=.:_\$-]{20,400}$ ]] ;;
    *) return 1 ;;
  esac
}

# Settings that may be emptied from /admin (the Twitch app, AI provider, update switch and admin
# password can only be replaced).
setting_clearable() {
  case "$1" in
    SLOT1_OPERATOR_TWITCH_LOGINS | SLOT1_BOT_TWITCH_LOGIN | ANTHROPIC_API_KEY) return 0 ;;
    SLOT1_GOOGLE_SITE_VERIFICATION | SLOT1_BING_SITE_VERIFICATION | SLOT1_CONTACT_EMAIL) return 0 ;;
    SLOT1_LEGAL_NAME | SLOT1_LEGAL_ADDRESS | SLOT1_GOVERNING_LAW) return 0 ;;
    *) return 1 ;;
  esac
}

# Keys the website alone reads: saving only these restarts just the website.
setting_web_only() {
  case "$1" in
    SLOT1_GOOGLE_SITE_VERIFICATION | SLOT1_BING_SITE_VERIFICATION | SLOT1_CONTACT_EMAIL | SLOT1_LEGAL_NAME | SLOT1_LEGAL_ADDRESS | SLOT1_GOVERNING_LAW) return 0 ;;
    *) return 1 ;;
  esac
}

settings_answer() {
  local id="$1" ok="$2" detail="$3" tmp
  tmp="$DIR/state/outbox/.settings-$id.json"
  printf '{"id":"%s","ok":%s,"detail":"%s","at":"%s"}\n' "$id" "$ok" "$detail" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$DIR/state/outbox/settings-$id.json"
}

cmd_apply_settings() {
  need_root
  need_env
  ensure_state_dir
  local f id line verb key b64 value restart=none n bad i
  local -a keys values
  for f in "$DIR"/state/inbox/*.settings; do
    [ -f "$f" ] || continue
    id="$(basename "$f" .settings)"
    if ! [[ "$id" =~ ^[a-z0-9]{8,40}$ ]] || [ "$(wc -c <"$f")" -gt 16384 ]; then
      rm -f "$f"
      continue
    fi
    keys=()
    values=()
    n=0
    bad=""
    while IFS= read -r line || [ -n "$line" ]; do
      n=$((n + 1))
      if [ "$n" -eq 1 ]; then
        [ "$line" = "slot1-settings v1" ] || bad="format"
        continue
      fi
      [ -n "$line" ] || continue
      read -r verb key b64 <<<"$line"
      case "$verb" in
        set) value="$(printf '%s' "$b64" | base64 -d 2>/dev/null)" || { bad="$key"; break; } ;;
        clear) value="" ;;
        *) bad="format"; break ;;
      esac
      if [ "$verb" = set ] && ! setting_ok "$key" "$value"; then bad="$key"; break; fi
      if [ "$verb" = clear ] && ! setting_clearable "$key"; then bad="$key"; break; fi
      keys+=("$key")
      values+=("$value")
    done <"$f"
    rm -f "$f"
    if [ -n "$bad" ] || [ "${#keys[@]}" -eq 0 ]; then
      settings_answer "$id" false "not accepted: ${bad:-empty}"
      continue
    fi
    for i in "${!keys[@]}"; do
      if [ "${keys[$i]}" = SLOT1_ADMIN_PASSWORD_HASH ] && [ -n "${values[$i]}" ]; then
        env_set "${keys[$i]}" "'${values[$i]}'"
      else
        env_set "${keys[$i]}" "${values[$i]}"
      fi
      if [ "${keys[$i]}" = SLOT1_AUTODEPLOY ]; then continue; fi
      if setting_web_only "${keys[$i]}"; then
        [ "$restart" = apps ] || restart=web
      else
        restart=apps
      fi
    done
    settings_answer "$id" true "restart: $restart"
  done
  case "$restart" in
    apps) restart_apps ;;
    web) restart_web ;;
  esac
}

cmd_legal() {
  need_root
  need_env
  printf 'Business details for the Privacy Policy, Terms and Contact pages.\n'
  printf 'Press Enter to keep the value in [brackets], or type - to clear it.\n\n'
  ask_keep SLOT1_LEGAL_NAME "Business or legal name"
  ask_keep SLOT1_LEGAL_ADDRESS "Registered address (one line)"
  ask_keep SLOT1_CONTACT_EMAIL "Public contact email"
  ask_keep SLOT1_GOVERNING_LAW "Country whose law governs the Terms (for example Norway)"
  restart_web
  note "Done. Check $(env_get SLOT1_PUBLIC_ORIGIN)/privacy and /terms"
}

cmd_seo() {
  need_root
  need_env
  local code key question
  printf 'Paste the verification code (the content="..." value; the whole meta tag also works).\n'
  printf 'Press Enter to keep the value in [brackets], or type - to clear it.\n\n'
  for key in SLOT1_GOOGLE_SITE_VERIFICATION SLOT1_BING_SITE_VERIFICATION; do
    case "$key" in
      SLOT1_GOOGLE_SITE_VERIFICATION) question="Google Search Console code" ;;
      *) question="Bing Webmaster Tools code" ;;
    esac
    read -r -p "$question [$(env_get "$key" | sed 's/^$/not set/')]: " code </dev/tty
    case "$code" in
      "") ;;
      -) env_set "$key" "" ;;
      *)
        code="$(printf '%s' "$code" | sed -n 's/.*content="\([^"]*\)".*/\1/p;t;p' | head -n 1)"
        env_set "$key" "$(clean_text "$code")"
        ;;
    esac
  done
  restart_web
  note "Now click Verify in Search Console / Bing, then submit $(env_get SLOT1_PUBLIC_ORIGIN)/sitemap.xml"
}

cmd_admins() {
  need_root
  need_env
  local names="${1:-}"
  if [ -z "$names" ]; then
    printf 'Current admins: %s\n' "$(env_get SLOT1_OPERATOR_TWITCH_LOGINS | sed 's/^$/none/')"
    read -r -p "Twitch usernames to make admins (comma-separated): " names </dev/tty
  fi
  names="$(printf '%s' "$names" | tr '[:upper:]' '[:lower:]' | tr -d ' @')"
  [ -n "$names" ] || die "no usernames given."
  env_set SLOT1_OPERATOR_TWITCH_LOGINS "$names"
  restart_apps
  note "Admins: $names. Sign out and in again on the site if /admin still says not found."
}

cmd_status() {
  need_env
  compose ps
  local domain
  domain="$(env_get SLOT1_DOMAIN)"
  printf '\nAPI:     '
  curl -fsS --max-time 5 http://127.0.0.1:4000/api/health 2>/dev/null || printf 'not answering'
  printf '\nWebsite: '
  curl -fsS -o /dev/null -w 'https://%{url.host} answered %{http_code}' --max-time 10 "https://$domain/" 2>/dev/null || printf 'https://%s not answering' "$domain"
  printf '\n'
}

usage() {
  # The comment block at the top of this file, without the leading "# ".
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed '$d' | sed 's/^# \{0,1\}//' || true
}

main() {
  # Don't hand the update lock (fd 9 of the slot1 command) to anything this script starts.
  exec 9>&-
  local cmd="${1:-install}"
  [ "$#" -gt 0 ] && shift
  case "$cmd" in
    install | update) cmd_install ;;
    twitch) cmd_twitch ;;
    ai) cmd_ai ;;
    domain) cmd_domain "$@" ;;
    admin-link) cmd_admin_link ;;
    admin-password) cmd_admin_password ;;
    admins) cmd_admins "$@" ;;
    demo) cmd_demo ;;
    autodeploy) cmd_autodeploy "$@" ;;
    apply-settings) cmd_apply_settings ;;
    legal) cmd_legal ;;
    seo) cmd_seo ;;
    status) cmd_status ;;
    logs) need_env && compose logs -f --tail 100 "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
