# Running SLOT1 on one Hetzner server

One Ubuntu server runs everything: the website, the API, the worker, the shared GTA-model service, Postgres, Redis, the ingest gateway (MediaMTX) and Caddy for HTTPS. `scripts/server-setup.sh` installs and updates it. The same steps work on any Ubuntu or Debian server with a public IPv4 address.

## The server

| Setting | Value |
|---|---|
| Type | Regular Performance. CPX32 (4 vCPU, 8 GB) to start; CPX42 for more streams. A 4 GB server works, and the script adds swap for the build. |
| Image | Ubuntu 24.04 or newer |
| Networking | Public IPv4 (needed) and IPv6 |
| SSH key | Paste the `.pub` file's single `ssh-ed25519 …` line. Never upload or paste the private key. |
| Firewall, inbound | TCP 22 (SSH), 80 and 443 (website and HTTPS certificate), 1935 (OBS over RTMP); UDP 8189 (live video to viewers) |

## Install

From your own computer, in a terminal:

```sh
ssh -t -i ~/.ssh/slot1_hetzner root@YOUR_SERVER_IP \
  'curl -fsSL https://raw.githubusercontent.com/sig128/slot1/main/scripts/server-setup.sh | bash'
```

The script:

1. Waits for the server's first-boot setup, then installs Docker, git and a swap file if they're missing.
2. Downloads the code into `/opt/slot1`.
3. Writes `/opt/slot1/.env` with new random secrets and these settings:
   - production mode
   - the server's address
   - MediaMTX as the ingest gateway
   - the shared inference service
4. Builds the images and starts everything. The first build takes about 5 to 15 minutes; later updates are faster.
5. Checks the API and the HTTPS site, then prints the site address and next steps.

If the SSH connection drops during the build, run the same command again. It's safe to repeat: it keeps `.env` and all data.

### The address

Without a domain, the site is at `https://<ip-with-dashes>.sslip.io`, for example `https://203-0-113-10.sslip.io`. [sslip.io](https://sslip.io) is a free DNS service that maps such names to the IP inside them. Caddy gets a Let's Encrypt certificate for that name automatically.

To use your own domain:

1. In your registrar's DNS settings, add an A record for `@` and one for `www`, both pointing at the server's IPv4 address. Remove any parking or redirect records the registrar added. `www` redirects to the bare domain.
2. On the server, run `slot1 domain slot1.example.com`.
3. Update the Redirect URL on your Twitch app to match the new domain.

You can also pass `SLOT1_DOMAIN=slot1.example.com` in front of `bash` on the first install.

## After the install

The `slot1` command is installed on the server:

| Command | What it does |
|---|---|
| `slot1 twitch` | Asks for the Twitch app's Client ID and Secret (the secret is hidden while you paste), restarts the apps, and turns on "Sign in with Twitch". It can also take your Twitch username (allowed to connect the chat bot) and the bot account's username. |
| `slot1 ai` | Asks for an Anthropic API key and turns on the AI that watches streams. Anthropic bills the usage. |
| `slot1 update` | Gets the latest code, rebuilds and restarts. Keeps `.env` and data. |
| `slot1 status` | Shows running containers and whether the API and the HTTPS site answer. |
| `slot1 logs api` | Follows a service's logs. Services: `api`, `worker`, `web`, `inference`, `mediamtx`, `caddy`, `postgres`, `redis`. |
| `slot1 domain NAME` | Moves to your own domain. |
| `slot1 admin-password` | Sets or changes the `/admin` password. It asks twice, hidden; the server stores only a scrypt hash, and changing it signs out every admin session. |
| `slot1 admins NAMES` | Sets which Twitch accounts are SLOT1 admins (comma-separated). They can open `/admin` when signed in with Twitch and link the chat bot. |
| `slot1 admin-link` | Prints a one-time link (valid 15 minutes, single use) that signs you in to the `/admin` dashboard. Works before Twitch is set up. |
| `slot1 demo on` / `slot1 demo off` | Starts or removes the live demo stream at `/demo`. It's a synthetic test video sent through the real pipeline. |
| `slot1 legal` | Sets the business name, address, contact email and governing law shown on the Privacy Policy, Terms and Contact pages. |
| `slot1 seo` | Sets the Google Search Console and Bing site-verification codes. Afterwards, submit `/sitemap.xml`. |

### Twitch app (needed to sign in)

1. Go to https://dev.twitch.tv/console/apps/create. Twitch requires two-factor authentication on the account first.
2. Fill in the form:
   - Name: any unique name
   - OAuth Redirect URLs: `https://<your address>/api/auth/twitch/callback`
   - Category: Website Integration
   - Client Type: Confidential
3. Click Create, then Manage. Copy the Client ID, click New Secret and copy the secret.
4. Run `slot1 twitch` on the server and paste them.

### Streaming

1. Sign in on the site and open Studio.
2. Stream setup can configure OBS in one click over OBS's WebSocket, or shows the server and key to enter by hand.
3. OBS sends to `rtmp://<your address>:1935/live`.
4. Viewers watch SLOT1's copy over WebRTC with sub-second delay. Forwarding to Twitch, YouTube or Kick is set up in the same panel (docs/RELAY.md).

## How it fits together

| Public address | Goes to |
|---|---|
| `https://<address>/` | Caddy → `web:3000`, the Next.js site |
| `https://<address>/api/*` | Caddy → `api:4000`. `/api/ingest/hooks/*` is refused from outside. |
| `https://<address>/live/*` | Caddy → `mediamtx:8889`: WHEP playback for viewers, WHIP publishing from OBS |
| `rtmp://<address>:1935/live` | MediaMTX: OBS publishes here. The API checks every publish and read through MediaMTX's HTTP auth hook. |
| UDP 8189 | MediaMTX WebRTC media, advertised at the server's IPv4 (`MEDIAMTX_PUBLIC_HOST`) |

Postgres (5432), Redis (6379), the API (4000), the web server (3000) and MediaMTX's HTTP port (8889) listen on the server's localhost only.

Data lives in Docker volumes:

| Volume | Holds |
|---|---|
| `postgres` | the database |
| `media` | recordings, clips, screenshots, models |
| `redis` | the queue |
| `caddy-data` | certificates |

Hetzner backups cover them. The secrets are in `/opt/slot1/.env` (mode 600). Keep a copy somewhere safe: without `SLOT1_TOKEN_ENCRYPTION_KEYS`, stored Twitch tokens and relay keys can't be decrypted.

To use nginx-rtmp instead of MediaMTX, run `SLOT1_GATEWAY=nginx-rtmp slot1 update`. Ingest and forwarding still work, but there's no WebRTC video on the site.

## What was and wasn't verified

**Verified where SLOT1 was built:**
- The Dockerfile's install, build and deploy steps, replayed natively in a clean copy of the tracked files:
  - frozen-lockfile install from manifests only
  - all four builds
  - `pnpm deploy --prod` for api, worker and inference
- Every package the bundles import resolves in the deployed folders.
- The production API, worker, inference service and standalone web server start with `NODE_ENV=production` against a fresh database. The API applied the migrations and `/api/health` answered.
- Pages, fonts and static files are served, and the CSP header is as expected.
- `docker compose config` passes for both gateway profiles.
- The script's `.env` writer, domain and gateway switching, and the `slot1` wrapper were exercised.
- `shellcheck` reports no issues.

**Not verified there** (no Docker daemon or Docker Hub access): building and running the actual images, the apt packages inside them, MediaMTX itself, Caddy's certificate issuance, and the real server. The first real run is on your server, so watch its output.
