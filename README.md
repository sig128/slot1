# SLOT1

SLOT1 is a broadcast companion for GTA streams on Twitch. Viewers watch through Twitch's official player beside a live log of what SLOT1 actually observed. Each entry carries its evidence: the frame it came from, the on-screen text it read, or the Twitch event that produced it. Creators get a Twitch chat bot, clips on request, saved moments, and a Studio that says exactly what is connected and what isn't.

SLOT1 does not:

- touch a PS5
- read pixels out of the Twitch player
- scrape playback tokens
- make up observations when it can't see the game

When a piece is missing, the interface names the missing piece instead of showing demo output.

> SLOT1 is independent and not affiliated with Rockstar Games, Take-Two, Sony or Twitch.

## Contents

- [How it works](#how-it-works)
- [Quick start (local, no Docker)](#quick-start-local-no-docker)
- [Quick start (Docker)](#quick-start-docker)
- [Run it on a server](#run-it-on-a-server)
- [Configuration](#configuration)
  - [Twitch app registration](#twitch-app-registration)
  - [EventSub webhooks and a public HTTPS address](#eventsub-webhooks-and-a-public-https-address)
  - [Embed parents](#embed-parents)
  - [The SLOT1 bot account](#the-slot1-bot-account)
  - [AI vision, answers and transcription](#ai-vision-answers-and-transcription)
  - [Continuous ingest (video source)](#continuous-ingest-video-source)
  - [Storage](#storage)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Security model](#security-model)
- [Known limits](#known-limits)
- [Further documents](#further-documents)

## How it works

Three things travel separately, and the UI never mixes them up:

| Path | What it is | What SLOT1 learns from it |
|---|---|---|
| **Watch** | Twitch's official player and chat embeds | Nothing. The player is Twitch's; SLOT1 can't read it. |
| **Twitch platform data** | OAuth, Helix and EventSub for channels whose creator connected | Live/offline, title, category, chat commands, clips. These are Twitch facts, never gameplay vision. |
| **Authorized video** | Uploaded recordings, the creator's own clips, or a creator-established ingest relay | Frames that are sampled and analyzed: OCR (local tesseract), measurements (scene cuts, black screens, silence), optionally an AI vision model and transcription. |

A stock PS5 broadcasts one stream, to Twitch. It has no setting to send a second copy anywhere else, so continuous analysis needs a separate relay that the creator sets up: a capture card with OBS, for example. Without one, SLOT1 runs in chat-and-clips mode and says so.

Two independent statuses are shown everywhere:

- **Broadcast**: Live on Twitch, Offline, Twitch unavailable or Status unknown. This comes from Twitch platform data only.
- **Analysis** covers the vision side only:
  - "Live vision" appears only while real frames are arriving and being analyzed; "Live frames, text only" when only OCR is configured.
  - "Delayed" and "Stale" are derived from the source's own cadence and measured delay.
  - "Replay" covers uploads; "Chat & clips only" means there is no video source.

### Architecture

```
browser ──► web (Next.js 16, :3000) ──/api/*──► api (Fastify 5, :4000) ──► Postgres
                    ▲ SSR via SLOT1_API_INTERNAL_URL            │  ▲          Redis (BullMQ, pub/sub, rate limits)
Twitch ── EventSub webhooks ──► /api/twitch/eventsub ───────────┘  │          storage (fs or S3)
OBS/capture ── RTMP ──► nginx-rtmp or MediaMTX ── hooks ──► /api/ingest/hooks/*
                                   ▲ authenticated read
worker (BullMQ jobs + live supervisor) ── ffmpeg, tesseract, AI providers, Helix
```

- **web**: `apps/web`. App Router, nonce-based CSP, official Twitch embeds only. Pages: On Air, Watch, Replay, Moments, Studio, Setup, and `/demo`, which is clearly labeled fixture data.
- **api**: `apps/api`. Handles sessions and CSRF, Twitch OAuth (state bound to the browser session), EventSub verification, uploads, signed media URLs, the SSE event stream with Last-Event-ID backfill, Studio, and gateway hooks.
- **worker**: `apps/worker`. Runs upload analysis, live ingest (one Redis lease per source), clips, chat commands, EventSub processing, token validation (hourly) and retention.
- **packages**:
  - `contracts`: zod schemas shared by every app.
  - `db`: SQL migrations and queries.
  - `platform`: configuration, crypto, storage, Redis and logging.
  - `twitch`: OAuth, Helix, EventSub and chat parsing.
  - `analysis`: ffmpeg, OCR, fusion, state derivation, and the AI provider adapters.
  - `bot`: command policy and replies.
  - `services`: logic shared by the API and the worker.

## Quick start (local, no Docker)

Requirements:

- Node 22.12+ and pnpm 10
- PostgreSQL 16 and Redis 7
- ffmpeg/ffprobe
- tesseract with English data, for OCR
- optionally nginx with the RTMP module, for continuous ingest

```bash
pnpm install
cp .env.example .env
# Fill SLOT1_SESSION_SECRET and SLOT1_TOKEN_ENCRYPTION_KEYS (commands are in .env.example).
bash scripts/local-services.sh start      # Postgres on 5433, Redis on 6380 (no Docker)
# then in .env:
#   DATABASE_URL=postgres://slot1:slot1@127.0.0.1:5433/slot1
#   REDIS_URL=redis://127.0.0.1:6380
pnpm db:migrate
bash scripts/dev-stack.sh start           # api :4000, worker, web :3000 (logs in .data/logs)
```

Open <http://localhost:3000>. Without Twitch credentials, Studio offers a local creator account (development only), so you can upload a recording and see the full replay pipeline. `bash scripts/make-sample-video.sh` generates a 38-second synthetic test recording. It contains color bars and typed text, not game footage.

`pnpm dev` runs the three processes in the foreground instead, with file watching.

## Quick start (Docker)

```bash
cp .env.example .env    # fill the secrets
docker compose --profile infra up -d                                   # Postgres + Redis only
docker compose --profile infra --profile app up -d --build             # + api, worker, web
docker compose --profile infra --profile app --profile ingest up -d    # + nginx-rtmp gateway
docker compose --profile infra --profile app --profile edge up -d      # + Caddy with HTTPS (set SLOT1_DOMAIN)
```

Other profiles:

- `s3` adds MinIO.
- `mediamtx` runs MediaMTX instead of nginx-rtmp.

The images are built from `infra/docker/app.Dockerfile`, with targets `api`, `worker`, `web`, `inference` and `inference-gpu`. The API and worker images include ffmpeg, tesseract and a caption font. The Dockerfile's install, build and deploy steps were replayed natively, and the resulting production builds were started; the images themselves were **not** built where SLOT1 was developed (no Docker daemon). See [docs/DEPLOY_HETZNER.md](docs/DEPLOY_HETZNER.md#what-was-and-wasnt-verified).

## Run it on a server

One Ubuntu server with a public IPv4 runs everything: the site, API, worker, inference, Postgres, Redis, MediaMTX and Caddy with automatic HTTPS. Run this as root on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/sig128/slot1/main/scripts/server-setup.sh | bash
```

It writes `.env` with fresh secrets, builds and starts the stack, and prints the address. Without a domain, the address is `https://<ip-with-dashes>.sslip.io`. Afterwards:

- `slot1 twitch` turns on sign-in.
- `slot1 ai` turns on the AI.
- `slot1 update` deploys the latest code.

Firewall ports and details are in [docs/DEPLOY_HETZNER.md](docs/DEPLOY_HETZNER.md).

## Configuration

Every variable is documented in [.env.example](.env.example). The API logs each missing requirement at start. `/api/capabilities` returns the same list, and Studio shows it to the creator.

### Twitch app registration

1. Create an application at <https://dev.twitch.tv/console/apps>, category "Website Integration".
2. Add an OAuth Redirect URL for every origin you use. It must **exactly** match `TWITCH_REDIRECT_URI`, for example `http://localhost:3000/api/auth/twitch/callback` for development and `https://slot1.example.com/api/auth/twitch/callback` for production.
3. Copy the Client ID into `TWITCH_CLIENT_ID`. Generate a secret for `TWITCH_CLIENT_SECRET`. Both stay server-side.
4. Creators connect from **Studio → Connect my Twitch**. SLOT1 uses the authorization-code flow. The `state` is single-use and bound to the browser session that started the flow, and tokens are stored encrypted (AES-256-GCM, key ring in `SLOT1_TOKEN_ENCRYPTION_KEYS`).
5. Tokens are validated at start and hourly, as Twitch requires. Invalid tokens are refreshed. If refreshing fails, the connection is marked revoked and the features that depend on it switch off visibly.

Scopes and endpoints are listed in [docs/TWITCH_SCOPES.md](docs/TWITCH_SCOPES.md).

### EventSub webhooks and a public HTTPS address

Live/offline, title changes and chat commands arrive as EventSub webhooks. Twitch only delivers to an **HTTPS URL on port 443**.

- Set `TWITCH_EVENTSUB_CALLBACK_URL=https://<your-host>/api/twitch/eventsub` and `TWITCH_EVENTSUB_SECRET` (10–100 ASCII characters).
- In development, use an HTTPS tunnel to port 3000 or 4000, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Then put the tunnel URL in the callback variable.
- Signatures are verified over message-id + timestamp + the untouched raw body in constant time. Messages older than 10 minutes are rejected and duplicate message ids are ignored.
- Without EventSub, live/offline state still refreshes by polling Helix every minute. Chat commands need EventSub.

### Embed parents

Twitch's player and chat embeds only render on hostnames listed in their `parent` parameter. Put every hostname that serves SLOT1 in `TWITCH_EMBED_PARENTS`, comma-separated, for example `localhost,slot1.example.com,preview.slot1.example.com`. If the page's hostname isn't listed, or the player area is smaller than Twitch's 400×300 minimum, SLOT1 shows a plain "Watch on Twitch" link instead of a broken player.

### The SLOT1 bot account

Chat replies come from one dedicated Twitch account, not from the creator's account.

1. Create a Twitch account for the bot and set `SLOT1_BOT_TWITCH_LOGIN` to its login.
2. Put your own Twitch login in `SLOT1_OPERATOR_TWITCH_LOGINS`.
3. Sign in to SLOT1 with that operator account. Use **Link bot account**, offered in the Bot ready step and under Studio → Advanced setup. Twitch shows its account chooser (`force_verify`). Sign in as the bot account; any other account is refused.
4. Each creator who connects grants `channel:bot`, which lets the bot join their chat. Chat is read with EventSub `channel.chat.message` and replies are sent with the app access token, as Twitch recommends for chat bots.
5. The bot is **off by default** per channel. Creators turn it on in Studio. Kill switches:
   - per channel: Studio → Stop bot now
   - global: `BOT_GLOBAL_KILL=true`

Commands: `!slot1 help | status | now | recap | find <thing> | ask <question> | clip`. The broadcaster and approved moderators can also use `pause | resume | mute | unmute`. The short aliases `!clip` and `!recap` are opt-in per channel.

### AI vision, answers and transcription

| Variable | Effect |
|---|---|
| `VISION_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` + `ANTHROPIC_VISION_MODEL` | Claude vision via the Messages API with a strict JSON schema |
| `VISION_PROVIDER=openai` + `OPENAI_API_KEY` + `OPENAI_VISION_MODEL` | OpenAI Responses API with a strict JSON schema |
| `ANTHROPIC_TEXT_MODEL` / `OPENAI_TEXT_MODEL` | Phrasing of evidence-grounded answers (Ask SLOT1, `!slot1 ask`) |
| `TRANSCRIPTION_PROVIDER=openai_compatible` + `TRANSCRIPTION_MODEL` | Speech → transcript observations (`/audio/transcriptions`, OpenAI or a local server with that API) |
| `OCR_ENABLED=auto` | Local tesseract OCR, no network |

No model name is invented. If a provider is selected without its model or key, Studio reports exactly which variable is missing.

Every model output goes through two checks:

1. It is validated against the schema.
2. Rule checks run on top. Every finding must cite real frames from the batch. Motion and collision claims need at least two frames and are labeled *inferred*. Text claims need the actual visible text.

Model confidence is shown as "model reports …", never as accuracy. Answers are retrieved from stored evidence first. When nothing matches, the answer is "I haven't observed that."

The GTA V profile (`game_profile=gta5`) defines screen regions for subtitles, mission titles and the money HUD. It is an **unvalidated draft**: it has not been tuned on real GTA footage.

### Continuous ingest (video source)

1. Pick a gateway:
   - `nginx-rtmp`: `infra/nginx-rtmp`; locally, `bash scripts/ingest-gateway.sh start`.
   - `mediamtx`: `infra/mediamtx/mediamtx.yml`.
2. Set `INGEST_GATEWAY`, `INGEST_PUBLIC_RTMP_URL`, `INGEST_READ_URL_TEMPLATE`, `INGEST_READ_PASSWORD` and `INGEST_HOOK_SECRET`.
3. In Studio → Video sources, create a source. Declare it **TEST** for a looped recording or **LIVE** for a real relay.
4. The stream key is shown once; only its SHA-256 hash is stored.
5. Publish from OBS: Server = the RTMP URL, Stream key = the key shown. To try it without OBS: `bash scripts/publish-test-stream.sh '<publish URL>'`.

The gateway asks SLOT1 before accepting any publisher (stream key) or reader (worker credential only). nginx-rtmp re-checks every 20 s, so revoking or rotating a key disconnects an active publisher. The edge proxy must keep `/api/ingest/hooks/*` private; the Caddyfile returns 404 for it.

Once frames arrive, **Agent enabled** becomes available. Sampling defaults to one frame every 5 s. A source that stops sending turns the session **Stale** within a threshold derived from its cadence. If the publisher returns within 30 minutes, the same session continues.

### Storage

- `STORAGE_DRIVER=fs` (default) keeps media under `STORAGE_FS_ROOT` and serves it through short-lived HMAC-signed URLs (`/api/media/f/<token>`, with Range support).
- `STORAGE_DRIVER=s3` uses any S3-compatible store with presigned URLs. Use MinIO with `--profile s3`.

Retention defaults to 30 days per channel. Creators can delete a session or all of their data in Studio.

## Tests

```bash
pnpm test                 # 71 unit tests, no services needed
pnpm test:integration     # 27 tests on real Postgres, Redis, ffmpeg, tesseract (and nginx-rtmp if installed)
pnpm test:e2e             # 6 browser journeys at 1440, 1280 and 390 px; screenshots in tests/e2e/screenshots/
pnpm typecheck && pnpm lint
```

Integration tests use the database `slot1_test` (wiped per run) and Redis database 1. Override them with `TEST_DATABASE_URL` and `TEST_REDIS_URL`. Twitch flows are tested against a local mock of Twitch's OAuth, Helix and EventSub endpoints. That proves SLOT1's side of each flow, not Twitch itself.

## Project layout

```
apps/api        Fastify API            apps/worker   jobs + live supervisor     apps/web   Next.js UI
packages/*      contracts, db (migrations/), platform, twitch, analysis, bot, services
infra/          docker/app.Dockerfile, nginx-rtmp/, mediamtx/, caddy/
scripts/        local-services.sh, dev-stack.sh, ingest-gateway.sh, publish-test-stream.sh, make-sample-video.sh
tests/          unit/, integration/, e2e/ (+ screenshots/)
docs/           capability matrix, asset manifest, console checklist, Twitch scopes, final report
```

## Security model

- **Sessions**: opaque random ids, stored only as SHA-256 hashes, HttpOnly SameSite=Lax cookies (Secure on HTTPS).
- **CSRF**: every cookie-authenticated mutation needs the per-session token in `x-slot1-csrf` and a matching `Origin`.
- **Tenancy**: every session, observation, moment, clip, media URL and event stream is authorized against its owner and visibility. A private session returns 404 to everyone else.
- **Tokens and keys**: OAuth tokens are encrypted at rest with key rotation. Stream keys are hashed. Chat command arguments are stored as hashes only, and ordinary chat is never stored.
- **Media**: uploads are validated with ffprobe (allow-listed containers, a forced demuxer, `-protocol_whitelist file`). ffmpeg runs with argument arrays and resource limits, never through a shell.
- **Browser**: a nonce-based Content-Security-Policy allows frames only from Twitch's player, clips and chat.
- **Abuse limits**: rate limits are kept in Redis. The bot has per-user, per-channel and global limits, duplicate suppression and kill switches.

## Known limits

- PS5: nothing is installed on the console. Whether bot replies appear in the PS5's own chat overlay is unverified ([docs/CONSOLE_TEST_CHECKLIST.md](docs/CONSOLE_TEST_CHECKLIST.md)).
- The Twitch player and SLOT1's analysis arrive over different paths and can be seconds apart. Times shown as estimates are estimates.
- A clip is analyzed only after Twitch has made it available, and only with the extra `channel:manage:clips` permission.
- Real Twitch, real AI providers, MediaMTX, MinIO and the Docker images were not exercised where SLOT1 was built. See the final report for exactly what was and wasn't verified.

## Further documents

- [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md): every capability, what it needs, and how it fails visibly
- [docs/TWITCH_SCOPES.md](docs/TWITCH_SCOPES.md): scopes, endpoints and EventSub subscriptions
- [docs/ASSET_MANIFEST.md](docs/ASSET_MANIFEST.md): fonts, artwork and test media, with licenses
- [docs/CONSOLE_TEST_CHECKLIST.md](docs/CONSOLE_TEST_CHECKLIST.md): what to verify on a real PS5
- [docs/DEPLOY_HETZNER.md](docs/DEPLOY_HETZNER.md): running SLOT1 on one server, the `slot1` command, and what the deploy path verified
- [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md): what was built, what was tested, and what is blocked
