# Instant replay and clickable timestamps

While a stream is live, any moment in SLOT1's log can be replayed in a corner player in a second or two, and every timestamp SLOT1 shows (the log, Ask SLOT1 citations, Moments search, chat replies) jumps to that moment.

## The API

| Route | What it does |
|---|---|
| `GET /api/sessions/:id/instant-replay` | Whether instant replay works in this session, and if not, exactly why. |
| `POST /api/sessions/:id/instant-replay` | Cut (or reuse) a window. Body: `{ observationId }` for a moment in the log, or `{ secondsAgo: 3..60 }` for "the last N seconds". Optional `preMs` (default 8000) and `postMs` (default 4000). |
| `GET /api/moment-links/:observationId` | Where a moment link opens: `{ kind: "live", login, sessionId, observationId }` while the stream is live, `{ kind: "replay", sessionId, observationId, tMs }` once it has finished. |

**Access** is exactly the session's own (and so its SLOT1 live video's): the owner always; everyone else only when the channel is public with public analysis and the session is public. Anything else is a 404, the same as a session or moment that doesn't exist.

The POST answers one of:

- `ready`: a signed `url` to an MP4, the window in the reader's media time (`startMs`, `endMs`), where the moment sits inside it (`momentOffsetMs`), and when the link expires.
- `pending`: the end of the window isn't saved yet; ask again after `retryAfterMs`. The web player does this by itself and shows the reason ("Saving the last seconds of the moment").
- `unavailable`: with the precise reason, for example:
  - "Instant replay is off: the creator hasn't turned on recording or the rolling buffer in Studio."
  - "Instant replay needs the creator to send their video to SLOT1. This stream only reaches Twitch."
  - "That moment is no longer in the rolling buffer (it keeps the last 3 min)"
  - "SLOT1 isn't reading this stream right now, so its rolling buffer can't be replayed"

## Where the video comes from

1. **Recording on** (with the creator's recording consent): the copy-only 6 s segments the live recorder stored. Any API process can cut these. The moment is matched to its reader run by the time SLOT1 received it (the same rule the finished recording uses to re-base the log). After a reconnect, earlier moments are cut from the saved recording file instead.
2. **Only the rolling buffer on**: the buffer lives on the disk of the worker that reads the stream, so the API asks that worker over Redis (`slot1:ireplay:req:<sourceId>`, one channel per source; only the worker holding the source's lease subscribes). The worker reads `segments.csv`, keeps only segments whose files still hold them (the muxer reuses names in a ring, and the file after the newest is being rewritten), and cuts. The buffer is rewritten at each reader start, so moments from before a restart are reported as gone, never matched against the wrong clock.
3. **Neither**: unavailable, with the reason above.

## The cut

Only the window is re-encoded: the needed segments are joined (concat, no copy to disk), the start is seeked exactly (decode from the segment's keyframe, drop frames up to the start), and the result is encoded `libx264 -preset ultrafast`, at most 720p, AAC audio, `+faststart`. About 1.4 s for 12 s of 720p30 on two cores; measured 1.5 to 2.1 s in the integration test while the same machine was also publishing and reading the stream. While live, a replay starts as soon as 2 s after the moment are saved: the tail is cut short rather than waited for.

Cuts are cached by window (Redis, about 15 minutes), and concurrent requests for the same window share one encode. Files live under the session's storage prefix (`b/<b>/s/<s>/instant-replay/`), so deleting a session deletes them. They are **not** library items. A sorted set tracks their expiry; the worker's hourly retention sweep and every new replay request delete expired ones.

### Frame timing fix

The integration test showed that live (and upload) frame sampling labeled each frame half a sampling interval early: ffmpeg's `fps` filter with `round=near` emits, for slot *t*, the last frame before *t + interval/2*. Both samplers now use `round=up` (the last frame at or before *t*), so an observation's media time names the moment it shows, within one frame. This also makes live auto-clips, screenshots at a moment and every jump below land where they should.

## On the Watch page

- Each log entry with a place in the video gets **Replay**; so does the MISSION PASSED / WASTED / BUSTED banner.
- **Over SLOT1's own live video** (from 640 px wide) the replay plays in the top-right corner of that video. **When the main player is Twitch's**, it docks at the top of SLOT1's rail instead: nothing of SLOT1's ever covers Twitch's player. The live player switch reports which player is showing.
- Play/pause, a progress bar with the moment marked, close, **Back to live**, and **Esc**. Focus moves into the player when it opens and returns to the button that opened it. The entrance animation is skipped under reduced motion.
- When instant replay is off, one line at the top of the log says why instead of a button on every entry.

## Timestamps

- `?t=` on `/replay/<session>` and `/v/<item>` accepts `83`, `83.5`, `83s`, `1m23s`, `1h2m3s`, `01:23` and `1:02:03`; anything else is ignored, never guessed. Players land **3 s before** the moment so the run-up is visible. `/v/<item>` uses a media fragment (`#t=`), so it works before any script runs.
- `?moment=<observationId>` on `/watch/<login>` selects that entry and opens its instant replay while the stream is live; for a finished stream the page redirects to the recording at that second.
- `/m/<observationId>` is the short link. It resolves when opened (instant replay while live, the recording once finished) and is 404 for anyone who can't see the session.
- Ask SLOT1 citations jump: in a replay they seek the video, live they open the instant replay. Moments search results link to `/m/<id>` (or `?t=` when a moment has no observation). In replays each log entry gets **Play**, which seeks 3 s before it.
- Chat: `!slot1 find` and `!slot1 ask` replies end with the moment's short link, built by one shared helper (`momentLink(publicOrigin, observationId)` in `packages/contracts/src/moments.ts`) with the configured public origin. Only moments chat viewers could open get a link (public session, a place in the video). The reply text is shortened, never the link, to stay within Twitch's 500 characters.

## Tests

- `tests/unit/moments.test.ts`: time parsing and formatting, the link helper, chat replies with links, window planning, run matching and the rolling-buffer ring.
- `tests/integration/instant-replay.test.ts`: a real nginx-rtmp publish read by the real live supervisor. The off reasons; a replay cut from real recorded segments with ffprobe checks (duration, start at 0, at most 720p, faststart) and the first frame found by timestamp in the stored segment; the moment frame showing the scene SLOT1 read; the cache; nothing in the library; access as owner, public viewer, anonymous and after the session goes private; a replay cut from the rolling buffer by the worker holding it; moments from before a reader restart reported as gone; no worker reading; expiry sweep.
- `tests/e2e/instant-replay.spec.ts` (desktop and 390 px, dev stack): Replay opens and plays beside Twitch's player without covering it, focus handling, Pause, Back to live, Esc; a `/m/` link opening the replay; `?t=` on the recording and its `/v/` page, and the log's Play jumps.
