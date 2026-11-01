# Clipper: recording, screenshots, clips, editor, library and profiles

SLOT1 already sees the gameplay and knows when the big moments happen. The clipper turns that
into a creator tool. It records the stream and lets the creator take a screenshot of any frame,
cut clips by hand or let SLOT1 cut them around big moments, and edit them in the browser. Every
result can appear on the creator's public profile.

TikTok posting is out of scope. Creators download renders and post them wherever they like.

## What creators get

| Feature | Where | Notes |
| --- | --- | --- |
| Full-stream recording | Studio → Library → Recording | Opt-in. Needs recording consent. Copy-only (no re-encode). |
| Recording replay with the AI log | `/replay/<sessionId>` | Plays like an upload: timeline, AI markers, evidence, Ask SLOT1. |
| Screenshots | Replay page "Screenshot"; live page "Screenshot"; evidence panel "Save frame to library" | Replay/recording: full resolution at the playhead, frame-accurate. |
| Manual clips | Replay page "Edit clip" → `/studio/edit/<id>` | Starts a draft 8 s before and 6 s after the playhead. |
| Auto clips | Studio → Library → Auto clips | Opt-in. A vertical draft around MISSION PASSED, MISSION FAILED, WASTED and BUSTED. |
| Web editor | `/studio/edit/<id>` | Non-destructive edit decision list, browser preview, server render. |
| Library | Studio → Library | Recordings, clips (Twitch, rendered, auto), renders, screenshots. Filters, visibility, download, delete. |
| Public profile | `/c/<login>` | Live now, featured, clips, recordings, screenshots. Only public items. |
| Item page | `/v/<itemId>` | One shared item with link-preview meta tags. Unlisted items open here by direct link. |

## Recording

**Switching it on.** Recording requires the existing "I consent to SLOT1 recording my ingest
stream" setting (Privacy and data, or the Library tab). The API refuses `recordingEnabled: true`
without consent. Withdrawing consent switches recording off. Only video the creator sends to
their SLOT1 ingest URL can be recorded. A Twitch-only broadcast has no stream for SLOT1 to keep.

**How it works.**

1. The live reader's ffmpeg already samples frames for analysis. With recording on, the same
   ffmpeg process also writes copy-only MPEG-TS segments (6 s each) with a segment list. Both
   outputs share one input clock, so a frame's media time and the segment times line up.
2. Every completed segment is uploaded to storage (`b/<b>/s/<s>/recording/runs/<run>/…`) and
   recorded in `recordings.runs`. Any worker can therefore finalize the recording, not only the
   one that read the stream.
3. Each reader run has its own timeline. A run starts when the publisher connects, when
   analysis is switched on or off, or after a reconnect.
4. When the reader stops, a `finalize-recording` job concatenates every run's segments in
   wall-clock order (concat demuxer, `-c copy`, `+faststart`). It stores the MP4 and a poster,
   then creates a `media_sources` row of kind `recording` that plays exactly like an upload.
5. Finalization also moves what SLOT1 saw onto the file timeline. For a run starting at file
   offset `O` whose first segment starts at run time `F`, a run time `t` maps to `O + (t − F)`.
   This covers observation start/end times, evidence frame times and stored frame times; the
   run is chosen by wall clock. `rebased_until` makes this happen once per observation.
   Auto-clip drafts cut from a run's segments before finalization are moved onto the file the
   same way.
6. Segments are deleted once the session has ended and the file exists.

**Retention.** `recordingRetentionDays` (default 14, 1–365) is separate from the analysis
retention. When it passes, the retention sweep deletes the recording file, its poster and its
segments, and removes the recording from the library. The session, its AI log, and every clip,
render and screenshot made from the recording **stay**: those keep their own files outside the
session (see "Library").

**Storage usage** is shown in Studio → Library as bytes by category: recordings, clips and
screenshots, uploads, and analysis frames.

### Storage sizing

Recordings are copied, not re-encoded, so their size follows the creator's encoder bitrate. The
figures below are arithmetic, not measurements:

- 6 Mbps × 3,600 s = 21,600 Mb per hour = 2,700 MB, so **about 2.7 GB per hour** (decimal GB),
  plus audio. 160 kbps of AAC adds 160 kb × 3,600 = 72 MB per hour.
