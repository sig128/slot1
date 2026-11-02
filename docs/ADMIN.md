# Admin dashboard, visitor counting and the contact inbox

`/admin` is the operator dashboard. It shows:

- **Right now:** people on the site now, by page; live streams and their viewers; health of the worker, ingest gateway, GTA model service and job queues.
- **Visitors:** today, 7 days, 30 days and all time; a daily chart; top pages, referring websites, devices and browsers.
- **Platform:** accounts, creators, the chat bot, video sources, sessions, observations, library, stored files and forwarding.
- **AI:** vision, OCR, speech-to-text and GTA model status, plus provider calls and estimated cost.
- **Messages:** what people sent through `/contact`.
- **System:** version, uptime, database, Redis, free disk, admin sign-ins, job queues and recent failures.
- **Settings:** the server's settings, changed in the browser (below), the automatic updates and their last log, the admin password, and recent "Sign in with Twitch" attempts with Twitch's own words.

The public `/status` page shows, for anyone, whether the website, accounts, sign-in with Twitch, streaming and the AI work, and which version runs. It shows no settings, no Twitch error texts and no visitor numbers.

Every number is counted from the database, Redis or the running services. Where something isn't measured, the page says so. It refreshes every 10 seconds while the tab is visible.

## Who can open it

| Who | How | Can do |
|---|---|---|
| Admins | The admin password, entered at `/admin` (below) | `/admin` and `/api/admin/*` only |
| Operators | Sign in with Twitch with a login listed in `SLOT1_OPERATOR_TWITCH_LOGINS` | `/admin`, plus operator tasks elsewhere (linking the bot account, the model registry) |
| Admin-link holders | A one-time link made on the server (below) | `/admin` and `/api/admin/*` only |
| Everyone else, signed in or not | | Nothing. `/admin` shows the password form; `/api/admin/*` answers with the normal 404, the same as a page that doesn't exist. |

The pages and API answers are `noindex` and never cached.

### Admin password

The usual way in: `/admin` shows a sign-in form with one password field to anyone without access.

**Setting or changing it**, on the server:

```sh
slot1 admin-password
# asks for the new password twice without showing it, then pipes it on stdin into:
docker compose exec -T api node dist/admin-password.js
```

- The password needs at least 12 characters, counted the way people count them (an emoji is one). The command reads it from stdin only, never from the command line, so it can't end up in shell history or a process list.
- It prints `SLOT1_ADMIN_PASSWORD_HASH=scrypt$32768$8$1$<salt>$<hash>` as its last line: scrypt with N = 2^15, r = 8, p = 1 and a random 16-byte salt, base64. Only this hash is stored. The server script writes it to `.env` in single quotes, `SLOT1_ADMIN_PASSWORD_HASH='scrypt$…'`, because Docker Compose would otherwise read each `$…` as a variable. Then it recreates the api container, which reads the hash at start.
- **Changing the password signs out every admin session**, one-time-link sessions included. Setting the first password does too. Each session carries a tag of the hash it started under; a session with an old tag is deleted the next time it's used.
- With no hash set, or a malformed one, `/admin` says "No admin password is set on this server yet" and shows the command. One-time links keep working.

**Signing in:**
- The form sends `POST /api/admin/login` `{password}` with the usual CSRF token and `Origin` check. A correct password starts the same 12-hour admin session as a one-time link (below), and the page shows the dashboard. "Sign out" on the dashboard ends it.
- The password is checked with `timingSafeEqual` on the scrypt output. Every wrong password gets the same answer, "That didn't work. Check the password and try again.", and never sooner than 0.75 s.
- **5 wrong passwords per address in 15 minutes.** After that, the address waits out the 15 minutes, even with the right password. Each attempt is counted before the password is checked, so parallel requests can't slip past the limit. A correct password clears that address's count.
- **Pause for everyone (soft lockout):** after 20 wrong passwords within 15 minutes, from anywhere, password sign-in pauses for everyone. The pause is 1 minute, doubling every 10 more failures, up to 15 minutes. One-time links and operator sign-in still work, so if an attack keeps the form paused, use `slot1 admin-link`.
- **No addresses stored.** The counters live in Redis under an HMAC of the address, keyed with `SLOT1_SESSION_SECRET`. At most two password checks run at once and at most 32 sign-ins are handled at a time, so a burst can't starve the rest of the API.
- **What is recorded:** sign-ins, wrong passwords and attempts refused by the limits, counted per UTC day in Redis for 9 days, plus the time of the last sign-in and the last wrong password. System → Admin sign-ins shows today and 7 days, and any pause in force. Passwords and addresses are never recorded; the API log notes each event without them.
- **SameSite=Strict:** the admin cookie is never sent on a request that starts on another site. Following a link to `/admin` from elsewhere first renders the form. The page then asks the API from the site itself and shows the dashboard if this browser is signed in already.

