# Forwarding ("relay"): stream once, go live everywhere

The creator streams **once**, from OBS to SLOT1. SLOT1 analyzes that stream and passes the exact same audio and video on to Twitch, YouTube, Kick or a custom RTMP(S) server. Nothing is re-encoded. The creator's upload stays at one stream however many places they go live.

## Setup flow (creator)

Everything happens in **Studio → Stream setup** (`/studio?tab=stream`).

1. **Point OBS at SLOT1.** Two ways:
   - **Set up OBS automatically.**
     1. In OBS 28 or newer, open Tools → WebSocket Server Settings and tick Enable WebSocket server.
     2. Click Show Connect Info and paste the Server Password into Studio. The port defaults to 4455.
     3. The browser then talks to OBS directly over `ws://localhost:<port>`, using the [obs-websocket 5 protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md):
        - Hello / Identify, with the SHA-256 challenge-response (`base64(sha256(base64(sha256(password + salt)) + challenge))`).
        - `GetStreamStatus`. If OBS is already streaming, setup stops, because OBS refuses stream-service changes while live.
        - Studio fetches a fresh SLOT1 key, then sends `SetStreamServiceSettings` with `rtmp_custom` and the Server + Key.
        - `GetStreamServiceSettings` reads the settings back to confirm.
     4. The password is used for that handshake only. It is never stored, never sent to SLOT1, and cleared from the form afterwards. The Content Security Policy allows `ws://localhost:*` on `/studio` pages only.
   - **By hand.** "Show my Server and Key" shows the one Server and Stream Key with copy buttons. The key is masked until the creator clicks Show. Paste them into OBS → Settings → Stream → Service: Custom.
   - In both cases the key is shown or sent once; only its hash is stored. Asking again replaces the key. While the creator is live, that is refused (409) unless they confirm, because the new key would cut the stream.
