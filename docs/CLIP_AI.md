# AI clip tools

SLOT1 already knows what happened in a session: what it read on screen, what its vision model
saw, where the scene cuts and black screens are, and when chat asked for a clip. The AI clip
tools turn that into editing help. Most of them work without any AI key, because they run on
what SLOT1 already measured. The two that write text need the server's text model.

| Tool | Where | Needs an AI key |
| --- | --- | --- |
| Find my best moments | Studio → AI clip tools | No |
| Make a best-of reel | Studio → AI clip tools (tick moments, then "Make a best-of reel") | No |
| Cut the boring parts | Editor → AI assistant → Cut the boring parts | No |
| Sounds & effects (quick polish) | Editor → AI assistant → Sounds & effects | No. "Let the AI choose and time the sounds" does |
| Write my post | Editor → AI assistant → Write my post | Yes |
| Edit it for me | Editor → AI assistant → Edit it for me | Yes |

Nothing a tool proposes changes an edit until the creator applies it. Applying goes through the
editor's own `onApplyEdl`, so it is undoable there, and the panel also offers a one-step Undo.
Nothing is rendered automatically.

## Honesty rules

- Every ranking reason is something SLOT1 measured or read, with its media time: "MISSION
  PASSED read on screen at 00:28", "Audio spike +31 dB at 00:16", "4 scene cuts in 11 s from
  01:40", "Chat asked for a clip here (!slot1 clip) at 12:04". Vision observations say "AI
  vision:" and inferred ones say "(inferred)".
- The score is SLOT1's own 0–100 ranking scale, shown as one to five stars. It is a ranking,
  not a measured quality.
- Text written by the model (post copy, the one-line summary of an edit proposal) is labeled
  "AI-written". The list of changes under a proposal is computed by SLOT1 from the two edits
  (`describeEdlChanges`), never written by the model.
- When there is no AI key, the tools that need one say exactly that, with the fix: "No AI key
  is set on this server. On the server, run: slot1 ai".

## Find my best moments

`GET /api/clip-ai/sessions/:id/moments` ranks one session (`rankMoments` in
`packages/services/src/clip-ai.ts`, a pure function).

**Signals and points.**

| Signal | From | Points | Window (before / after) |
| --- | --- | --- | --- |
| Result screen | MISSION PASSED, MISSION FAILED, MISSION COMPLETE, WASTED, BUSTED read on screen (`bigMoment`) | 40 | 10 s / 4 s |
| Mission title | `mission_title` observations | 22 | 2 s / 8 s |
| Action | possible collision 24, combat 24, reaction 12, sirens 10, vehicle swap 8 | 8–24 | 5 s / 5 s |
| Highlight | `highlight_candidate` | 16 | 5 s / 5 s |
| Text and vision | objectives 6, dialogue and places 4, HUD and other text 2, vision scene facts 2–5 | 2–6 | 3–4 s / 4 s |
| Audio spike | a second at least 9 dB above the session's median level (silence ignored) | 12 + up to 18 | 5 s / 5 s |
| Fast cuts | 3 or more scene cuts within 20 s | 10–18 | 2 s / 8 s |
| Clip request | a clip job with a media time (web or `!slot1 clip`) | 20 | 20 s / 5 s |

Platform facts (Twitch), rejected observations and coverage measurements (black screens,
silence, media facts) never count as moments.

**Grouping.** Moments grow around their strongest signal. The strongest signal not yet used
seeds a moment and takes every unused signal within 12 s of it. The next strongest seeds the
next moment, and so on. A busy stretch therefore splits into separate moments instead of
chaining into one long one. The moment's window covers each member's before and after time,
is at least 8 s and at most 60 s, and stays inside the stored video. Moments that overlap by
more than half keep only the stronger one.

**Score.** The members' points, strongest first, are weighted 1, 0.7, 0.5, 0.35, 0.25, then 0.2.
Each extra kind of signal adds 4 (at most 12). The total maps to 0–100 with
`100 × (1 − e^(−raw / 55))`. Stars are `ceil(score / 20)`, from 1 to 5. A moment with three or
more signals also gets a reason like "5 things within 9 s".

