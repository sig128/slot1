# Console test checklist (PS5)

SLOT1 installs nothing on a PS5 and never asks a creator to. Viewers watch the console's own Twitch broadcast. SLOT1's chat replies are ordinary Twitch chat messages, sent by the SLOT1 bot account.

What a console does with those messages has **not been verified on real hardware**. Until someone completes this checklist, SLOT1 shows "PS5 chat display: Needs console verification" in Studio → Advanced setup and on the Setup page.

The PS5 menu names below come from PlayStation's support article ["How to stream gameplay with Broadcast on PS5 consoles"](https://www.playstation.com/en-us/support/games/ps5-stream-gameplay-broadcast/), checked on 2026-11-01. Firmware updates may rename them.

## Before you start

- A PS5 linked to the creator's Twitch account.
- A SLOT1 deployment where the creator has connected Twitch and the bot shows **Bot ready** in Studio.
- A second device signed in to Twitch as a different account, to type in chat.

## Steps

1. On the PS5, press the **Create** button, select **Broadcast**, choose Twitch, then **Go Live**.
2. While live, open the broadcast card and turn on **Display Chat** in its overlay options. Note the **Position** you chose. Broadcast settings are under **Settings → Captures and Broadcasts → Broadcasts**.
3. From the second device, type `!slot1 help` in the channel's Twitch chat.
4. Check whether SLOT1's reply appears in the PS5 chat overlay, and roughly how long after it appears on twitch.tv.
5. If **Convert Broadcast Chat to Speech** is on, check whether the reply is read aloud and whether it is understandable. Replies are single lines of at most 500 characters.
6. Type `!slot1 clip`. Wait for the follow-up "Clip ready: …" message, then check that the link opens the right moment.
7. Type `!slot1 now`. Without a video source, the reply must say that gameplay vision isn't connected. It must never describe the game.

## Record the result

| Field | Value |
|---|---|
| Date | |
| PS5 model and system software version | |
| Broadcast resolution / quality setting | |
| Reply visible in the overlay? (yes / no / partly) | |
| Delay vs. twitch.tv (seconds) | |
| Read aloud by Chat to Speech? (yes / no / not tested) | |
| Clip link correct? | |
| Anything unexpected | |

Once the result is recorded, update the "PS5 chat display" line in `apps/web/components/studio/StudioSections.tsx`, the Setup page wording (`apps/web/app/setup/page.tsx`), and [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) to match what you saw.