- One creator streaming 4 hours a day with 14-day retention: 2.7 GB × 4 × 14 ≈ 151 GB.
- 100 such creators: ≈ 15 TB of recordings at steady state, plus renders and screenshots, which
  are not expired automatically.

Rendered clips are re-encoded (libx264 CRF 20 at 1080×1920 or 1920×1080). Their size depends
on the content, not on a fixed bitrate.

## Screenshots

`POST /api/library/screenshots` takes one of three sources:

- `{ from: "media", sessionId, atMs }`: a replay or a finalized recording at the playhead. A
  worker job runs `ffmpeg -ss <t> -i <file> -frames:v 1` with no scaling. An input seek while
  decoding is frame-accurate and the frame keeps the source resolution. The integration test
  checks frame 525 of the sample, which lies between keyframes (a keyframe seek would return
  frame 480).
- `{ from: "live", sessionId }`: the latest frame received from the ingest source, copied
  immediately. It is the analysis-sized frame (longest edge `VISION_MAX_EDGE_PX`, default
  1280), not the full stream resolution. For full resolution, record and screenshot the
  recording.
- `{ from: "evidence", observationId, assetId? }`: any evidence frame SLOT1 stored.

Each screenshot becomes a library item (private by default) with a title and visibility.

## Clips

**Manual.** "Edit clip" on a replay or recording creates an edit project around the playhead
and opens the editor. In the source timeline, the AI's moments are markers: gold for big
results, apricot for text SLOT1 read, blue for other events. In and out points are set with the
handles, the I and O keys, or by typing a time.

**Auto clips** (opt-in, `autoClips`). When SLOT1 creates an observation whose on-screen text (or
a result screen) reads MISSION PASSED, MISSION FAILED, WASTED or BUSTED, it creates an `auto`
edit project. The draft is vertical 9:16, keeps the whole frame over a blurred backdrop, and
shows the moment's text in poster style for 3 s. It spans `autoClipPreRollMs` before and
`autoClipPostRollMs` after the moment (defaults 8 s and 6 s), and a render is queued.

- One clip per moment: the same text read on several frames, or by two engines, does not make
  duplicate clips (overlapping windows are matched).
- Replays render at once.
- Live sessions need Recording on. The render waits for the post-roll, is retried while the
  rest of the moment is still being recorded, and is cut from the run's uploaded segments. After
  finalization, the draft points into the recording file.

Twitch clips and the existing quick clip renders also appear in the library.

## The editor

`/studio/edit/<projectId>` is a multi-track editor over a **non-destructive edit decision list**
(EDL). The EDL is validated with zod (`Edl` in `packages/contracts/src/clipper.ts`) in the
browser, on save and again before rendering. Every field has a default, so edits saved by older
versions parse and render exactly as before (an edit that uses only the original fields gets the
original ffmpeg command). The schema carries `.describe()` text on every field, so its JSON
Schema explains itself to AI tools.

