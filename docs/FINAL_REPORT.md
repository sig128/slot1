# SLOT1: final report

Date: 2026-11-01. This report states what works, how each claim was checked, and what still needs real credentials, live input or a console. Nothing below is marked tested unless a test or a recorded manual run exercised it. Runs against fixtures or a mock are labeled as such.

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