### One-time admin link

Use it before an admin password is set, when password sign-in is paused, or if the password is lost. On the server:

```sh
slot1 admin-link
# which runs, inside the api container:
docker compose exec -T api node dist/admin-link.js
```

It prints a link like `https://<your domain>/api/admin/link?token=…` as its last line.

- **Works once, within 15 minutes.** The token is HMAC-signed with `SLOT1_SESSION_SECRET` and carries a random nonce. The nonce is kept in Redis until the link is used, then deleted atomically, so a second use fails.
- **Opening it shows a button** ("Open the admin") instead of signing in straight away. Chat apps and email scanners that preview links therefore can't use it up.
- **Pressing the button** starts an admin session for 12 hours: a random `slot1_admin` cookie (HttpOnly, SameSite=Strict, Secure in production). Only its SHA-256 hash is kept in Redis. "Sign out" on the dashboard ends it.
- **An admin session isn't a user account.** It grants nothing outside `/admin`; bot linking and the model registry still need a Twitch operator account. It works with `NODE_ENV=production` and `SLOT1_ALLOW_LOCAL_LOGIN=false`.

## Visitor counting (cookieless)

The site layout includes `components/analytics/Beacon.tsx`.

**What it sends:**
- **On every page** (each App Router route change): `POST /api/analytics/collect` with:
  - the path, without query string or hash
  - the referrer's host name, on the first page of a visit only
  - a viewport bucket: under 768 px, under 1100 px, or wider
- **While the tab is visible:** a heartbeat every 30 seconds, `POST /api/analytics/ping`, which keeps "on the site now" current.
- **How it sends:** `navigator.sendBeacon` with a text/plain body, falling back to `fetch` with `keepalive`. It sets no cookie and uses no localStorage or sessionStorage.

**Never counted:**
- Browsers with Do Not Track or Global Privacy Control on. The Beacon checks the navigator flags, and the API checks the `DNT: 1` and `Sec-GPC: 1` headers.
- Automated browsers (`navigator.webdriver`) and known bots, crawlers, link previewers and HTTP libraries, by User-Agent.
- Requests from other websites. The `Origin` must be this site, or `Sec-Fetch-Site` must be `same-origin`.
- `/admin` pages and `/api` paths.

**What is stored per page view** (table `page_views`):

| Field | Content |
|---|---|
| Time | when the view was counted |
| Path | e.g. `/watch/somecreator` |
| Referrer host | e.g. `google.com`, or none |
| Device type | phone, tablet or computer, from the User-Agent's mobile/tablet signal, else the viewport bucket |
| Browser family | Chrome, Safari, Firefox, Edge, Opera, Samsung Internet or other |
| Visitor ID | 16 bytes, see below |

**The visitor ID** is the first 16 bytes of SHA-256(daily salt + IP address + User-Agent + site host).
- The salt is 32 random bytes per UTC day. It lives only in Redis (`slot1:analytics:salt:<day>`) and expires after 48 hours.
- So an ID only means "the same browser on the same day". Yesterday's IDs can't be recomputed, and two days can't be linked.
- The IP address and the full User-Agent are never stored.

**How long it's kept:**
- **Raw page views:** 90 days. The worker's hourly retention sweep first copies daily totals (views, unique visitors) into `analytics_daily`; those totals are kept.
- **"On the site now":** a Redis sorted set of visitor IDs with last-seen times, plus each visitor's current path. Entries expire 5 minutes after the last page view or heartbeat. "Now" means seen in the last 65 seconds. Viewers per live stream are the people on that stream's `/watch/<channel>` page.

