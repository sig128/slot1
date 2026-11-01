# Live video on SLOT1 (WebRTC)

When a creator sends their stream to SLOT1, the Watch page plays SLOT1's own copy of it over WebRTC, next to the AI log. The delay is typically under a second; that figure is an estimate, see [Latency](#latency). Viewers can switch to Twitch's player at any time. Creators who don't send video to SLOT1 keep the Twitch player exactly as before.

## What it needs

| Requirement | Why |
|---|---|
| `INGEST_GATEWAY=mediamtx` | nginx-rtmp can't serve WebRTC. Studio and `/api/capabilities` say so when it's selected. |
| `INGEST_PUBLIC_WEBRTC_URL` | Browser-facing base of MediaMTX's WebRTC server, e.g. `https://live.example.com` (`http://localhost:8889` locally). It also goes into the page's Content-Security-Policy (`connect-src`). |
| Ports | `8889/tcp` WHIP/WHEP over HTTP (put TLS in front in production), `8189/udp` WebRTC media, `8890/udp` SRT (optional), `1935/tcp` RTMP |
| `INGEST_PUBLIC_SRT_URL` (optional) | Shown to creators as an SRT publishing option |

The remaining ingest variables (`INGEST_HOOK_SECRET`, `INGEST_READ_PASSWORD`, …) are unchanged; see the README.

## Publishing from OBS

Studio → Video sources → create a source. The stream key and the publishing details are shown **once**:

- **WHIP (lowest delay, OBS 30 or newer):** Settings → Stream → Service **WHIP**. Server = the WHIP URL (`<base>/live/<name>/whip`). Bearer Token = the stream key.
- **SRT:** the SRT URL shown once. It carries the key in its `streamid`.
- **RTMP:** server and stream key as before. Simple, but adds delay.

For low delay, use a keyframe every 1 s, no B-frames, and the encoder's low-latency or zerolatency tuning.

Every publisher is checked by SLOT1 through MediaMTX's HTTP auth hook. A WHIP publisher must present the exact stream key for its path. Revoking or rotating the key in Studio refuses it from then on.

### Hiding your webcam from the AI

Studio → Stream setup → **Hide your camera from the AI**. A creator draws up to three boxes over their webcam (or anything else) on their newest analyzed frame, or picks a corner preset. When nothing is live, they draw on a 16:9 placeholder. The boxes are stored on the live source as fractions of the picture (`media_sources.camera_mask`, migration `0006_camera_mask.sql`; `PUT /api/studio/sources/:id/camera-mask`, owner only).

Where the boxes are applied:

- **Before any analysis.** The worker's reader fills each box with black inside ffmpeg (`drawbox`, padded by 2 px), in the filter chain that produces the analysis frames (`LiveIngestAdapter` in `packages/analysis/src/sources.ts`). No unmasked analysis frame leaves ffmpeg.
- **Everything downstream of the reader** gets the masked frame and never the area inside a box:
  - on-screen text reading (OCR)
  - AI vision (Anthropic or OpenAI)
  - SLOT1's GTA model and the shared inference service
  - stored evidence frames and Studio's preview frame
  - "What the AI sees", which labels the black area "Hidden by the creator"
- **Not applied to what viewers get.** SLOT1's live video, the rolling buffer (instant replays), recordings, clips and forwarding stay the creator's full stream.
- **A changed box applies within a few seconds.** The worker notices the change and restarts its reader for the new mask. This restarts the rolling buffer and starts a new recording segment run.
- **It covers a fixed area.** If the creator moves their webcam in OBS, the part outside the box is analyzed like the rest of the picture.
- **Only frames from a live source.** Uploaded replays and analyzed Twitch clips aren't masked.

Verified in `tests/integration/camera-mask.test.ts` with real ffmpeg, nginx-rtmp and tesseract, and a stand-in for Anthropic's API that records the images it receives:
- Text inside the box is never read, while text outside it is.
- The box is black in every image sent to vision, in stored evidence frames and in the AI view.
- The rolling buffer still shows the webcam.
- A changed box applies within seconds.
- Only the source's creator can set the boxes.

### Sending to Twitch at the same time

