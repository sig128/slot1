# Twitch scopes, endpoints and EventSub

SLOT1 asks each account only for what a feature needs. The source of truth is `packages/twitch/src/oauth.ts` (`SCOPES`) and `requiredSubscriptions()` in `packages/twitch/src/eventsub.ts`.

## Accounts and scopes

| Account | Scope | Why | Requested |
|---|---|---|---|
| Creator (broadcaster) | `channel:bot` | Lets the SLOT1 bot account read and post in this channel's chat, using EventSub chat and the app access token | Always, on Connect my Twitch |
| Creator | `clips:edit` | Create a live clip when the creator, or chat users they permit, ask for one | Always, on Connect my Twitch |
| Creator | `channel:manage:clips` | Download the creator's clips for analysis (Get Clips Download) and clip a past moment of a broadcast (Create Clip From VOD) | Only when the creator chooses **Grant clip analysis permission** |
| Creator | `channel:read:stream_key` | Read the creator's Twitch stream key (Get Stream Key) so SLOT1 can forward the stream it receives from OBS to their Twitch channel. Stored encrypted, never shown or logged. See [RELAY.md](RELAY.md). | Only when the creator chooses **Let SLOT1 forward to Twitch** in Studio → Stream setup |
| SLOT1 bot account | `user:read:chat` | Receive chat messages as the bot | When the operator links the bot |
| SLOT1 bot account | `user:write:chat` | Send chat messages as the bot | When the operator links the bot |
| SLOT1 bot account | `user:bot` | Appear as a chat bot (required to chat with an app access token) | When the operator links the bot |
| App (client credentials) | — | EventSub subscription management and sending chat | Automatically |

The bot account is a single dedicated Twitch account per deployment, named by `SLOT1_BOT_TWITCH_LOGIN`.

- Only an operator listed in `SLOT1_OPERATOR_TWITCH_LOGINS` can link it.
- Linking forces Twitch's account chooser.
- Any other account is refused.

Pasting someone else's channel URL never requests anything. It opens a watch-only page.

Twitch replaces a user's granted scopes with whatever the latest authorization asked for. So every creator reconnect asks again for the optional scopes the creator already granted (`channel:manage:clips`, `channel:read:stream_key`) on top of the base ones; a plain reconnect never silently drops forwarding or clip analysis.

## OAuth endpoints (id.twitch.tv)

| Endpoint | Use |
|---|---|
| `GET /oauth2/authorize` | Authorization-code flow. The `state` is random, single-use, expires, and is bound to the browser session that started the flow. |
| `POST /oauth2/token` | Authorization-code exchange with the exact redirect URI, refresh, and client credentials. |
| `GET /oauth2/validate` | Every stored token at worker start and every hour. On 401 the token is refreshed; if refreshing fails, the grant is marked revoked and dependent features switch off. |
| `POST /oauth2/revoke` | Access and refresh tokens when a creator disconnects. |

Tokens are stored only encrypted with AES-256-GCM (`SLOT1_TOKEN_ENCRYPTION_KEYS`, key ring with rotation) and are never sent to the browser.

## Helix endpoints (api.twitch.tv/helix)

| Endpoint | Token | Use |
|---|---|---|
| `GET /users` | user or app | Creator identity after sign-in; channel lookups |
| `GET /streams`, `GET /channels` | app | Live state, title and category: polled every minute for listed channels, and cached when a watch page loads |
| `POST /clips` | creator (`clips:edit`) | Create a live clip |
| `GET /clips` | creator | Confirm the clip exists before posting a link. Twitch's guidance is to treat creation as failed if the clip isn't returned within 15 s. |
| `GET /clips/downloads` | creator (`channel:manage:clips`) | Download URLs for clip analysis. Only hosts on the Twitch CDN allowlist are fetched. |
| `POST /videos/clips` | creator (`channel:manage:clips`) | Create Clip From VOD for an authorized past moment |
| `GET /streams/key` | creator (`channel:read:stream_key`) | Get Stream Key, fetched each time forwarding to Twitch starts (so a key reset at Twitch is picked up) and cached encrypted as a fallback for Twitch outages. A 401/403 sets the destination to "needs permission" instead of guessing. |
| `POST /chat/messages` | app (bot as sender) | Bot replies and notices |
| `POST/GET/DELETE /eventsub/subscriptions` | app | Keep exactly the needed subscriptions per channel |

A 401 triggers one refresh and one retry. A 429 waits for `Ratelimit-Reset` once, only if that is within 5 s; otherwise it is reported as rate limited.

## EventSub subscriptions (webhook transport)

| Type | Version | Condition | Why |
|---|---|---|---|
| `stream.online` | 1 | `broadcaster_user_id` | Start a Twitch broadcast session ("Live on Twitch") |
| `stream.offline` | 1 | `broadcaster_user_id` | End it |
| `channel.update` | 2 | `broadcaster_user_id` | Title and category |
| `channel.chat.message` | 1 | `broadcaster_user_id`, `user_id` = bot | Chat commands, only when the creator turned the bot on |

Webhook handling:

- Deliveries are verified with HMAC-SHA256 over message id + timestamp + raw body, compared in constant time.
- Messages older than 10 minutes, or more than 2 minutes in the future, are rejected.
- Message ids are de-duplicated in `eventsub_deliveries`.
- Verification challenges get the raw challenge as `text/plain`.
- Revocations trigger a reconcile.
- Ordinary chat (anything not starting with `!`) is acknowledged and dropped without being stored.

Webhooks need a public **HTTPS URL on port 443** (`TWITCH_EVENTSUB_CALLBACK_URL`); see the README for tunnels in development.