| Field | Meaning |
| --- | --- |
| `segments[]` | The main video track, 1–20 segments: `sessionId`, `inMs`/`outMs` (0.3 s–5 min), `speed` 0.25–4×, optional `rampTo` (speed ramp, rendered as 8 constant-speed steps), `reframe {x, y, zoom}` or keyframed `keys[]` (pan/zoom in source time), `volume`, and `transitionIn` (cut, crossfade, flash, dip, whip, glitch; 0.1–2 s overlap) |
| `aspect` | `9:16` (Vertical 1080×1920), `16:9` (Widescreen 1920×1080) or `1:1` (Square 1080×1080) |
| `layout` | `crop` (fill and reframe), `fit` (whole frame over a blurred backdrop) or `split` (facecam panel over gameplay, vertical only) |
| `split` | Facecam box in the source picture, the camera panel's share of the height (20–60 %), camera on top or bottom |
| `overlays[]` | Up to 4 overlay tracks (hide, lock), 40 items each: animated text (poster, banner, subtitle box, mission title, wasted red, lower third, title card; pop, slide, typewriter or fade), images (Studio library stickers/overlays/frames, or the creator's uploads) and picture-in-picture (another moment, or a crop of the picture such as the facecam). Position, scale, rotation and opacity can be keyframed on the output timeline |
| `audioTracks[]` | Up to 4 audio tracks (music, sound effects, voice; mute, solo, lock, volume) with clips that have offsets, fades, looping and a volume envelope. `duck` lowers a track while the source audio has voice-band sound (see the caveat below) |
| `sourceAudio` | The main track's audio: mute, solo, an FFT denoiser (`afftdn`), a voice boost (EQ and compression), a volume envelope |
| `effects[]` | WASTED (freeze, desaturate, darken, banner), MISSION PASSED (gold banner and flash), punch-in zoom, camera shake, flash, glitch. Original SLOT1 art in the GTA spirit: no Rockstar audio, artwork or fonts, no Pricedown |
| `grade` | Original grade presets (Vice City night, Los Santos golden hour, Noir, Neon, Bleach) plus brightness, contrast, saturation, vignette and grain |
| `captionTrack` | Caption cues with optional word timings: word highlight (karaoke), subtitle, or big words; top, middle or bottom |
| `texts[]`, `captions` | The older text overlays and transcript burn-in, kept so earlier edits render the same |
| `fadeInMs`, `fadeOutMs`, `volume`, `coverMs`, `normalize` | Fades, source volume (0–200 %), cover frame, loudness normalization to about −14 LUFS with a peak limiter |

The whole edit is capped at 10 minutes. Unknown fields are stripped, so nothing a client sends
reaches ffmpeg except validated numbers and text. Text goes through files (`drawtext textfile=`
for the older texts, ASS subtitle files for everything new), never through the filtergraph.
Library items are referenced by Studio library id and uploads by id; the API checks that uploads
and picture-in-picture sessions belong to the creator, and a render is refused up front when a
library id isn't installed on the server.

**Timeline.** Overlay tracks sit on top, then the video track, effects, captions, the game
audio (with its waveform) and the audio tracks (with theirs). Drag blocks to move them and their
edges to trim; trimming a segment ripples the rest of the edit, Alt (or the Roll toggle) rolls a
cut instead so the length stays put. Moves and trims snap to the playhead, the AI's moments and
every other edge (Shift or N turns snapping off). Shift-click selects several items. Split,
delete and ripple delete keep items on the footage they were placed over, because times are
carried through the source time they show. The ruler zooms (buttons, +/−/\, Ctrl+wheel).
Every change is one undo step (slider drags and typing merge), including AI proposals and
templates. Saving is automatic; the header says when there are unsaved changes.

**Inspector.** Tabs: Clip (the selection's properties, keyframes, transitions, speed and ramps,
"Follow the action", instant replay, segments list), Format (size, framing, facecam split,
fades, cover, templates), Look (grades and effects), Text (animated text, picture-in-picture),
Audio (game audio, tracks, ducking, loudness), Captions (styles, generation, manual editing),
Library (the Studio's sounds and elements plus the creator's uploads), AI (the AI clip tools)
and Export.

**Follow the action** measures where the picture moves (frame differences on a small grid,
skipping scene cuts and the facecam box) and places reframe keyframes over the movement. It
never invents motion: with no clear movement it changes nothing and says so. It needs the
browser to read the video's pixels; when the storage doesn't allow that, it says so.

**Templates** ("TikTok highlight", "Best-of reel", "Wasted moment") only use what exists: the
edit, the AI's moments and the creator's camera box. When the data a template needs is missing
(no big moments, no WASTED reading) the edit is left alone and the reason is shown.

**Facecam split.** When the creator has drawn boxes with "Hide your camera from the AI"
(Studio → Stream setup), the first box prefills the split's camera box.

**Preview.** A canvas compositor draws the edit in the browser: segments in order at their
speeds and ramps, framing and keyframes, overlays and their animations, captions, effects, fades
and the audio clips. "Source" plays the whole recording to pick points. The preview says when it
approximates the final render: colour grades, transitions, ducking and loudness are exact only
in the render.

**Keyboard** (press ? in the editor for the list). Space plays or pauses; J, K and L shuttle;
←/→ step one frame (Shift: one second); ↑/↓ jump between edit points; I and O set in and out
points (Source) or trim the segment under the playhead (Edit); S splits; Delete deletes and
Shift+Delete ripple deletes; Ctrl/⌘+Z undoes and Ctrl/⌘+Shift+Z or Ctrl+Y redoes. The editor
works at 390 px wide: the panels stack under the preview and the timeline scrolls sideways
inside its own box.

**Audio and ducking, honestly.** The game audio is one mixed stream. SLOT1 can't separate the
creator's voice from the game, so "Duck under speech" lowers music while the source has energy
in the voice band (a sidechain compressor keyed on 300–3400 Hz): loud game sound in that band
ducks the music too. The voice boost and denoiser act on the whole stream for the same reason.

**Uploads.** Music, voice-overs, logos and stickers (MP3, M4A, AAC, WAV, OGG, Opus, FLAC; PNG,
JPG, WebP, GIF) up to 50 MB of audio (20 minutes) or 10 MB per image. The creator confirms they
own the file or have the rights to use it; the confirmation time is stored. Files are checked with
ffprobe (local file protocol only), stay private and are deleted with "Delete everything".

**Captions.** "Generate captions" transcribes the edit's audio (mono 16 kHz) with the configured
transcription provider and offers the cues to apply. Without `TRANSCRIPTION_PROVIDER` and
`TRANSCRIPTION_MODEL` it says exactly that. Cues can always be typed and timed by hand.

**Render and export.** "Render" saves the current EDL, then queues a `render-project` job on
the `slot1-library` queue. Export renders the same edit for several platforms at once, one
library item each:

| Preset | Shape | Length limit SLOT1 checks |
| --- | --- | --- |
| As edited | the edit's own | 10 minutes (the edit's cap) |
| TikTok | 9:16 | 10 minutes |
| YouTube Shorts | 9:16 | 3 minutes |
| Instagram Reels | 9:16 | 3 minutes |
| X | the edit's own | 2 minutes 20 seconds |
| YouTube | 16:9 | none beyond the edit's cap |

