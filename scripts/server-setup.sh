#!/usr/bin/env bash
# SLOT1 on one Ubuntu server (written for Hetzner Cloud; any Ubuntu/Debian host with a public IPv4
# works). Run as root. See docs/DEPLOY_HETZNER.md.
#
# First install: downloads the code, writes .env with fresh random secrets, builds, starts:
#   curl -fsSL https://raw.githubusercontent.com/sig128/slot1/main/scripts/server-setup.sh | bash
#
# After that, the `slot1` command is available on the server:
#   slot1 update        get the latest code, rebuild and restart (keeps .env and all data)
#   slot1 twitch        enter your Twitch app's Client ID and Secret (turns on "Sign in with Twitch")
#   slot1 ai            enter an Anthropic API key (turns on the AI that watches streams)
#   slot1 domain NAME   move to your own domain (point its A record at this server first)
#   slot1 admin-link    print a one-time link that signs you in to the /admin dashboard
#   slot1 demo on|off   start or remove the live demo stream (synthetic test video) at /demo
#   slot1 legal         business name, address, contact email and governing law for the legal pages
#   slot1 seo           Google / Bing site-verification codes
#   slot1 status        what is running, and whether the site answers
#   slot1 logs [name]   follow the logs (api, worker, web, inference, mediamtx, caddy, demo, ...)
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

install_cli() {
  cat >/usr/local/bin/slot1 <<EOF
#!/usr/bin/env bash
# Runs SLOT1's server script from a copy, so "slot1 update" can replace the script safely.
set -e
DIR="$DIR"
if [ "\${1:-}" = update ]; then
  git -C "\$DIR" fetch --quiet --depth 1 origin "\$(git -C "\$DIR" rev-parse --abbrev-ref HEAD)"
  git -C "\$DIR" reset --quiet --hard FETCH_HEAD
fi
tmp="\$(mktemp)"
trap 'rm -f "\$tmp"' EXIT
cp "\$DIR/scripts/server-setup.sh" "\$tmp"
SLOT1_DIR="\$DIR" bash "\$tmp" "\$@"
EOF
  chmod 755 /usr/local/bin/slot1
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
  if [ -z "$(env_get SLOT1_DEMO_STREAM_KEY)" ]; then env_set SLOT1_DEMO_STREAM_KEY "$(rand_hex 24)"; fi
  if [ -z "$(env_get SLOT1_DEMO)" ]; then env_set SLOT1_DEMO false; fi
  # A full-featured vertical render can peak around 1.7 GB of memory: one at a time on one server.
  if [ -z "$(env_get WORKER_LIBRARY_CONCURRENCY)" ]; then env_set WORKER_LIBRARY_CONCURRENCY 1; fi
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
  if [ "$(env_get SLOT1_DEMO)" = "true" ]; then extra+=(--profile demo); fi
  docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" \
    --profile infra --profile app --profile edge "${extra[@]}" "$@"
}

start_stack() {
  # Only one ingest gateway can hold port 1935: remove the one that is not in use.
  case "$(env_get INGEST_GATEWAY)" in
    mediamtx) docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --profile ingest rm -sf ingest >/dev/null 2>&1 || true ;;
    nginx-rtmp) docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --profile mediamtx rm -sf mediamtx >/dev/null 2>&1 || true ;;
  esac
  # The demo stream only runs while the demo is on.
  if [ "$(env_get SLOT1_DEMO)" != "true" ]; then
    docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --profile demo rm -sf demo >/dev/null 2>&1 || true
  fi
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
  Admin dashboard: run  slot1 admin-link  and open the link (or sign in with the Twitch
  username you gave to slot1 twitch, then open $origin/admin).
  Live demo stream: slot1 demo on   (slot1 demo off removes it again)
  Business details on the legal pages: slot1 legal

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
  # Shown in /admin → System, so it's clear which version is running.
  env_set SLOT1_VERSION "$(git -C "$DIR" rev-parse --short HEAD)"
  install_cli
  start_stack
  wait_healthy
  print_summary
}

cmd_twitch() {
  need_root
  need_env
  local id secret me bot
  printf 'Twitch app (https://dev.twitch.tv/console/apps). Redirect URL to register:\n  %s/api/auth/twitch/callback\n\n' "$(env_get SLOT1_PUBLIC_ORIGIN)"
  read -r -p "Client ID: " id </dev/tty
  read -r -s -p "Client Secret (hidden while you paste): " secret </dev/tty
  printf '\n'
  read -r -p "Your Twitch username, allowed to connect the SLOT1 chat bot (Enter to skip): " me </dev/tty
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
  need_root
  need_env
  case "${1:-}" in
    on)
      ensure_env_defaults
      env_set SLOT1_DEMO true
      say "Preparing the demo stream"
      # Same image target as the worker, so this mostly comes from the build cache.
      compose build demo
      # The API creates the demo channel (and stores the key's hash) on startup: it goes first.
      restart_apps
      say "Starting the demo stream"
      compose up -d demo
      note "Demo is on: $(env_get SLOT1_PUBLIC_ORIGIN)/demo (give it about 30 seconds)"
      note "Remove it later with: slot1 demo off"
      ;;
    off)
      say "Stopping the demo stream"
      docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" --profile demo rm -sf demo >/dev/null 2>&1 || true
      env_set SLOT1_DEMO false
      restart_apps
      note "Demo is off and the demo channel is hidden. Turn it back on with: slot1 demo on"
      ;;
    *) die "usage: slot1 demo on   or   slot1 demo off" ;;
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

usage() { sed -n '2,20p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

main() {
  local cmd="${1:-install}"
  [ "$#" -gt 0 ] && shift
  case "$cmd" in
    install | update) cmd_install ;;
    twitch) cmd_twitch ;;
    ai) cmd_ai ;;
    domain) cmd_domain "$@" ;;
    admin-link) cmd_admin_link ;;
    demo) cmd_demo "$@" ;;
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
