# Kick on SLOT1

Kick works alongside Twitch: Kick channels can be featured on the home page, watched with Kick's player and Kick chat, and creators and viewers can sign in with a Kick account.

Everything here uses Kick's official public API ([docs.kick.com](https://docs.kick.com), source in `KickEngineering/KickDevDocs`). It needs one Kick developer app, saved in **Admin → Settings → Kick app**:

| Kick app setting (kick.com → Settings → Developer) | Value |
| --- | --- |
| Client ID, Client Secret | Saved in Admin → Settings → Kick app (`KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`) |
| Redirect URL | `https://<your domain>/api/auth/kick/callback`, exactly. Admin → Settings → Kick app shows it with a Copy button |

Without the app, Kick channels still play (Kick's own player and chat) and their live state is shown as unknown, never guessed; "Sign in with Kick" says it isn't open yet.

## Sign in with Kick

`GET /api/auth/kick/start?role=broadcaster|viewer&returnTo=/path` starts OAuth 2.1 with PKCE (S256) on `id.kick.com`. The state is bound to the browser session and to Kick (a Twitch callback can't finish it), and the PKCE verifier is kept encrypted with the state for at most 10 minutes.

| Who | Scopes | What SLOT1 does |
| --- | --- | --- |
| Creator (`broadcaster`) | `user:read channel:read` | Creates or finds the SLOT1 account (`users.kind = 'kick'`) and the channel (`broadcasters.kind = 'kick'`, login `kick-<slug>`), then opens Studio's guided OBS setup |
| Viewer (`viewer`) | `user:read` | Creates or finds the SLOT1 account, to chat in SLOT1 chat. No channel |

Kick's token is used once (`GET /public/v1/users`, and `GET /public/v1/channels` for creators), then revoked. Kick also returns the account's email; SLOT1 doesn't store it. The result comes back as `?kick=connected | signed_in | denied | error&why=<code>` (`not_configured`, `expired`, `code`, `app`, `kick_down`, `no_channel`, `server`), which the page explains.

A Kick account is its own SLOT1 account: signing in with Twitch and with Kick gives two accounts.

## What a Kick creator gets

- **Studio**: the same stream setup (OBS in one click, the stream key, hide-your-camera, forwarding). To keep Kick viewers, add Kick under "Choose where it goes" with the Stream URL and Key from the Kick creator dashboard; SLOT1 forwards the stream unchanged.
- **Watch page** (`/watch/kick-<slug>`): SLOT1's own video while the creator streams to SLOT1 (Kick's player otherwise), Kick chat and SLOT1 chat side by side, the live log, Ask SLOT1. It can be made public and listed on On Air.
- **Not on Kick yet**: the SLOT1 bot posting in Kick chat (it answers `!slot1` in SLOT1 chat), and Twitch's clip tools (Clipper makes clips from SLOT1's own recording instead).

## Kick chat in the Chat tab

Kick has no official chat embed. The Chat tab frames Kick's own chat page, `https://kick.com/popout/<slug>/chat` (allowed in `frame-src`), with a link to open it in a new window in case Kick stops allowing the frame.