**Rate limits:**
- 60 page views and 30 heartbeats per minute per address, with 2 KB bodies.
- The limiter's Redis key is an HMAC of the address, so not even the 1-minute counter holds an IP.
- Behind Caddy, the client address comes from `X-Forwarded-For` (`SLOT1_TRUST_PROXY=true`).

**Unique visitors are per day.** Because IDs change daily, the 7-day and 30-day "visitors" totals add up each day's unique visitors. Someone who visits on three days counts three times; the dashboard says so.

Set `SLOT1_ANALYTICS=false` to stop counting. Nothing is collected, and the dashboard says counting is off.

## Contact form

`/contact` has these fields:

- name (optional)
- email
- topic: general question, privacy or my data, copyright notice, business or partnership, help with SLOT1. Preselect one with `/contact?topic=privacy`.
- message, 10–5000 characters, counted the way people count them (an emoji is one)

A hidden honeypot field catches bots: a message with it filled in gets a normal "sent" answer and is not stored. If `SLOT1_CONTACT_EMAIL` is set, the page also shows that address. It's read when the page is requested, so changing it needs no rebuild.

- **Sending:** `POST /api/contact`, with the usual CSRF token. Each address can send 5 messages per hour. The counter in Redis is keyed by an HMAC of the IP and expires after an hour. The IP is not stored with the message.
- **Storage:** messages are stored in `contact_messages`. Operators read, close, reopen and delete them in `/admin` → Messages.
- **Retention:** the retention sweep deletes messages 24 months after they were sent.

## Settings in the browser

The API can't edit the server's `.env`. When an admin saves a group in `/admin` → Settings, the page first checks every value with the same rules the server uses (`packages/contracts/src/settings.ts` mirrors `setting_ok` in `scripts/server-setup.sh`; `tests/unit/settings.test.ts` runs both on the same values). Then the API leaves one request in the shared state folder: `state/inbox/<id>.settings` on the server, `SLOT1_STATE_DIR/inbox` in the API container. Within a minute, `slot1 tick` checks it again, writes `.env`, answers in `state/outbox/settings-<id>.json` and restarts what reads the settings: only the website for the legal and search-engine fields, otherwise the API, worker, GTA model service and website (about 30 seconds). The page follows the request until the answer arrives.

- What can be changed: the Twitch app (Client ID, Client Secret), the admin Twitch usernames, the chat bot account, the Anthropic key and the AI switch, the legal-page details, the search-engine codes, automatic updates and the admin password. Database passwords, session and encryption secrets and the domain can't be changed that way.
- Secrets (Client Secret, Anthropic key) are write-only: the page only says whether one is saved. The API logs which keys a request changes, never the values, and keeps only "saved" for secrets.
- A new admin password needs the current one, except when none is set yet. The API hashes it (scrypt), so the request holds only the hash. Once applied, every admin session ends.
- A server installed without the setup script has no shared folder; the page then says saving isn't available and the forms are off.

## Endpoints