These limits are the platforms' published ones as of 2025 and they change; check the platform
before relying on them. An export that a platform wouldn't take is refused with the reason.
Options: 1080p or 720p, 24/30/60 fps, quality high/standard/small (CRF 20/23/27 with a bitrate
cap per preset), animated GIF (up to 30 s, 15 fps, 480 px wide, no sound) and audio only (AAC).
A **thumbnail** is a 1280×720 PNG of one frame with big styled text, saved to the library;
"Save this frame" saves the source frame without overlays.

`buildEdlRender` (`packages/analysis/src/edl-render.ts`) is a pure, unit-tested function that
turns the EDL into one ffmpeg command:

- one input per segment with `-ss`/`-t` before `-i` (accurate seek), one per picture-in-picture,
  image, upload or library sound (looping inputs are bounded with `-t`);
- per segment: crop or keyframed crop (`scale` with `eval=frame` and a per-frame `crop`
  expression), fit over a blurred backdrop, or the facecam `vstack` with an ink-and-gold
  divider; `setpts`/`atempo` for speed, split/trim/concat steps for ramps;
- `concat` for cuts, `xfade`/`acrossfade` pairwise for transitions;
- grade (colour balance, eq, curves, vignette, noise), effects in their time windows (the WASTED
  freeze is a linear `loop`/`select`/`setpts` chain: a `split` into `freezeframes` stalls ffmpeg 6
  while other inputs are still being read), then the older `drawtext` texts;
- overlay tracks: images and picture-in-picture via `overlay` with per-frame position, `rotate`,
  alpha by `geq` for keyframed opacity; animated text, effect banners and captions as ASS
  subtitles in Passion One (`fontsdir`);
- audio: per-clip trims, fades, `adelay`, envelopes, `amix`, `sidechaincompress` for ducking,
  `afftdn`/EQ/compression for the source, `loudnorm` and `alimiter`;
- yuv420p, AAC 48 kHz, `+faststart`, a bitrate cap when the edit uses the new features;
- progress from `-progress pipe:1`, stored on the job run and shown in the editor and the library.

Limits: at most 4 renders in flight per creator for single renders and 8 for a batch export, 30
render and 20 export requests per hour. Rendering is refused up front with a clear message when
a segment's session or video, a picture-in-picture video, an upload or a library item is gone.

