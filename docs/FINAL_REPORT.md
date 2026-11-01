# SLOT1: final report

Date: 2026-11-01. This report states what works, how each claim was checked, and what still needs real credentials, live input or a console. Nothing below is marked tested unless a test or a recorded manual run exercised it. Runs against fixtures or a mock are labeled as such.

## Added after the first report

These features were built after the first version of this report. Each has its own document with the details and how it was checked; the test files are named below. None of them has run against real Twitch or a real AI provider.

- **Live video over WebRTC** ([LIVE_VIDEO.md](LIVE_VIDEO.md)): with MediaMTX as the gateway, the Watch page plays SLOT1's own copy of the stream beside the AI log, and viewers can switch to Twitch's player at any time. Creators publish over WHIP, SRT or RTMP, and SLOT1 checks every publisher and every viewer. The delay, roughly 0.3–0.7 s with WHIP, is an estimate, not a measurement. Tests: `tests/integration/live-video.test.ts`, and `tests/e2e/live-video.spec.ts` against a stand-in WHEP server, not MediaMTX.
- **GTA model: training engine and registry** ([GTA_MODEL.md](GTA_MODEL.md)): frames are kept only from creators who opt in (off by default). Creators label them in Studio; operators freeze session-split datasets, train with the scripts in `ml/` and register models, and a candidate replaces the active model only if it does at least as well on the same test split. The worker runs the active model with ONNX Runtime and publishes only predictions above its thresholds. The loop ran end to end on synthetic color-bar footage only (`tests/integration/training.test.ts`, whose training step needs PyTorch); that model knows nothing about GTA.
- **Shared inference service** ([SCALING.md](SCALING.md)): `apps/inference` runs the GTA model for many streams at once. It batches frames across streams, keeps them fair, refuses at once any work it couldn't finish within half the caller's deadline, and swaps models without dropping requests; a live frame that is refused or late gets no GTA prediction and is counted as dropped. In a 2-vCPU sandbox with no GPU and an untrained benchmark model, it saturated at about 200 frames/s. Tests: `tests/integration/inference.test.ts` (needs PyTorch) and `tests/unit/inference.test.ts`; nothing ran on a GPU.
- **Clipper** ([CLIPPER.md](CLIPPER.md)): copy-only recording (opt-in, with recording consent), frame-accurate screenshots, automatic vertical clips around MISSION PASSED, MISSION FAILED, WASTED and BUSTED, a browser editor with server renders, a library with private, unlisted and public items, public profiles at `/c/<login>`, and sharing through the device's share sheet. Tests: `tests/unit/clipper.test.ts`, `tests/integration/clipper.test.ts` (including a real nginx-rtmp publish) and `tests/e2e/clipper.spec.ts`; for sharing, `tests/unit/share.test.ts`, `tests/unit/csp.test.ts` and `tests/e2e/share.spec.ts`, which mocks `navigator.share`.
- **Forwarding, one-click OBS setup and chat controls** ([RELAY.md](RELAY.md)): the creator streams once to SLOT1, which passes the same audio and video on, without re-encoding, to Twitch, YouTube, Kick or a custom RTMP(S) server. Studio can configure OBS over obs-websocket 5, and the broadcaster and approved moderators get `!slot1 relay`, `!slot1 record on|off` and `!slot1 autoclip on|off`. The trade-off: while a creator forwards through SLOT1, a problem in SLOT1 stops their stream on every platform. Tests: `tests/unit/relay.test.ts`, `tests/unit/bot.test.ts`, `tests/integration/relay.test.ts` (a real relay between nginx-rtmp apps over RTMP and RTMPS) and `tests/e2e/relay.spec.ts` (against a stand-in obs-websocket server, not OBS).
- **Instant replay and clickable timestamps** ([INSTANT_REPLAY.md](INSTANT_REPLAY.md)): while a stream is live, any moment in the log can be replayed in a small player within a second or two, cut from the recording or the rolling buffer; when neither is on, the page says why. Every timestamp SLOT1 shows (the log, Ask SLOT1 citations, Moments search, short `/m/<id>` links in chat replies) jumps to its moment. The integration test showed that sampled frames were labeled half a sampling interval early; both samplers were fixed. Tests: `tests/unit/moments.test.ts`, `tests/integration/instant-replay.test.ts`, `tests/e2e/instant-replay.spec.ts`.
- **Los Santos right now** ([LOS_SANTOS_NOW.md](LOS_SANTOS_NOW.md)): `/los-santos` shows every public stream SLOT1 is watching and what SLOT1 saw on each in the last minute, with a game-radio-style wheel to switch between them (a bottom strip on phones). Private channels, analysis and sessions never appear, not even to their owners, and Twitch-only channels are labeled "Not analyzed by SLOT1". Tests: `tests/unit/now.test.ts`, `tests/integration/now.test.ts`, `tests/e2e/los-santos.spec.ts`.
- **One-server deploy and the `slot1` command** ([DEPLOY_HETZNER.md](DEPLOY_HETZNER.md)): `scripts/server-setup.sh` installs Docker, writes `.env` with fresh secrets, builds and starts the whole stack behind Caddy, and installs the `slot1` command (Twitch and AI keys, updates, status, logs, domain, admin link, demo, legal and SEO settings). On 1 November 2026 the Docker images were built and run for the first time on a Hetzner Cloud server (Ubuntu) with scripts/server-setup.sh. The site answered over HTTPS through Caddy, `/api/health` reported database and Redis ok, and `/api/capabilities` reported ingest (MediaMTX), live video and relay available. Twitch, AI vision and transcription were not configured yet, so those were not exercised there. That run used the version from before the admin, demo, legal and SEO work.
- **Legal pages and SEO** ([LEGAL_AND_SEO.md](LEGAL_AND_SEO.md)): `/privacy` and `/terms` were written from what the code does, read the operator's details from the server's environment, and name only the AI services that are switched on; they are plain-language drafts, not lawyer-reviewed. Metadata, `robots.txt`, `sitemap.xml`, share images and JSON-LD cover only what an anonymous visitor may already open. Tests: `tests/unit/seo.test.ts`, `tests/integration/seo.test.ts`, `tests/e2e/legal-seo.spec.ts`.
- **Admin dashboard, visitor statistics and contact form** ([ADMIN.md](ADMIN.md)): `/admin` shows visitors, live streams, platform and AI usage, contact messages and system health, all counted from the database, Redis or the running services. Anyone who isn't an operator or an admin-link holder gets a normal 404. Visitor counting sets no cookie, skips Do Not Track, Global Privacy Control and bots, and never stores an IP address or User-Agent. Tests: `tests/integration/admin.test.ts`, `tests/e2e/admin.spec.ts`.
- **Live demo and "What the AI sees"** ([DEMO.md](DEMO.md)): an optional public demo channel, off by default, runs a watermarked synthetic test video through the real pipeline; it replaces the `/demo` fixture page listed under What was built. "What the AI sees" shows, for any live stream sent to SLOT1, the last analyzed frame with its OCR boxes, the AI vision result, the GTA model's top classes and the log entries it produced. Tests: `tests/integration/demo.test.ts`, `tests/unit/demo.test.ts`, `tests/e2e/demo.spec.ts`.
- **Fonts** ([ASSET_MANIFEST.md](ASSET_MANIFEST.md)): Passion One (SIL Open Font License 1.1) sets poster titles and moment banners. A TTF copy in `packages/analysis/fonts/`, made by `scripts/build-render-fonts.py`, is used for text burned into clips, and WOFF copies of Passion One and Barlow Condensed draw the share images. Pricedown is not shipped: its free license excludes embedding in websites.
- **Twitch scopes** ([TWITCH_SCOPES.md](TWITCH_SCOPES.md)): forwarding to Twitch adds the optional `channel:read:stream_key` scope (Get Stream Key), requested only when the creator chooses "Let SLOT1 forward to Twitch". Because Twitch replaces granted scopes at each authorization, every reconnect asks again for the optional scopes the creator already granted. This was checked against a mock of Get Stream Key in `tests/integration/relay.test.ts`, not against Twitch.