OBS streams to one service by default. To send to Twitch and SLOT1 at once, add a second output with a multi-output plugin for OBS.

Twitch currently allows simulcasting for most streamers, according to Restream's summary of Twitch's guidelines ([Twitch multistreaming rules explained](https://restream.io/blog/twitch-multistreaming-rules-explained/), a third-party summary). The conditions are:

- Streamers with a Twitch exclusivity agreement may not simulcast.
- The Twitch stream's quality must be equal to or better than the copy sent elsewhere. Don't send SLOT1 a higher-quality copy than Twitch gets.
- No links to other streaming platforms in Twitch chat or on the Twitch stream.

Check Twitch's own Simulcasting Guidelines before relying on this.

## Who can watch

The player asks `GET /api/sessions/:id/live-video` for a playback grant: the WHEP URL plus a bearer token.

- The grant follows the same rules as everything else in a session. The creator can always watch. Everyone else can watch only a **public** session: channel public, public analysis on, and the session itself public. Private sessions return 404 to others.
- Tokens are HMAC-signed, valid for 120 seconds, and bound to one stream path. They are typed so that a media-URL token can't be reused.
- MediaMTX asks SLOT1 about every WebRTC viewer. Expired, tampered or other-path tokens are refused.
- Viewer tokens never open the worker's RTSP read. That read still needs the worker credential.
- On every (re)connect the player fetches a fresh grant. When the creator stops sending, the grant explains why, and the page falls back to the Twitch player.

## Networking (STUN/TURN)

WebRTC media travels over UDP between MediaMTX and each viewer.

- Set `MEDIAMTX_PUBLIC_HOST` (compose) / `MTX_WEBRTCADDITIONALHOSTS` to the public host name or IP, so the server's ICE candidates are reachable.
- Viewers behind strict NATs or firewalls that block UDP need a TURN server (for example coturn). Configure it in MediaMTX with `MTX_WEBRTCICESERVERS2_0_URL`, `MTX_WEBRTCICESERVERS2_0_USERNAME` and `MTX_WEBRTCICESERVERS2_0_PASSWORD`.
- When MediaMTX advertises ICE servers in WHEP `Link` headers, the player uses them.
- Browsers require HTTPS for the page and, in production, for the WHEP endpoint.

## Latency

These are estimates, not measurements. Nothing here was measured end to end through MediaMTX.

| Step | Typical |
|---|---|
| OBS encode with low-latency settings | under 0.15 s |
| WHIP upload and MediaMTX | 0.05–0.2 s |
| Network to the viewer and jitter buffer | 0.1–0.3 s |
| **Total, WHIP in and WebRTC out** | **roughly 0.3–0.7 s** |
| RTMP or SRT in instead of WHIP | add about 0.5–2 s, depending on keyframe interval and buffering |

The player shows a small "~0.4 s delay, estimated" badge, computed from WebRTC statistics (jitter buffer delay plus half the round trip). It covers only SLOT1 → this browser, not the streamer's encoder or upload. Its tooltip says so.

## What was verified in this build

- **Grant endpoint and hook rules:** `tests/integration/live-video.test.ts` (8 tests, real API code on Postgres and Redis). Covers:
  - capability reasons, including nginx-rtmp
  - WHIP and SRT details shown once
  - WHIP publish only with the key
  - creator yes, stranger and anonymous 404 on private, anyone on public
  - viewer token accepted; tampered, expired, other-path and media tokens refused
  - viewer tokens can't open RTSP
  - not publishing → reason
  - revoked → everything refused
- **Player in a real browser:** `tests/e2e/live-video.spec.ts`. The real Watch page, player switch and WHEP client run in Chromium at desktop and phone widths against a stand-in WHEP server (`tests/e2e/support/whep-standin.ts`: werift + ffmpeg H.264). The test checks:
  - decoded frames (`videoWidth > 0`)
  - the delay badge
  - unmute
  - switching to Twitch's player and back
  - no horizontal overflow
  - no console errors
- **Not exercised here:** MediaMTX itself (it can't be downloaded in this environment), OBS WHIP publishing, TURN traversal, and real-world latency.