**Encoders.** `FFMPEG_ENCODER=libx264` (default, CPU, `-preset veryfast`) or `h264_nvenc`
(NVIDIA GPU, `-preset p4`). NVENC needs an NVIDIA GPU and driver in the worker container and an
ffmpeg built with NVENC. Check with `ffmpeg -hide_banner -encoders | grep nvenc`.
`WORKER_LIBRARY_CONCURRENCY` (default 2) sets how many renders, screenshots and finalizations one
worker runs at once.

**Render cost.** Measured on a shared 2-vCPU test machine (libx264 veryfast) while other jobs
were running: a 10.2 s vertical 1080×1920 edit with the facecam split, two transitions, a
WASTED freeze, an animated title, an uploaded image, captions, ducked music and loudness
normalization rendered in 14–17 s; the same kind of 6 s edit at 720p in 4–5 s per platform
version; an audio-only export in under half a second; a 6 s GIF in 13–23 s (palette generation
is the slow part). The heaviest filters are temporal grain and keyframed opacity (`geq`); grain
stays subtle and renders that use the new features get a bitrate cap.

**Fonts.** Burned-in text uses Passion One (SIL Open Font License 1.1), converted losslessly
from the web app's WOFF2 into TTF by `scripts/build-render-fonts.py` (fontTools) and stored with
its license in `packages/analysis/fonts/`. DejaVu Sans Bold is the fallback and the caption face.
The worker bundle copies the fonts to `dist/fonts`. Pricedown is never used for rendering and its
font file is never committed or served.

## Library and visibility

Library items: `recording`, `render` (manual edits and auto clips), `screenshot`, `twitch_clip`
and `clip_export`. Renders and screenshots keep their files under `b/<b>/library/<item>/`, with
asset rows not tied to a session. Deleting a session or a recording therefore never deletes them.

| Visibility | Who can open it | Listed on the profile |
| --- | --- | --- |
| `private` (default) | The creator only | No |
| `unlisted` | Anyone with the `/v/<id>` link | No |
| `public` | Anyone | Yes (optionally **featured**) |

The channel-level "Public channel" switch overrides every item. While the channel is private,
nothing in the library is visible to anyone else, the profile returns 404 (the owner sees a
preview), and poster links return 404.

A recording's video follows its library item. The session's AI log follows the existing session
rules (public channel, public analysis, public session). A public session can therefore show its
log without its video until the creator shares the recording.

What deleting does:

| Action | Effect |
| --- | --- |
| Delete a recording item | Deletes the MP4 and poster. The session and its AI log stay. |
| Delete a render or screenshot | Deletes the item and its own files. |
| Delete a session | Deletes everything in the session's storage, its recording and recording source, and its Twitch clips and clip exports. Renders and screenshots stay, with `session_id` cleared. |
| Recording expires | Same as deleting the recording item; clips and screenshots stay. |
| Studio "Delete everything" | Sessions are scheduled for deletion; the whole library and all edit projects are deleted now. |

Every signed media URL is short-lived. Images last `MEDIA_URL_TTL_SECONDS` (default 300 s).
Video links last at least 6 hours, because players request new byte ranges whenever the viewer
seeks.

## Sharing

Finished clips go to TikTok, Instagram, YouTube or any other app with **no platform API**: no
developer accounts, keys or app reviews. The video file is handed to the device's own share
sheet, and the creator posts it from the app.

**Where.** The item page `/v/<id>` (owner) and **Share** on each finished clip in Studio → Library.
Only rendered videos are shared as files: edited clips, auto clips and clip exports. Recordings
are too large; cut a clip first. Screenshots and Twitch clips use Download or the page link.

**How it works** (`apps/web/components/clipper/ShareClip.tsx`, helpers in `apps/web/lib/share.ts`):

1. When the panel appears, a clip up to 60 MB is downloaded into memory as a `File`. Larger
   clips show **Prepare to share** first. Above 300 MB the browser path is refused with a clear
   message, and Download is offered instead. Progress is shown while it loads.
2. The browser is asked `navigator.canShare({ files: [file] })` for that exact file.
3. **Share** calls `navigator.share({ files, title, text })` inside the tap. Preparing the file
   beforehand keeps the user gesture valid. Closing the sheet is silent. A browser that refuses
   the gesture says "press Share again".
