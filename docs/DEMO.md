# Live demo and "What the AI sees"

The demo is a public channel, **SLOT1 Demo** (`/watch/slot1-demo`). It is fed by a test video that SLOT1 generates on its own server and runs through the same pipeline as a real creator's stream. It shows how broadcasting works and what the AI reads, without needing a streamer or OBS.

The demo is **off by default**. Every place it appears says what it is:
- The video carries a permanent "SLOT1 DEMO - SYNTHETIC TEST VIDEO, NOT GAMEPLAY" watermark.
- Its source is a TEST source.
- Its session is titled "Demo stream: synthetic test video, not gameplay".
- The `/demo` page explains it.

"What the AI sees" works for every live stream that sends video to SLOT1, not just the demo.

## Turning it on and off

On the server:

| Command | What it does |
|---|---|
| `slot1 demo on` | Sets `SLOT1_DEMO=true` and generates `SLOT1_DEMO_STREAM_KEY` if missing. Adds the compose profile `demo`, recreates the API and worker, and starts the `demo` container. |
| `slot1 demo off` | Sets `SLOT1_DEMO=false`, removes the `demo` container, and recreates the API and worker. |

When the API starts with the demo off:
- the demo channel is hidden
- its key is revoked, so the generator would be refused
- its sessions are queued for deletion and its clips removed

While the demo is off:
- `/watch/slot1-demo` and `/c/slot1-demo` return 404
- Los Santos right now leaves it out
- `/demo` says the demo is off

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SLOT1_DEMO` | `false` | Demo on or off |
| `SLOT1_DEMO_STREAM_KEY` | — | The generator's publishing key. 16+ characters from `A–Z a–z 0–9 - _`. The API stores only its hash. |
| `SLOT1_DEMO_VISION` | `false` | Also send demo frames to the paid AI vision provider, capped at 12 calls per hour. This also turns on Ask SLOT1 for the demo. |
| `SLOT1_DEMO_SAMPLE_MS` | `3000` | How often the worker analyzes a demo frame |
| `SLOT1_DEMO_VIDEO_SIZE` | `1280x720` | Generator output size |
| `SLOT1_DEMO_FPS` | `30` | Generator frame rate |
| `SLOT1_DEMO_BITRATE_KBPS` | `2500` | Generator bitrate |
| `SLOT1_DEMO_PRESET` | `veryfast` | x264 preset |
| `SLOT1_DEMO_RTMP_URL` | per gateway | Where the generator publishes. Defaults to `rtmp://mediamtx:1935/live` or `rtmp://ingest:1935/live`. |

## How it works

1. **The generator** (`apps/worker/src/demo/broadcast.ts`, built as `dist/demo-broadcast.js` in the worker image) draws a scene with ffmpeg in real time:
   - a "Vice City after dark" backdrop and two cars, drawn as SVG
   - a synth music bed
   - HUD text: a mission title, subtitles, objectives, area names, a cash counter, and MISSION PASSED, WASTED and BUSTED screens
   - one 150-second cycle (`apps/worker/src/demo/scene.ts`) with invented names and places, and no game footage or game artwork

   Every HUD line sits inside the GTA V profile's OCR regions (`packages/analysis/src/profiles.ts`); `tests/unit/demo.test.ts` checks this. The text uses DejaVu Sans Bold, because tesseract reads heavy display faces unreliably.

   The video is encoded for low delay: H.264 with a keyframe every second and no B-frames, plus AAC audio. It publishes over RTMP to this server's gateway with the same key format Studio gives OBS, and reconnects with backoff if the connection drops.
2. **The gateway** (MediaMTX or nginx-rtmp) asks the API about the key, exactly as for any publisher.
3. **The worker** reads the stream like any other source:
   - samples a frame every `SLOT1_DEMO_SAMPLE_MS`
   - runs OCR (and the GTA model, if one is active)
   - writes observations, moments and banners
   - keeps a 90-second rolling buffer for instant replays
4. **Demo clips**: the demo never records the whole stream. About every ten minutes, a result screen is cut from the rolling buffer (6 s before, 4 s after). The clip is kept as a public library item on `/c/slot1-demo`.
5. **The `/demo` page** explains the path step by step, then embeds the live demo session with "What the AI sees" open.

