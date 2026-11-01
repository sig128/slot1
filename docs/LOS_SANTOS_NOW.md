# Los Santos right now

`/los-santos` (the **Right now** tab) shows every public stream SLOT1 is watching and what SLOT1 actually saw on each one in the last minute, with a game-radio-style wheel to switch between them.

## Who is listed

- **SLOT1 streams**: a session that is still open, whose creator's video is reaching SLOT1 right now (a publishing ingest source attached to it), with the channel public, public analysis on, and the session itself public. One stream per creator. Private channels, private analysis, private sessions and ended streams never match the query, so nothing of theirs (name, session, frame, log text) can appear in the response. The answer is the same for every viewer, including a private stream's own creator.
- **Twitch only**: channels in the On Air directory (connected, opted in, public) that Twitch says are live but don't send video to SLOT1. They are shown as such: Twitch's own player and thumbnail, "Not analyzed by SLOT1", no activity, no log.
- TEST sources stay labeled as test streams. A test stream is never presented as live gameplay.

When nobody is live the page says "Nobody's live in Los Santos right now" with the honest reason, for example: "No creator is sending a public stream to SLOT1 right now. Twitch isn't configured here, so Twitch-only channels can't be shown."

## What each stream is doing

`deriveActivity` in `packages/contracts/src/now.ts`, from observations SLOT1 **received in the last 60 seconds**. Rejected entries and Twitch-side entries (chat, platform events) never count. Higher tiers win; within a tier, the most recent wins.

1. **Events**: result screens read on screen or by the GTA model (Mission passed, Mission failed, Wasted, Busted); police chase (movement "chase"); crash (possible collision); shootout (combat).
2. **Scene**: the GTA model's scene class: Driving, On foot, Shootout, Cutscene, In the menu or map, On the phone, Loading.
3. **Mission text**: mission titles or objectives read by OCR (at least 3 characters).
4. **Live**: nothing recent. The detail says why instead of guessing: "Nothing SLOT1 could name in the last minute", "Analysis paused by the creator", "AI analysis is off for this stream", "Feed stale: no new frames, so nothing is being analyzed", and so on. A stale feed also gets a "Feed stale" chip.

Each activity carries the observation's own words and when SLOT1 received it ("seen 12 s ago").

## The API: `GET /api/now`

`{ streams, emptyReason, generatedAt, refreshMs }`. Each stream has its kind (`slot1` or `twitch`), label, session, title, category, Twitch viewer count (only when Twitch returned one), a thumbnail, the activity, the analysis state, the five most recent log entries (last 15 minutes) and its watch page.

- **Thumbnails**: SLOT1 streams use the latest frame SLOT1 received, as a signed link that lives 2 minutes, and only after checking the frame belongs to that public session. Twitch-only channels use Twitch's preview image.
- **Efficiency**: two indexed queries for all streams (the activity window and a lateral "last five" per session) plus one asset lookup; Twitch's live state comes from the snapshots SLOT1 already caches in Redis (about 60 s). The result is computed once per 3 seconds per API process with a single in-flight computation, whatever the number of viewers.

### Why polling, not SSE

The page polls every 5 seconds (`refreshMs`) while the tab is visible, and refreshes when it becomes visible again. The data is one public snapshot, identical for everyone and changing every few seconds anyway, so a cached poll costs one cheap JSON response per viewer, needs no long-lived connections or per-viewer fan-out, and can be cached by a CDN (`cache-control: public, max-age=2`). SSE would add a connection per viewer and a publisher for an aggregate that is cheaper to recompute than to diff. A stream's own Watch page keeps its live SSE log.

## The page

- The **main player** for the selected stream, as on the Watch page: SLOT1's own live video when it's available, otherwise Twitch's player; for a local creator without Twitch, the latest frame SLOT1 received, labeled as such.
- The stream's activity in big type, its last AI entries (each a moment link to that second), and a card for every live stream. `?stream=<login>` selects a stream and is kept up to date for sharing.
- **The wheel** (original design in SLOT1's colors and type, no game artwork): avatars or latest frames around a ring, the highlighted slice lit, the stream's name and activity in the middle. Open it with **Choose stream** or **Q**. Arrow keys move clockwise (Right/Down) or back (Left/Up) with wrap-around, Home/End jump to the ends, **Enter** or Space switches, **Esc** or Q closes. Pointer and touch: point to highlight, click or tap to switch. It is a modal dialog with a `radiogroup` of `radio`s (roving focus starting on the stream that's playing), and focus returns to **Choose stream** when it closes.
- **Below 640 px** the same selector is a compact strip in a bottom sheet (horizontal, scrolls inside itself, the page never scrolls sideways) with the same keys.
- Reduced motion turns off the transitions.

## Tests

- `tests/unit/now.test.ts`: activity priority and freshness rules, and the wheel's keyboard and pointer logic (`apps/web/lib/wheel.ts`).
- `tests/integration/now.test.ts`: public and live only; private channel, private analysis, private session and ended streams never appear, not even for their owners; activity priority from real observation rows; quiet and paused streams labeled honestly; signed thumbnails that serve the frame; Twitch-only directory channels shown as watch-only; the shared cache; the empty reason.
- `tests/e2e/los-santos.spec.ts` (desktop and 390 px, dev stack): two TEST streams really published; the list, the selected stream, the wheel (desktop) and strip (390 px) opened with Q and the button, switching by keyboard and by pointer, Esc, focus return, no sideways scrolling, no console errors. Seeding: `tests/e2e/support/live-seed.ts`.