**Audio.** Loudness comes from a one-time worker job (`clip-ai-audio` on the library queue,
`apps/worker/src/jobs/clip-ai.ts`). ffmpeg measures one RMS level per second at 8 kHz mono
(`astats`, about a second of work per hour of video). The levels are stored in
`clip_ai_audio.rms_db`. Studio starts the job the first time a session with stored video is
opened, and "Cut the boring parts" starts it for each video in the edit. Until it finishes, the
ranking says so and refreshes every few seconds. A job that hasn't finished after 30 minutes
counts as failed and can be started again. A new stored file (a new upload or recording) makes
the old levels stale.

**Turning moments into edits.** `POST /api/clip-ai/sessions/:id/clips` with
`{ mode: "single" | "reel", aspect, moments }`. It needs the session's stored video (an upload
or a finished recording). Times from the browser are kept inside the video, and moments outside
it are dropped. `momentsEdl` builds the edit:

- **single.** One project per moment, titled "MISSION PASSED · Docks run". It gets a title
  (mission or wasted style on result screens) and a MISSION PASSED or WASTED effect at the
  moment the result was read.
- **reel.** One project, "Best of Docks run". The moments play in time order, each with a
  title card, joined with whip transitions. Loudness is normalized.

Vertical and square edits show the whole frame over a blurred backdrop. Widescreen fills the
frame. The editor opens on the new project.

## Cut the boring parts

`POST /api/clip-ai/boring` with `{ edl }` returns parts inside the edit's segments, in each
session's media time (`findBoringParts`, pure):

- **Black screen.** A `black_screen` observation of 0.8 s or more.
- **Loading.** "LOADING" read on screen, 1 s before to 2 s after.
- **Silence.** Below −50 dB for at least 2 s. This needs the audio levels.
- **Nothing happens.** No events for 15 s or more (25 s without audio levels), with audio
  quieter than usual when levels exist. The stretch is trimmed 2 s on each side.

Overlapping parts merge, and the clearer reason wins the label. A part that would remove a
whole segment is never offered.

The panel lists the parts with their times in the finished clip, all ticked. The creator
unticks what stays. `cutRangesFromEdl` (in contracts, so the browser can preview the result)
splits segments around the cuts:

- Pieces under 0.3 s go with the cut.
- Speed ramps stay continuous.
- The pan and zoom keys of each piece are kept.
- Transitions are shortened when the parts they join got shorter.

Everything placed on the finished timeline moves with the cut, so it stays on the same picture:
texts, overlay items and their keys, audio clips and volume keys, effects, caption cues and
words, game-audio volume keys and the cover frame. Items entirely inside a cut go with it.
The result is validated with `Edl.parse`. An invalid result is reported as an error and never
applied.

## Sounds & effects

`POST /api/clip-ai/polish` with `{ edl, sounds, music, effects, refine, tone }` places Studio
library items at real moments of the edit (`polishEdl`).

- **Sounds.** A whoosh just before each cut, then at real moments:
  - a stinger or hit on result screens (positive for MISSION PASSED, heavy for WASTED)
  - an impact on collisions and combat
  - a riser on sirens and mission titles
  - a pop on titles

  Library items are matched by tags, category and name. Repeats are varied, cues are kept
  0.6 s apart, and there are at most 14. They go on an existing sound-effects track or a new
  "AI sounds" track (four audio tracks at most).
- **Music.** One bed under the whole clip, matched to the mood (hype, clean or funny). It plays
  at 35%, ducks under voices, fades in and out, and loops when the track is shorter than the clip.
- **Effects.** MISSION PASSED or WASTED where a result was read. Punch-in and shake on
  collisions. Flash transitions between parts that are long enough.