2. **Choose where it goes.**
   - **Twitch:** no key to paste. Connect my Twitch already includes `channel:read:stream_key`, and SLOT1 reads the key with [Get Stream Key](TWITCH_SCOPES.md). A creator who connected before that sees "Grant the missing permissions" (or "Let SLOT1 forward to Twitch"), a re-authorization that asks for every creator scope again. Right after connecting, the guided setup offers "SLOT1 sends your stream on to Twitch" as a switch that starts on; the destination is created when the creator chooses Finish setup, never before.
   - **YouTube:** paste the stream key. The server is prefilled with YouTube's RTMPS ingest, `rtmps://a.rtmps.youtube.com:443/live2`, as listed in OBS's [services.json](https://github.com/obsproject/obs-studio/blob/master/plugins/rtmp-services/data/services.json). It can be overridden with the RTMPS URL that YouTube Studio's stream settings show.
   - **Kick:** paste the Stream URL and Stream Key (creator dashboard → Settings → Stream, per [Castr's guide](https://castr.com/blog/how-to-find-kick-stream-key/)).
   - **Custom:** any `rtmp://` or `rtmps://` server on the public internet, with the key in its own field.
   - Each destination has an on/off switch, a live status, its last error and the last time it connected. At most `RELAY_MAX_DESTINATIONS` (4) per creator, one each for Twitch, YouTube and Kick.
3. **Go live.** Click Start Streaming in OBS. Forwarding starts within a few seconds and stops when the stream to SLOT1 ends or a destination is switched off.

From chat, the broadcaster and approved moderators can use `!slot1 relay` (statuses only, never addresses or keys), `!slot1 record on|off` (explains the consent step if it's missing) and `!slot1 autoclip on|off`. Chat announcements ("SLOT1 is watching", "Auto-clip ready" with a link) are opt-in under Bot and chat. They reuse the notice and dedupe path and are capped at 3 per 5 minutes per channel.

## How it works (operators)

- **Availability.** Forwarding exists whenever continuous ingest is configured (the same `INGEST_*` variables). Settings are in `.env.example` under "Forwarding". Only sources labeled LIVE are forwarded; TEST sources never are.
- **Who runs it.** `RelaySupervisor` (`apps/worker/src/live/relay.ts`) checks every 3 s for enabled destinations whose creator is publishing.
  - Each destination gets one ffmpeg process, owned by one worker through a Redis lease (`relay:<destination id>`, 10 s TTL, renewed while running and during backoff). If a worker dies, another takes over within about 10 s.
  - Up to 32 relays per worker.
- **The ffmpeg command.** `ffmpeg -rw_timeout 15000000 -i <SLOT1 read URL> -map 0:v:0? -map 0:a:0? -c copy -progress pipe:1 [-tls_verify 1 -ca_file <bundle>] -f flv <server>/<key>`
  - A destination shows "live" only once ffmpeg reports bytes actually written.
  - On failure it shows "retrying" with the reason, for example "Lost a.rtmps.youtube.com: Connection refused. Retrying in 8s".
  - Backoff is 2 s, 4 s, 8 s and so on, capped at 60 s. It resets after 30 s of healthy streaming.
- **Isolation.** A destination failing never touches the others, recording or analysis. Forwarding reads the stream as a separate gateway reader.
- **Twitch keys.** The Twitch key is fetched fresh at each start, so a reset at Twitch is picked up. It is cached encrypted as a fallback during Twitch outages. A 401 or 403 means "needs permission", never a guess.

| Status | Meaning |
|---|---|
| Off | Switched off |
| Ready | On; starts when the creator streams to SLOT1 |
| Connecting / Live / Reconnecting | Forwarding state; Reconnecting keeps the last reason |
| Problem | A setup error the creator must fix (unreadable key, server not public, unknown host) |
| Needs permission | Twitch forwarding wasn't allowed or was withdrawn; cleared automatically when it's granted |

## Bandwidth and cost

SLOT1 receives each stream once and sends one copy per enabled destination: **about 6 Mbps per destination per stream** at a typical 1080p60 OBS bitrate.

- Example: 100 creators forwarding to 2 platforms each is about 1.2 Gbps out, plus 0.6 Gbps in.
- Because it is copy-only, CPU stays small. Measured here: relaying a 3.5 Mbps stream in real time took about 0.4 s of CPU per 30 s, roughly 1.3% of one core. That ran file → /dev/null, so network I/O will add some.
- Egress is the real cost to plan for.

## Reliability trade-off

Everything now runs through SLOT1. If SLOT1's ingest or workers have a problem, the creator's stream stops on **every** platform until it recovers. Before, OBS → Twitch didn't depend on SLOT1.

- OBS reconnects to SLOT1 on its own (Settings → Advanced → Automatically Reconnect).
- Destinations reconnect with backoff.
- Creators who can't accept that risk can keep streaming to Twitch directly and send SLOT1 a second output.

The latency forwarding adds hasn't been measured. It is copy-only, but nginx-rtmp and ffmpeg each buffer.

## Platform simulcast rules (check before going live everywhere)

- **Twitch.** Simulcasting is allowed for everyone, including Affiliates and Partners, except under exclusivity agreements. The conditions:
  - no links to other platforms in Twitch chat or on stream;
  - Twitch chat comes first, so a combined chat can't be shown on Twitch;
  - the Twitch stream must be of equal or better quality than the others;
  - Twitch warns before restricting.

  Source: [Restream, "Twitch multistreaming rules explained"](https://restream.io/blog/twitch-multistreaming-rules-explained/) (published Feb 21, 2024; updated Oct 2026). SLOT1 sends every platform the identical stream, so quality is always equal.
- **YouTube.** The least restrictive: simulcasting is allowed under the Community Guidelines, with no payout impact and no policing of links to other platforms. Source: [Streams Charts, multistreaming guide 2026](https://streamscharts.com/news/multistreaming-guide-2026-rules-explained) (Jul 2, 2026).
- **Kick.** Partners must turn on the "Multistreaming" toggle in their creator dashboard, and Kick cuts a Partner's payout by 50% for each hour also live on a competing platform. Moderation looks at the whole multistream. Source: Streams Charts, as above.

## Security

- **Destination keys are write-only.**
  - They are encrypted with the token key ring (AES-256-GCM, `SLOT1_TOKEN_ENCRYPTION_KEYS`).
  - The API never returns them; responses carry only the host and the last four characters.
  - Deleting a destination erases its row and key.
  - Only the owner can see or change a destination; anyone else gets a 404.
- **Keys never reach logs or status text.**
  - ffmpeg output is sanitized: known keys are replaced, and any `rtmp(s)://` URL is reduced to its host.
  - `sanitizeErrorMessage` strips streaming-URL paths everywhere.
  - pino redacts `streamKey`, `stream_key`, `keyEnc`, `key_enc`, `outputUrl` and `publishUrl`.
  - Unavoidable: the full output URL, with the key, is an argument of the ffmpeg process on the worker host, visible to anyone who can list that host's processes.
- **Forwarding goes only to the public internet.** Loopback, private, link-local, CGNAT, multicast and reserved addresses are refused, along with `localhost`, `*.local` and `*.internal`. The check runs when a destination is saved and again before every connection. `RELAY_ALLOW_PRIVATE_DESTINATIONS=true` is for tests only. ffmpeg resolves the name again when it connects, so a short DNS-rebinding window remains between the check and the connection.
- **RTMPS certificates are verified.** ffmpeg doesn't verify TLS certificates by default, so SLOT1 passes `-tls_verify 1` and a CA bundle: `RELAY_TLS_CA_FILE`, else the first system bundle found. A server with an untrusted certificate never receives the key; its status says "The server's TLS certificate couldn't be verified".
- **Browsers.** Chromium allows `ws://localhost` from an https page: it is not mixed content, and `upgrade-insecure-requests` doesn't rewrite it (checked in Chromium 153 from both an http and an https page). Chrome's Local Network Access may ask the creator to let the site connect to apps on this device; Studio tells them to choose Allow.

## What was verified in this build

- **Unit tests:** `tests/unit/relay.test.ts` and `tests/unit/bot.test.ts`. They cover:
  - server URL and key validation, and the private-address classifier;
  - key redaction in ffmpeg output, error messages and structured logs;
  - ffmpeg arguments (copy-only, TLS verification) and backoff;
  - the OBS authentication string against Node's crypto, and the SHA-256 fallback;
  - the Studio-only CSP allowance;
  - chat command permissions and replies.
- **Integration tests:** `tests/integration/relay.test.ts`, 12 tests on real Postgres and Redis.
  - CRUD with encryption at rest, the SSRF guard through the API, owner-only access, and the one Server + Key.
  - The Twitch key via a mock of Get Stream Key: permission flow, scope preservation, key reset, outage fallback and withdrawn permission.
  - Chat controls against real settings.
  - **A real relay:** ffmpeg publishes to nginx-rtmp's SLOT1 ingest app. The relay forwards to a second nginx-rtmp app over RTMP, and over RTMPS through a local TLS terminator using a test CA. ffprobe shows the received streams match the source.
  - A refused server and an untrusted certificate retry with backoff while the others stay live and SLOT1 keeps receiving frames.
  - Switching off and on; everything stops when publishing ends; a TEST source is never forwarded; no key appears in any log line or status.
- **E2E:** `tests/e2e/relay.spec.ts` in Chromium at desktop and 390 px, with no console errors and no sideways scroll. It covers:
  - one-click setup against a stand-in obs-websocket 5 server (`tests/e2e/support/obs-standin.ts`, not OBS);
  - wrong password, missing password, OBS streaming, and nothing listening;
  - copy buttons;
  - adding, switching (by keyboard) and removing destinations.
- **Not verified here:**
  - real OBS;
  - real Twitch, YouTube or Kick ingest servers and Twitch's real Get Stream Key (this environment has no route to them);
  - Chrome's Local Network Access prompt itself;
  - Firefox and Safari;
  - the latency forwarding adds.