4. **Fallback**, when the Web Share API or file sharing is missing (common on desktop
   browsers): Download, plus buttons that open each platform's upload page in a new tab. The
   upload pages were verified on 2026-11-01:
   - TikTok: `https://www.tiktok.com/`, then Upload (top right)
   - YouTube Studio: `https://studio.youtube.com/`, then Create, Upload videos. Shorts are
     vertical or square and up to 3 minutes.
   - Instagram: `https://www.instagram.com/`, then + Create

   No deep link drops a file into these sites from the web, so the creator picks the
   downloaded file there.

**Captions.** Many apps ignore text that arrives with a shared file. The panel therefore has an
editable caption and **Copy caption**. The starting caption is the title plus up to four tags.
A big moment SLOT1 read (MISSION PASSED, WASTED, BUSTED…) becomes its own tag, for example
"MISSION PASSED!" followed by "#GTA #MissionPassed #gaming #clips".

**Format.** Vertical 1080×1920 H.264/AAC MP4 suits TikTok, Reels and Shorts. A widescreen
clip still shares, with a note and a link to make a vertical version in the editor. Clip
exports already prefer their vertical file.

**Privacy.** Only the owner ever gets the file. Other people see **Share link** on public and
unlisted items and on public profiles. It shares the page URL with `navigator.share({ url })`,
or copies it when the API is missing. Private items show no share option to anyone else; they
return 404. With S3 storage, the media origin (`SLOT1_MEDIA_ORIGINS`) is allowed in
`connect-src` so the file can be fetched. The bucket's CORS rules must allow GET from SLOT1's
origin.

**Tests.**
- `tests/unit/share.test.ts`: caption builder, file names, which items can be shared, and the
  upload-page hosts.
- `tests/unit/csp.test.ts`: the media origin in `connect-src`.
- `tests/e2e/share.spec.ts`, at desktop and 390 px against a real rendered clip. It mocks
  `navigator.share` to check the File (type, name and size) and covers:
  - the fallback links;
  - editing and copying the caption to the clipboard;
  - the Library panel;
  - link-only sharing for other people, and a 404 once the item is private.

## Public profile and link previews

`/c/<login>` is in the site's GTA poster style: live-now banner, featured, clips, recordings and
screenshots. It lists only `public` + `ready` items. Each item opens at `/v/<id>`.

Meta tags: title, description, canonical URL, Open Graph (`profile` / `video.other`) and a
Twitter `summary_large_image` card. Link-preview images use the stable endpoint
`/api/library/<id>/poster`, not an expiring media link, so share cards keep working. It serves
only items anyone may see. Unlisted item pages are `noindex`. Absolute URLs use
`SLOT1_PUBLIC_ORIGIN`, so a forged Host header can't change them.