- **Let the AI choose and time the sounds** (`refine`, needs a key). The text model gets the
  same cues, the moments, SLOT1's draft and the catalogue, and returns `ModelSoundPlan`. Only
  catalogue ids within 300 ms of a real cue are kept, and volumes are clamped. If the model
  fails, SLOT1's own matching is used and the note says why.

The reply lists the changes and every placed item, each with a play or preview button and
the reason it is there. An empty library is reported plainly ("The Studio library has no sound
effects yet").

Previews use the Studio library's file route by item id, `/api/studio/assets/file/<id>?v=<revision>`
(`studioAssetPreviewUrl`), so the browser caches each file once per library version.

## Write my post

`POST /api/clip-ai/post` with `{ edl, platforms, tone }`. The text model gets only facts: what
SLOT1 detected in the clip (with times in the clip) and transcript lines that fall inside it.
It is told not to invent events, names, kills, money or missions. Transcript text is wrapped
as data, never instructions.

| Platform | Title | Caption | Hashtags |
| --- | --- | --- | --- |
| TikTok | 60 | 150 | 5 |
| YouTube Shorts | 100 | 500 | 5 |
| Instagram Reels | 60 | 200 | 8 |
| X | 60 | the post, including hashtags, stays within 280 | 2 |

`tidyPost` enforces these limits, cleans hashtags to single `#words` and drops platforms that
weren't asked for. Posts are labeled AI-written, with copy buttons. The panel says how many
detected moments and transcript lines they were based on.

## Edit it for me

`POST /api/clip-ai/edit` with `{ request, edl }`.

1. **What the model gets** (`editForMe`):
   - the request, wrapped as untrusted text
   - the current edit as JSON
   - the media it may use: sessions, stored length and transcript count
   - up to 150 detected moments with session media times
   - a compact library catalogue: id, kind, category, name, tags and length, narrowed to the
     request when the library has more than 100 items

   The rules say: only these sessions, inside their stored video; output-timeline times for
   placed items; keep ids; only catalogue ids; only uploads the edit already uses; never invent
   moments.
2. **Constrained output.** The reply schema is generated at runtime from the zod `Edl` with
   `z.toJSONSchema` (`ModelEditProposal` → `toProviderJsonSchema` → `providerSchema`). It is
   strict: no defaults, `anyOf` instead of `oneOf`, enums instead of `const`. Anthropic gets
   `output_config.format`, and OpenAI gets a strict `text.format`. If a provider refuses the
   schema itself (400 about the schema), SLOT1 retries once in plain JSON mode with the schema in
   the instructions. The checks below are the same either way.
3. **Checks.**
   - `Edl.safeParse` (every rule of the editor's schema)
   - unknown library ids and unknown uploads are removed and listed ("SLOT1 removed library item
     “sfx/x” from the proposal because it doesn't exist")
   - sessions must be the edit's own
   - live-run segments must already be in the edit
   - segments must stay inside the stored video

   A failed check returns 422 with the reason. Nothing is applied.
4. **Review.** The panel shows the AI-written summary, SLOT1's own list of changes, the library
   items added (with play buttons), anything that was removed, the tokens used and the cost.
   Apply or Discard. If the edit changed while the model was working, the panel warns that
   applying replaces those changes.

## Costs, limits and logging

- The tools that call the text model are Edit it for me, Write my post and AI-chosen sounds.
  Together they are limited to 30 requests per channel per hour, counted in Redis
  (`clipai:rl:<broadcaster>:<hour>`). Per-route request limits also apply.
- Every call is logged in `usage_events` with `kind = 'clip_ai'`: provider, model, input and
  output tokens, and the estimated cost from `VISION_PRICE_INPUT_PER_MTOK` and
  `VISION_PRICE_OUTPUT_PER_MTOK` when they are set. A reply that isn't valid JSON is still
  logged, because it was still billed.
- Before sending, Edit it for me shows a rough cost per request when prices are set
  (`estimateEditTokens`: instructions and schema, the edit, typical moments and the
  catalogue, at about four characters per token). After each answer the real token counts
  and cost are shown.
- The text model is `ANTHROPIC_TEXT_MODEL` (or `ANTHROPIC_VISION_MODEL`) with
  `VISION_PROVIDER=anthropic`, or `OPENAI_TEXT_MODEL` (or `OPENAI_VISION_MODEL`) with
  `VISION_PROVIDER=openai`. On the server, `slot1 ai` sets the provider and key. The default
  `.env` already names the models.

## What is sent to the AI provider

Only for the tools that need a key:

- the edit's JSON
- labels of what SLOT1 detected, with times
- transcript lines inside the clip (Write my post)
- the session titles
- the Studio library catalogue
- the creator's request text

No video, audio or images are sent by these tools.

## Access

Every route needs a signed-in creator. Sessions, edits and projects must belong to that
creator. Anyone else gets 404, which doesn't reveal that the session exists. Mutations need the
CSRF token. The AI routes check ownership before the model is called, so a stranger's request
never reaches the provider.

## API

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/clip-ai/status` | | `ClipAiStatusResponse`: text model status, library size |
| `GET /api/clip-ai/sessions` | | `ClipAiSessionsResponse`: the creator's 30 latest sessions with media and audio status |
| `POST /api/clip-ai/sessions/:id/audio` | | `AudioAnalysisStatus` (starts the loudness pass once) |
| `GET /api/clip-ai/sessions/:id/moments?limit=12` | | `MomentsResponse` |
| `POST /api/clip-ai/sessions/:id/clips` | `CreateMomentClipsInput` | `{ projectIds }` |
| `POST /api/clip-ai/boring` | `{ edl }` | `BoringResponse` |
| `POST /api/clip-ai/polish` | `PolishInput` + `tone` | `PolishResponse` |
| `POST /api/clip-ai/post` | `WritePostInput` | `WritePostResponse` (503 without a key) |
| `POST /api/clip-ai/edit` | `EditForMeInput` | `EditForMeResponse` (503 without a key) |

Contracts live in `packages/contracts/src/clip-ai.ts`, services in
`packages/services/src/clip-ai.ts` and routes in `apps/api/src/routes/clip-ai.ts`. The UI is
in `apps/web/components/clipper/ai/`: `AiClipToolsSection` for Studio, and `ClipAiPanel` for the
editor (props `project`, `edl`, `onApplyEdl`).

## Data

Migration `0008_clip_ai.sql`:

- adds `clip_ai_audio`: one row per session with the stored file it measured, status, error,
  per-second RMS levels and length. It is deleted with the session.
- allows `clip_ai` in `usage_events.kind`.

## Tests

- **Unit** (`tests/unit/clip-ai.test.ts`). Covers:
  - ranking, grouping and reasons
  - audio peaks and parsing ffmpeg output
  - boring-part rules
  - cutting, including timeline remapping, ramps, slivers and refusing to cut everything
  - proposals: stripping assets and describing changes
  - strict provider schemas and the edit cost estimate
  - post limits and sound cues
- **Integration** (`tests/integration/clip-ai.test.ts`). Uses the real API, Postgres, Redis,
  ffmpeg and tesseract on a synthetic video (`tests/fixtures/clip-ai-video.ts`: black screen at
  8–10 s, a loud tone at 16–18 s, silence at 22–26 s, MISSION PASSED from 28 s). It covers:
  - ranking from real observations and a real loudness peak measured by the worker job
  - single clips and reels
  - boring parts and the cut
  - polish with a temporary library
  - AI-chosen sounds, posts and Edit it for me against a **local stub of the Anthropic API**:
    canned answers, invalid edits, outside sessions, past the end, non-JSON replies, provider
    busy, and the plain-JSON fallback
  - the hourly limit, access control and the no-key message
- **End to end** (`tests/e2e/clip-ai.spec.ts`, desktop and 390 px). Runs with no AI key:
  - upload the synthetic video
  - rank it and watch the loud moment join after the audio pass
  - make a best-of reel and open one moment in the editor
  - when the editor shows the AI panel, use its tabs

The model-backed tools were checked against the stub, not a real provider.
