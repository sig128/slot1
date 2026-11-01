# Admin dashboard, visitor counting and the contact inbox

`/admin` is the operator dashboard. It shows:

- **Right now:** people on the site now, by page; live streams and their viewers; health of the worker, ingest gateway, GTA model service and job queues.
- **Visitors:** today, 7 days, 30 days and all time; a daily chart; top pages, referring websites, devices and browsers.
- **Platform:** accounts, creators, the chat bot, video sources, sessions, observations, library, stored files and forwarding.
- **AI:** vision, OCR, speech-to-text and GTA model status, plus provider calls and estimated cost.
- **Messages:** what people sent through `/contact`.
- **System:** version, uptime, database, Redis, free disk, job queues and recent failures.

Every number is counted from the database, Redis or the running services. Where something isn't measured, the page says so. It refreshes every 10 seconds while the tab is visible.

## Who can open it

| Who | How | Can do |
|---|---|---|
| Operators | Sign in with Twitch with a login listed in `SLOT1_OPERATOR_TWITCH_LOGINS` | `/admin`, plus operator tasks elsewhere (linking the bot account, the model registry) |
| Admin-link holders | A one-time link made on the server (below) | `/admin` and `/api/admin/*` only |
| Everyone else, signed in or not | | Nothing. `/admin` and `/api/admin/*` answer with the normal 404, the same as a page that doesn't exist. |

The pages and API answers are `noindex` and never cached.

### One-time admin link

Use it before Twitch sign-in is set up, or whenever you need to get in from a new browser. On the server:

```sh
slot1 admin-link
# which runs, inside the api container:
docker compose exec -T api node dist/admin-link.js
```

It prints a link like `https://<your domain>/api/admin/link?token=…` as its last line.

- **Works once, within 15 minutes.** The token is HMAC-signed with `SLOT1_SESSION_SECRET` and carries a random nonce. The nonce is kept in Redis until the link is used, then deleted atomically, so a second use fails.
- **Opening it shows a button** ("Open the admin") instead of signing in straight away. Chat apps and email scanners that preview links therefore can't use it up.
- **Pressing the button** starts an admin session for 12 hours: a random `slot1_admin` cookie (HttpOnly, SameSite=Lax, Secure in production). Only its SHA-256 hash is kept in Redis. "Sign out" on the dashboard ends it.
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

## Endpoints

| Endpoint | Access |
|---|---|
| `POST /api/analytics/collect`, `POST /api/analytics/ping` | the site's own pages (204, counted or not) |
| `POST /api/contact` | anyone, with CSRF; 202 |
| `GET /api/admin/overview?range=7\|30` | operators and admin sessions |
| `GET /api/admin/messages?status=open\|closed\|all&before=&limit=` | operators and admin sessions |
| `PATCH /api/admin/messages/:id` `{status}`, `DELETE /api/admin/messages/:id` | operators and admin sessions, with CSRF |
| `GET` and `POST /api/admin/link` | the one-time link page and its button |
| `POST /api/admin/logout` | ends an admin session |

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SLOT1_OPERATOR_TWITCH_LOGINS` | empty | Twitch logins that are operators (comma-separated) |
| `SLOT1_ANALYTICS` | `true` | `false` stops visitor counting |
| `SLOT1_CONTACT_EMAIL` | empty | Public contact address shown on `/contact` (web, read at request time) |
| `SLOT1_VERSION` | empty | Version or commit shown under System. The server script can set it on each update. |

## Verified, and not

**Verified:**
- **Integration tests** (`tests/integration/admin.test.ts`, real API, SQL and Redis):
  - no IP, User-Agent or query string stored, and no IP in any Redis key
  - salt rotation and its 48-hour expiry
  - Do Not Track, Global Privacy Control, bots, other sites and `/admin` skipped
  - device, browser and referrer handling
  - 90-day retention with daily totals kept
  - presence and its expiry, and viewers per live stream
  - 404 for anonymous visitors and non-operators
  - the admin link: single use, expiry, tampering and cross-site refusal; the CLI in production mode with Secure cookies; an admin session can't reach operator-only routes
  - contact: validation, honeypot, hourly limit, inbox actions, pagination and 24-month retention
- **End-to-end** (`tests/e2e/admin.spec.ts`), against the dev stack at desktop and 390 px:
  - the contact form
  - the 404 for non-admins
  - the one-time link, using the real CLI
  - the dashboard with a really published test stream and visits counted by the real collector
  - the range switch and keyboard reading of the chart
  - the inbox close and delete

**Not verified:** real traffic volumes (the queries use the `created_at` index and the dashboard caches totals for 30 s), and other browsers' handling of `sendBeacon`.