## Bounds

The demo can run for weeks without growing:

| | |
|---|---|
| Paid AI | Never by default. Vision and Ask SLOT1 stay off unless `SLOT1_DEMO_VISION=true`; even then the cap is 12 vision calls per hour. |
| Training | Demo frames never enter the GTA training pool (`trainingConsent` stays off). |
| Recording | No full recording; only a 90-second rolling buffer. |
| Evidence frames | Expire after 2 hours. |
| Sessions | A new session starts every hour. Ended demo sessions are deleted 2 hours later. |
| Clips | At most one every 10 minutes; only the newest 20 are kept. |
| Chat | The bot, commentary and chat announcements are off. Test sources never post in chat. |

### Measured cost

Measured on the 2-vCPU machine where SLOT1 was built:

| | |
|---|---|
| Generator at 1280×720, 30 fps, `veryfast`, 2500 kbps | ≈ 0.38 CPU-seconds per second of video (≈ 40% of one core) |
| OCR, 4 regions per frame | 0.7–0.9 s CPU per analyzed frame (≈ 25–30% of a core at one frame every 3 s) |
| Disk, frames | Demo frames as the worker stores them (1280×720 JPEG) average about 62 KB: ≈ 70 MB per hour at one frame every 3 s. At most about 3 hours' worth are kept (≈ 210 MB). |
| Disk, rolling buffer | ≈ 30 MB |
| Disk, clips | 20 clips of about 10 s each |

On a 2-vCPU server, use `SLOT1_DEMO_VIDEO_SIZE=960x540` or `SLOT1_DEMO_FPS=24` to save CPU.

## "What the AI sees"

The watch page has a **What the AI sees** button under the timeline. On `/demo` it starts open. It shows the last frame SLOT1 analyzed in this live session:

- **The frame:** a 640 px copy of exactly that frame.
- **OCR:** the regions it read (blue outlines), each line it read (gold boxes), and the text with tesseract's confidence.
- **AI vision:** for that frame's batch, the scene summary and findings, or why vision didn't run (off, waiting for a batch, budget reached, error).
- **The GTA model:** the top classes, or that no trained model is active yet.
- **The log:** the entries the frame added or extended. Clicking one selects it in the log.
- **Timing:** the sampling interval and how long the frame took to analyze.

Where the data comes from:
- The worker builds the snapshot from what the pipeline did on that frame (`FrameInsight` in `packages/analysis/src/pipeline.ts`). Nothing is summarized or filled in.
- It is stored only in Redis, and only while someone has the panel or the frame player open: each poll keeps snapshots coming for 30 s. Unwatched streams cost nothing extra.
- The snapshot expires after 60 s and the image after 90 s. Neither ever goes to the database or object storage.
- `GET /api/sessions/:id/ai-view` and `…/ai-view/frame/:id` follow the same access rules as the session's live video: the creator always, everyone else only for public sessions with public analysis.
- The page polls every 2 s while the panel is open, and swaps the image only after the new one has loaded, so the boxes always match the frame.

Channels without Twitch (only the demo) fall back to this frame feed in the player when the server has no WebRTC gateway.

## What was verified

**`tests/integration/demo.test.ts`** (8 tests) runs the real generator publishing to a real nginx-rtmp gateway, with the real hooks, live supervisor and tesseract OCR. It covers:
- channel creation and idempotency
- the key never appearing in logs
- subtitles read
- the AI view for anonymous viewers, including the 640×360 frame
- private streams kept private
- MISSION PASSED read and a demo clip cut from the rolling buffer
- no paid AI usage
- the hourly session change
- housekeeping
- switching the demo off: hidden, key revoked, data queued for deletion

**`tests/unit/demo.test.ts`** covers:
- the HUD layout against the OCR regions
- the event timing
- the cash format
- the filter graph and encoder settings
- the publish URL formats
- the settings and the snapshot mapping

**`tests/e2e/demo.spec.ts`** covers the `/demo` page with the AI view at desktop and 390 px width, against a stack running the demo.

**Not verified:**
- MediaMTX and WebRTC playback of the demo (neither can run where SLOT1 was built)
- the Docker images themselves
- CPU and disk use on a real server