| Endpoint | Access |
|---|---|
| `POST /api/analytics/collect`, `POST /api/analytics/ping` | the site's own pages (204, counted or not) |
| `POST /api/contact` | anyone, with CSRF; 202 |
| `GET /api/admin/overview?range=7\|30` | operators and admin sessions |
| `GET /api/admin/messages?status=open\|closed\|all&before=&limit=` | operators and admin sessions |
| `PATCH /api/admin/messages/:id` `{status}`, `DELETE /api/admin/messages/:id` | operators and admin sessions, with CSRF |
| `GET /api/admin/login` | anyone: `{passwordSet, signedIn}` for the form |
| `POST /api/admin/login` `{password}` | anyone, with CSRF; the limits above. 200 starts an admin session; 401 wrong password; 409 no password set; 429 limited, with `Retry-After` |
| `GET` and `POST /api/admin/link` | the one-time link page and its button |
| `POST /api/admin/logout` | ends an admin session |
| `GET /api/admin/settings` | operators and admin sessions: current values (secrets only as saved or not), whether saving works here, the last deploy and the server's recent answers |
| `POST /api/admin/settings` `{field: value, …}` | operators and admin sessions, with CSRF; 10 per minute. 200 `{id}`; 422 with `fields` when a value would be refused; 409 when this server can't take settings |
| `GET /api/admin/settings/requests/:id` | operators and admin sessions: `pending`, `applied`, `refused` or `unknown` |
| `POST /api/admin/password` `{current, next}` | operators and admin sessions, with CSRF; 5 per minute; 401 wrong current password |
| `GET /api/admin/deploy-log` | operators and admin sessions: the last 200 lines of the last automatic update |
| `GET /api/admin/signins` | operators and admin sessions: the last 20 "Sign in with Twitch" attempts |
| `GET /api/status` | anyone: what `/status` shows; cached 15 seconds |

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SLOT1_OPERATOR_TWITCH_LOGINS` | empty | Twitch logins that are operators (comma-separated). Checked on every request: after an API restart, adding or removing a login applies to sessions already signed in. |
| `SLOT1_ANALYTICS` | `true` | `false` stops visitor counting |
| `SLOT1_CONTACT_EMAIL` | empty | Public contact address shown on `/contact` (web, read at request time) |
| `SLOT1_VERSION` | empty | Version or commit shown under System. The server script can set it on each update. |
| `SLOT1_ADMIN_PASSWORD_HASH` | empty | scrypt hash of the admin password (`slot1 admin-password`, or `/admin` → Settings). Empty or malformed: no password sign-in. Changing it signs out every admin session. |
| `SLOT1_STATE_DIR` | `/srv/slot1-state` | The server's state folder as the API container sees it (`inbox/` read-write, `outbox/` read-only; docker-compose.yml mounts it). |

## Verified, and not

**Verified:**
- **Integration tests** (`tests/integration/admin.test.ts`, real API, SQL and Redis):
  - no IP, User-Agent or query string stored, and no IP in any Redis key
  - salt rotation and its 48-hour expiry
  - Do Not Track, Global Privacy Control, bots, other sites and `/admin` skipped
  - device, browser and referrer handling
  - 90-day retention with daily totals kept
  - presence and its expiry, and viewers per live stream
  - `/api/admin/*` answers 404 to anonymous visitors and non-operators
  - the admin link: single use, expiry, tampering and cross-site refusal; the CLI in production mode with Secure cookies; an admin session can't reach operator-only routes
  - contact: validation, honeypot, hourly limit, inbox actions, pagination and 24-month retention
- **Settings in the browser** (`tests/unit/settings.test.ts`, `tests/integration/settings.test.ts`, `tests/e2e/admin-settings.spec.ts`):
  - the page's and API's rules give the same answer as the server script's own check on 53 values (run in bash in the C locale like `slot1 tick`, and never more lenient than in a UTF-8 terminal), including `$`, quotes, backslash, `#`, newlines, UTF-8 addresses and byte limits; the same settings can be emptied
  - the request file's exact content and atomic write; 404 for visitors and creators; CSRF; 422 naming the field; secrets never returned; the first password and a change needing the current one; no shared folder means saving is off
  - in a browser at 1440 and 390 px: a refused value caught on the page, a request in the inbox, the server's answer shown, the update log, and `/status`
- **Admin password** (`tests/integration/admin-password.test.ts`, real API, SQL and Redis; `tests/unit/admin-password.test.ts`):
  - the hash format and parameters, verification, Unicode normalization and malformed values; the CLI reading stdin only, its 12-character minimum and its output line
  - right and wrong passwords, the generic answer and its minimum delay, and the session it starts (12 hours, HttpOnly, SameSite=Strict, Secure in production)
  - 5 failures per address, also with parallel requests; the pause for everyone and its backoff; one-time links still working meanwhile
  - CSRF token and `Origin` required, and refused requests not counted
  - no address or password in Redis
  - changing or first setting the password ending all admin sessions; no password or a malformed one
- **End-to-end** (`tests/e2e/admin.spec.ts`, `tests/e2e/admin-password.spec.ts`), at desktop and 390 px:
  - the contact form
  - the password form for non-admins, signing in and out, a wrong password, a link from another site to `/admin` and the "no password set" page
  - the one-time link, using the real CLI
  - the dashboard with a really published test stream and visits counted by the real collector
  - the range switch and keyboard reading of the chart
  - the inbox close and delete

**Not verified:** real traffic volumes (the queries use the `created_at` index and the dashboard caches totals for 30 s), and other browsers' handling of `sendBeacon`.