## API

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /api/library?kind=&visibility=` | Owner | Items and storage usage |
| `GET /api/library/:id` | Owner, or anyone for shared items of a public channel | One item |
| `GET /api/library/:id/poster` | Anyone, shared items of a public channel | Stable poster image for link previews |
| `PATCH /api/library/:id` | Owner | `title`, `visibility`, `featured` |
| `DELETE /api/library/:id` | Owner | Delete (see above) |
| `POST /api/library/screenshots` | Owner | Screenshot from media, live or evidence |
| `GET/POST /api/projects` | Owner | List or create edit projects |
| `GET/PATCH/DELETE /api/projects/:id` | Owner | Read (with playback, markers and renders), save, delete |
| `POST /api/projects/:id/render` | Owner | Queue a render (optional `RenderOptions` for one preset) |
| `POST /api/projects/:id/exports` | Owner | Batch export: `{ presets[], format, height, fps, quality }`, one library item per preset |
| `POST /api/projects/:id/thumbnail` | Owner | A 1280×720 PNG thumbnail into the library |
| `GET/POST /api/projects/:id/captions` | Owner | Generated captions (status and cues), or start generating them |
| `GET/POST /api/editor/media`, `DELETE /api/editor/media/:id` | Owner | The creator's uploads for edits (multipart, rights confirmation required) |
| `GET /api/editor/waveform/:sessionId` | Owner | Timeline waveform peaks of a session's audio (built once by the worker) |
| `GET /api/profiles/:login` | Anyone (public channel) or owner | Profile data |

Every mutation needs the session cookie and the CSRF header, like the rest of the API.

## Data model (migrations `0003_clipper.sql`, `0007_clipper_pro.sql`)

- `channel_settings`: `recording_enabled`, `recording_retention_days`, `auto_clips`,
  `auto_clip_pre_roll_ms`, `auto_clip_post_roll_ms`.
- `recordings`: one per ingest session. Holds status, `runs` (segments per reader run),
  `rebased_until`, duration, bytes and `expires_at`.
- `edit_projects`: EDL JSON, `origin` (`manual`/`auto`) and `auto_key` (idempotent per
  observation).
- `library_items`: kind, title, visibility, featured, status and links to the session,
  recording, project, clip job, job run and assets.
- `media_sources.kind` adds `recording`; `evidence_assets.kind` adds `recording_segment`,
  `screenshot`, `render` and `poster`.
- `0007_clipper_pro.sql`: `library_items.kind` adds `thumbnail`; `library_items` gains `preset`,
  `format` (`mp4`, `gif`, `audio`, `png`; default `mp4`) and `render_options`; new table
  `project_media` (the creator's uploads for edits, with `rights_confirmed_at`). Generated
  captions are stored as a file next to the edit; waveform peaks next to the session's media.

## Tests

- **Unit** (`tests/unit/clipper.test.ts`):
  - EDL validation, output-time arithmetic and big-moment recognition;
  - `cropFor` edges and evenness;
  - the filtergraph builder: seeks, crop, speed and atempo, fit backdrop, silence, text, captions
    on the output timeline, fades, volume, encoders and remote inputs;
  - recording run offsets;
  - editor time parsing;
  - fonts (never Pricedown).
- **Integration** (`tests/integration/clipper.test.ts`, real Postgres, Redis, ffmpeg and
  tesseract):
  - one auto clip around MISSION PASSED, checked with ffprobe (1080×1920, ~14 s, audio, moov
    before mdat);
  - frame-accurate full-resolution screenshots, checked by pixel difference against the exact
    frame and the keyframe, plus the black segment;
  - evidence screenshots;
  - an EDL render with cuts, 2× speed, text and fades, checked with ffprobe (1920×1080, 5 s);
  - visibility, profile and channel kill-switch rules;
  - deletion cascades and library deletion.
  - Through a real **nginx-rtmp publish**:
    - consent gating, and recording across two reader runs;
    - a live screenshot, and a live auto clip cut from segments;
    - finalization to a faststart MP4 with poster and probe;
    - observations re-based onto the file (a screenshot at the re-based MISSION PASSED time
      shows that scene);
    - recording privacy on a public session;
    - the retention sweep keeping clips and screenshots, and session deletion.
- **Unit** (`tests/unit/clipper-pro.test.ts`): EDL back-compat (older edits parse, get every
  default and render with the original command), validation messages, render options, the JSON
  Schema, timing through ramps and transitions; the editing operations (split, ripple delete,
  trims carried through source time, roll, move, delete with and without ripple, snapping,
  instant replay, the three templates with and without the data they need); and the filtergraph
  for every feature (facecam split, keyframes, ramps, every transition, grades, every effect,
  overlay text/images/picture-in-picture, captions, the audio mix with ducking and loudness,
  presets, GIF, audio only, thumbnails, unknown library items).
- **Integration** (`tests/integration/editor.test.ts`, real Postgres, Redis and ffmpeg): uploads
  with the rights check; refusing other creators' files and unknown library items; a vertical
  facecam split with a crossfade, a flash, WASTED, captions and ducked music, checked with ffprobe
  and by its pixels (the gold divider, the frozen grey WASTED frames, captions appearing only
  during their cue) and its loudness (about −14 LUFS); ducking measured on an audio-only export
  (the music drops while the game audio has sound); a three-platform batch export (720×1280,
  720×1280, 1280×720), a GIF and a refused X export; a 1280×720 thumbnail; timeline waveforms;
  the captions requirement message; deleting uploads.
- **E2E** (`tests/e2e/clipper.spec.ts`): the Library tab and editor flow (screenshot, edit clip,
  keyboard in/out, the multi-track timeline, undo/redo, split, preset switch, text, render, share,
  public profile) at desktop and 390 px. It checks for no console errors and no horizontal
  overflow.