## Still not verified

Gathered from every document in this folder, including the tables further down. Each item links to where it is described.

**Outside services**

- **Real Twitch**: sign-in, EventSub delivery, Helix, the embeds playing, a real `!slot1 clip`, clip download and analysis, VOD clips, the bot and chat controls in a real chat, and Get Stream Key for forwarding. Every Twitch flow ran against a mock ([table below](#what-still-needs-credentials-live-input-or-hardware), [RELAY.md](RELAY.md#what-was-verified-in-this-build)).
- **Real AI providers**: AI vision, model-phrased answers and transcription. There were no API keys where SLOT1 was built, and the first server run didn't configure them ([table below](#what-still-needs-credentials-live-input-or-hardware)).
- **Real OBS**: one-click setup ran only against a stand-in obs-websocket server, and publishing from OBS over WHIP wasn't tried ([RELAY.md](RELAY.md#what-was-verified-in-this-build), [LIVE_VIDEO.md](LIVE_VIDEO.md#what-was-verified-in-this-build)).
- **Real ingest servers for forwarding**: Twitch's, YouTube's and Kick's. The relay test forwarded between local nginx-rtmp apps ([RELAY.md](RELAY.md#what-was-verified-in-this-build)).
- **S3/MinIO storage**, including fetching a shared clip from a bucket ([table below](#what-still-needs-credentials-live-input-or-hardware), [CLIPPER.md](CLIPPER.md#sharing)).
- **Search engines and social networks**: real crawling and indexing, rich-result eligibility in Google's tools, and share cards on each network ([LEGAL_AND_SEO.md](LEGAL_AND_SEO.md#what-was-verified)).

**Video and network**

- **MediaMTX and WebRTC end to end**: MediaMTX couldn't be downloaded where SLOT1 was built, so recording, instant replay, forwarding, the demo and the load test's ingest run all used nginx-rtmp, and the player was tested against a stand-in WHEP server. On the first server run, `/api/capabilities` reported MediaMTX ingest and live video available, but no stream through them is recorded ([LIVE_VIDEO.md](LIVE_VIDEO.md#what-was-verified-in-this-build), [SCALING.md](SCALING.md#not-verified-here), [DEMO.md](DEMO.md#what-was-verified)).
- **TURN traversal and real-world latency**: the live-video delay figures are estimates, and the delay forwarding adds hasn't been measured ([LIVE_VIDEO.md](LIVE_VIDEO.md#latency), [RELAY.md](RELAY.md#reliability-trade-off)).
- **The instant-replay corner player over SLOT1's own live video**: the e2e test covers the replay docked beside Twitch's player ([INSTANT_REPLAY.md](INSTANT_REPLAY.md#tests)).

**Hardware and scale**

- **Anything on a GPU**: training, the CUDA and TensorRT providers, the `inference-gpu` image, NVENC renders, and hardware decoding with `cuda`, `vaapi` or `videotoolbox` (for decoding, only the ffmpeg arguments and the no-device failure were checked) ([SCALING.md](SCALING.md#not-verified-here), [CLIPPER.md](CLIPPER.md#the-editor)).
- **Scale**: the inference load test ran on a 2-vCPU sandbox with an untrained model, "about 1,000 streams" is arithmetic rather than a measurement, and several inference replicas behind a load balancer weren't tried ([SCALING.md](SCALING.md#measured-in-this-sandbox-cpu-only)). Real traffic volumes for visitor statistics ([ADMIN.md](ADMIN.md#verified-and-not)) and the demo's CPU and disk use on a real server ([DEMO.md](DEMO.md#what-was-verified)) weren't measured either.
- **PS5 chat overlay and chat-to-speech** ([CONSOLE_TEST_CHECKLIST.md](CONSOLE_TEST_CHECKLIST.md)).

**Browsers**

- **Browsers other than Chromium**: every e2e test ran in Chromium. The documents single out Firefox and Safari for OBS setup ([RELAY.md](RELAY.md#what-was-verified-in-this-build)) and other browsers' handling of `sendBeacon` ([ADMIN.md](ADMIN.md#verified-and-not)).
- **Chrome's Local Network Access prompt** during one-click OBS setup ([RELAY.md](RELAY.md#what-was-verified-in-this-build)).
- **A device's real share sheet**: the e2e test mocks `navigator.share` ([CLIPPER.md](CLIPPER.md#sharing)).

**On a server**

- **The current version**: the first server run used the version from before the admin dashboard, demo, legal pages and SEO, so no server run of those is recorded. Twitch, AI vision and transcription weren't configured there ([above](#added-after-the-first-report)).

**Models and data**

- **A GTA model trained on real gameplay**: the training loop ran only on synthetic color-bar footage, and that model knows nothing about GTA ([GTA_MODEL.md](GTA_MODEL.md#realistic-expectations)). The inference benchmark model is untrained on purpose and says nothing about accuracy ([SCALING.md](SCALING.md#not-verified-here)).
- **The GTA V screen profile on real footage**: its regions are still an unvalidated draft. The demo draws its HUD text inside them, but that video is synthetic too ([CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md), [DEMO.md](DEMO.md#how-it-works)).

**Legal**

- **A lawyer's review of the Privacy Policy and Terms**: they are plain-language drafts. A reviewer should confirm the consumer-law wording, the liability cap, whether an EU/UK representative is needed, and the GPU provider for training once there is one ([LEGAL_AND_SEO.md](LEGAL_AND_SEO.md#privacy-policy-and-terms-of-service)).
- **Rockstar Games / Take-Two's current terms** for training on gameplay footage or using a trained model commercially ([GTA_MODEL.md](GTA_MODEL.md#rights)).
- **The platforms' own simulcast rules**: the rules quoted for Twitch, YouTube and Kick come from third-party summaries ([LIVE_VIDEO.md](LIVE_VIDEO.md#sending-to-twitch-at-the-same-time), [RELAY.md](RELAY.md#platform-simulcast-rules-check-before-going-live-everywhere)).

**Implemented, but not run end to end**

- Automatic commentary posting ([table below](#what-still-needs-credentials-live-input-or-hardware)).
- Owned clip exports from the rolling buffer ([CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)).
- The hourly retention sweep for analysis data (`retention_days`). Its newer clean-ups are tested: recordings in `tests/integration/clipper.test.ts`, instant replays in `tests/integration/instant-replay.test.ts`, page views and contact messages in `tests/integration/admin.test.ts`.
- Chat announcements ("SLOT1 is watching", "Auto-clip ready"), which aren't in RELAY.md's test list ([RELAY.md](RELAY.md#setup-flow-creator)).

## What was built

A working product, not a mock:

- **Monorepo**: pnpm workspace with Node 22 and TypeScript.
  - Apps: `apps/web` (Next.js 16), `apps/api` (Fastify 5), `apps/worker` (BullMQ jobs and the live supervisor).
  - Shared packages: `contracts`, `db`, `platform`, `twitch`, `analysis`, `bot`, `services`.
- **Data model**: SQL migrations (`packages/db/migrations`) with 24 tables.
  - Users and sessions, OAuth state, encrypted grants, connections, channel settings.
  - Stream sessions, media sources, evidence assets, source health.
  - Observations, transcripts, corrections, moments, clip jobs.
  - Bot audit, EventSub deliveries and subscriptions, the session event log, job runs, usage, and errors.
  - Database CHECK constraints enforce the honesty rules:
    - Twitch facts carry no model confidence.
    - Gameplay observations need evidence.
    - A replay can't be labeled live.
    - A ready clip needs a link or a file.
- **Pages**:
  - On Air.
  - Watch: 70/30 player and rail with Live log / Ask SLOT1 / Session tabs; "follow the moment" evidence panel; Return to live; theater mode; Twitch chat.
  - Replay, Moments.
  - Studio: the readiness sequence Twitch connected → Bot ready → Clip permissions ready → Video source ready → Agent enabled; video sources; bot and chat; privacy and data; jobs and usage; advanced setup.
  - Setup/Help, and a `/demo` labeled as fixtures.
- **Twitch**:
  - Authorization-code OAuth with session-bound single-use state; tokens encrypted at rest with key rotation.
  - Hourly validation, refresh, revocation on disconnect.
  - Helix (users, streams, channels, clips, clips/downloads, videos/clips, chat/messages, EventSub subscriptions).
  - EventSub webhooks with raw-body HMAC verification, replay window, dedupe and reconcile.
  - Official player, clip and chat embeds with parent hosts and a minimum-size fallback.
- **Bot**:
  - Commands `!slot1 help|status|now|recap|find|ask|clip`, plus `pause|resume|mute|unmute` for the broadcaster and approved moderators.
  - Opt-in `!clip`/`!recap` aliases; per-user, per-channel and global limits; duplicate suppression; per-channel and global kill switches.
  - Audit with hashed arguments only.
  - Commentary is off by default and only allowed during live vision.
- **Media pipeline**: one observation pipeline for replays, clips and live ingest.
  - ffprobe validation and a playback rendition.
  - Interval and scene-change frames at real presentation timestamps.
  - Local OCR (tesseract, region crops, confidence filters), black-screen and silence detection, coverage and gaps.
  - Fusion across frames; highlight suggestions labeled inferred.
  - Optional AI vision (Anthropic Messages API / OpenAI Responses API) with strict JSON schema and rule checks.
  - Optional transcription (OpenAI-compatible).
- **Live ingest**:
  - nginx-rtmp or MediaMTX gateway; every publish and read authorized by SLOT1; hashed stream keys.
  - One worker per source via a Redis lease.
  - Cadence-derived Delayed/Stale states; dropped frames disclosed as gaps; optional rolling buffer with recording consent.
- **Live updates**: SSE with event ids, Last-Event-ID backfill from Postgres, a Redis fan-out, and a polling fallback.
- **Creator tools**:
  - Moments with full-text search.
  - Owned clip exports: landscape and vertical with captions.
  - Corrections with an audit trail.
  - Visibility and directory opt-in, retention, delete-a-session and delete-all.
- **Operations**: `docker-compose.yml` (profiles: infra, s3, ingest, mediamtx, app, edge), `infra/docker/app.Dockerfile`, nginx-rtmp image, MediaMTX config, Caddyfile, and scripts for local services, the dev stack, the ingest gateway, a test publisher and the sample video.

## Verification run in this build

These are the runs for the first version of this report. For the features added since and their test files, see [Added after the first report](#added-after-the-first-report); for what is still open, see [Still not verified](#still-not-verified).

| Check | Result |
|---|---|
| `pnpm typecheck` (10 workspace projects + tests) | Pass |
| `pnpm lint` (root) and `eslint .` in `apps/web` (Next rules, React hooks rules) | Pass, 0 errors |
| `pnpm build`: API and worker bundles (tsup), Next.js production build (standalone output) | Pass |
| Built bundles booted with `node dist/main.js` against the local database | API healthy; worker started |
| `pnpm test`: 71 unit tests | Pass |
| `pnpm test:integration`: 27 tests on real Postgres 16, Redis, ffmpeg, tesseract, nginx-rtmp | Pass |
| `pnpm test:e2e`: 6 journeys × 3 sizes (1440×900, 1280×800, 390×844) in Chromium, no console errors, no horizontal overflow | 18/18 pass |
| Screenshots | `tests/e2e/screenshots/{desktop,laptop,narrow}/`. Reviewed; overflow, hierarchy and layout issues fixed (see below). |

### Acceptance checks

| Check | Status | Evidence |
|---|---|---|
| A real uploaded sample creates evidence assets and schema-valid results **when AI credentials are present** | **Partly blocked**: no AI keys here | The upload creates real frame assets, OCR and measurement observations, all schema-valid (integration + E2E). The AI path's schema and rule enforcement is unit-tested with crafted model outputs; no live model call was made. |
| Without AI credentials, the missing provider is reported clearly | Tested | Session reason: "AI vision is not configured, so only on-screen text and measurements were analyzed"; Studio and capabilities name the missing variable |
| No video input → no gameplay observations | Tested | Upload before analysis has zero observations. A live Twitch session without a video source has only Twitch facts. `!slot1 now` says vision isn't connected. |
| A replay stays labeled replay | Tested | Session label, source label and evidence `sessionLabel` are `replay`; UI chip "REPLAY" |
| Live source loss → stale, and automatic commentary stops | Tested | Ingest test: disconnect → "Stale". Commentary requires live vision (unit). |
| Channels can't read each other's private events, media, clips, credentials | Tested | 404 on session, observations, events, ask, clips, corrections, PATCH/DELETE; moments search empty; another Studio doesn't list it. Media needs a signed URL; a tampered URL gets 403. Tokens are never returned by any API and are stored encrypted. |
| OAuth state mismatch rejected | Tested (mock Twitch) | State from another browser, forged state and reused state → 400; no token request made |
| Expired/revoked grants recover or disconnect safely | Tested (mock Twitch) | Invalid access token refreshed; revoked refresh token → grant revoked, readiness drops; disconnect revokes at Twitch |
| Forged/stale webhook signatures fail | Tested | Unit + integration: wrong secret, modified body, re-serialized JSON, >10 min old, future timestamp → rejected |
| Repeated deliveries don't duplicate events | Tested | Same EventSub message id twice → one job. Same chat message redelivered → one reply. |
| Clip jobs: ready, failed, disabled, missing scope, no fake links | Tested (mock Twitch) | Ready only after Get Clips confirms; Twitch 403 → failed `clips_disabled`, no URL; missing `channel:manage:clips` → "Analysis needs extra permission" |
| A permitted `!slot1 clip` produces a real Twitch clip in a credentialed live test | **Blocked** | No Twitch credentials or live broadcast available here |
| SSE reconnect/backfill doesn't duplicate or cross channels | Tested | Last-Event-ID backfill returns exactly the later events of that session, in order |
| Bot permissions, cooldowns, kill switch | Tested | Unit: broadcaster/approved-moderator gates, clip permission levels, user/channel cooldowns, global limit, duplicate suppression, channel and global kill |
| Twitch embeds on configured domains, respecting dimensions | Tested (layout); playback blocked | Desktop/laptop render `player.twitch.tv` with `parent=localhost`; at 390 px the player falls back to "Watch on Twitch". Twitch itself isn't reachable from here. |
| Keyboard navigation, reduced motion, contrast, small screens | Tested | Skip link and nav reachable by Tab with a visible focus ring (E2E). The ident doesn't animate under reduced motion. Text contrast 4.91–16.32:1 for all token pairs (unit). No horizontal overflow at 390 px. |
| PS5 chat visibility, speech and delay | **Unverified until a physical console test** | Shown as "Needs console verification"; see [CONSOLE_TEST_CHECKLIST.md](CONSOLE_TEST_CHECKLIST.md) |

### Recorded manual run: live ingest

The local nginx-rtmp gateway ran with the dev stack, and a looping TEST stream was published with `scripts/publish-test-stream.sh`:

- A publisher with the wrong key was refused.
- Frames arrived within about 10 s, and Studio marked "Video source ready".
- After the agent was enabled, OCR observations followed from the live frames: "$12,450", "Vespucci Beach", "MISSION PASSED", "Go to the docks", "TEST RECORDING".
- Stopping the publisher turned the session **Stale** with the reason "Video source disconnected".
- In a second run, anonymous readers and readers with a wrong password were refused.
- Revoking the source disconnected the active publisher **13.8 s** later (the `on_update` check). Republishing with the revoked key failed.

The automated integration test repeats this flow.

## Bugs found by testing and fixed

- **SSE backfill order.** The backfill query sorted by the text-cast id (`1, 10, 11 … 2`). On reconnect, any session with 10 or more events would have **silently dropped** events, because the stream skips ids at or below the last one sent. Fixed by qualifying the sort column; covered by an integration test.
- **Studio "Last received frame"** showed frames from uploaded replays. It now shows only continuous sources.
- **Ingest reads without a password.** With nginx-rtmp and no `INGEST_READ_PASSWORD`, nobody (not even the worker) could read streams. The password is now required for both gateways, and the Studio and capability reason says so.
- **Revocation and long gaps.** A revoked or rotated stream key used to keep an active nginx-rtmp publisher connected; `on_update` re-checks now cut it off. A publisher returning after a long gap used to extend a stale ingest session; after 30 minutes away it now starts a new one, and the hourly sweep closes abandoned ones.
- **Production bundles couldn't find SQL migrations.** Migrations now ship next to `dist/main.js`, or can be set with `SLOT1_MIGRATIONS_DIR`.
- **Studio had no way to link the bot account.** Operators now get "Link bot account" in the Bot ready step and in Advanced setup.
- **UI fixes from screenshot review:**
  - horizontal overflow on narrow Setup (the four-column table becomes stacked blocks)
  - session rows cramped on phones
  - the station ident briefly hiding the wordmark (now decided before first paint; never animated under reduced motion)
  - hydration-safe clock
  - remount-per-observation instead of effect-driven state resets
  - typographic apostrophes
  - the PS5 checklist wording, corrected against PlayStation's support article

## What still needs credentials, live input or hardware

| Item | Why it's not verified here | How to verify |
|---|---|---|
| Real Twitch: sign-in, EventSub delivery, Helix, embeds playing | No Twitch app credentials; no outbound access to Twitch | Register the app (README), set `TWITCH_*`, expose `/api/twitch/eventsub` over HTTPS, connect a channel, go live |
| `!slot1 clip` creating a real clip | Needs credentials and a live broadcast | Bot ready + live channel → `!slot1 clip` → link posted after Twitch confirms |
| Clip download and analysis; VOD clips | Needs `channel:manage:clips` on a real channel | Studio → Grant clip analysis permission, then request a clip |
| AI vision and model-phrased answers | No Anthropic/OpenAI keys | Set `VISION_PROVIDER` + key + model; upload the sample; findings must cite frames |
| Transcription | No provider configured | Set `TRANSCRIPTION_*`; upload a recording with speech |
| MediaMTX gateway | Binary/image not available here (hook logic is tested) | `docker compose --profile infra --profile app --profile mediamtx up` and publish from OBS |
| S3/MinIO storage | No MinIO here | `--profile s3`, `STORAGE_DRIVER=s3` |
| Docker images and compose stack | No Docker here; the same build steps ran natively | `docker compose --profile infra --profile app up --build` |
| Rolling-buffer clips from live ingest; automatic commentary posting; hourly retention sweep | Paths implemented; the end-to-end runs above didn't cover them | Enable recording consent + rolling buffer on an ingest source; set commentary to rare with the bot ready |
| GTA V screen profile | Only synthetic footage was available | Validate regions on owned GTA V recordings before relying on `gta5` |
| PS5 chat overlay and chat-to-speech | Needs a physical console | [CONSOLE_TEST_CHECKLIST.md](CONSOLE_TEST_CHECKLIST.md) |

## Notes for whoever runs it next

- Start with `bash scripts/local-services.sh start && bash scripts/dev-stack.sh start` (README → Quick start). Tests: `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`.
- Twitch flows are integration-tested against a mock of Twitch's endpoints (`tests/integration/harness.ts`). Keep those tests, but don't read them as proof that Twitch accepted anything.
- The earlier prototype (Next 15, Solana and PS5 installer stubs) conflicted with this spec. It was moved, untouched, to `_legacy-prototype/` and is excluded from git and lint.
