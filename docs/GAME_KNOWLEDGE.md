# Everything SLOT1 sees, sorted

Every entry of every live log (what the AI described, what was read on screen, what was said, what SLOT1's own model named) is sorted when it's saved: **what kind of moment** it is and **where** it happened. Across all streams that becomes one searchable, countable picture of the game, which the Learning page shows and "Ask SLOT1 about the game" answers from.

## Activities and places

`packages/contracts/src/game-knowledge.ts` defines:

- **18 categories** (Driving, Vehicles by type, Stunts and tricks, Police and wanted level, Crime, Combat, Weapons, Missions and heists, Money and businesses, Shops and services, Races and activities, People, phone and roleplay, Exploring the world, Around the map, Animals and nature, GTA Online, Glitches and bugs, On stream) with **200 activities** under them. Each activity matches an entry by its words (whole words, game vocabulary) or by its type (`possible_collision` is a crash, `mission_title` is starting a mission, `dialogue` is talking to people).
- **GTA V's places** (districts, landmarks, shops, banks), found in any entry's words, plus every place name read on screen (`place_name` entries, and `landmark` entries with text read on screen, cleaned up into title case). A car's name shows where the area name does when the player gets in; `packages/contracts/src/gta-names.ts` knows GTA V's vehicles and weapons, so that line counts as driving, never as a place.

`knowledgeTags()` turns an entry into tags: `act:<activity>` and `place:<Place Name>`. Matching is conservative: a wrong tag is worse than a missing one. Results are read exactly (WASTED on a result screen is a death, never a mission result), money on the HUD is not "picking up cash", Twitch-side entries (chat, follows) are never tagged, and the most precise place wins ("Vespucci Beach", not also "Vespucci").

`insertObservation` tags every entry it saves (`observations.tags`, GIN-indexed). Entries saved before tagging existed have `tags IS NULL`; the worker tags them in the background at startup, 2,000 at a time (`backfillKnowledgeTags`).

Adding an activity or a place is a change to that one file; entries saved from then on carry it. GTA 6 joins with its own activities and places once real footage exists.

## What counts

Only what anyone could already see: public channels with public analysis, public sessions, never TEST sources, never rejected entries (`packages/db/src/knowledge.ts`).

## The Learning page

`GET /api/learning` adds:

- `activities`: every activity in category order, with how often it was seen, in how many streams, and when last.
- `places`: the 40 places seen most.

The page shows them as "Everything it has seen, sorted" (unseen activities stay listed, dimmed) and "Places on the map". The HUD counts activities seen out of all of them.

## Ask SLOT1 about the game

Asking opens to everyone once SLOT1 has watched `SLOT1_ASK_OPENS_AT_HOURS` hours of public gameplay (1,000 by default), so every answer has real moments behind it. Until then the Learning page shows a counter of the hours watched in place of the question box, and `POST /api/learning/ask` answers 403 `not_open_yet`. Admins (an operator account or an admin session) can ask before that; `GET /api/learning/ask` tells the page which applies to the visitor.

`POST /api/learning/ask { question }` (10 a minute per visitor):

1. The question is matched to activities (`questionActivities`, with broader question words like "guns" for buying weapons) and places (`questionPlaces`).
2. SLOT1 finds the entries about them, then entries whose words match (full-text search), newest first, and computes facts: how often each activity was seen, in how many streams, and the places seen with it ("Buying weapons (Ammu-Nation): seen 12 times in 5 streams. Places seen with it: Ammu-Nation (8), Vinewood (3).").
3. With a text model on (Admin → AI), the model answers in two fields that the page keeps apart: **seen** (only what the entries and facts show, citing entry ids; a "seen" answer that cites no real entry is dropped) and **general** (general GTA knowledge, never presented as seen on stream). At most 500 model answers a day across the site; after that, and without a model, the answer comes from SLOT1's records alone.
4. Every cited entry links to its moment (`/m/<id>`).

The question and every entry's text are treated as untrusted data in the prompt.

## Tests

- `tests/unit/game-knowledge.test.ts`: the activities, places, exact results, noise that must not be tagged, and question matching.
- `tests/integration/game-ask.test.ts`: counts on the Learning page (public streams only), answers from records with moments, the background tagging, and a mock text model whose made-up citations are dropped.

## Missions as stories

`packages/contracts/src/mission-stories.ts` rebuilds every mission attempt of a stream from its entries: from the first objective (or a mission title) to MISSION PASSED or MISSION FAILED. Each attempt keeps:

- its name, only as read on screen: under MISSION PASSED, from a title, or from a retry of the same mission (a failed attempt and the next one sharing an objective)
- how it ended (passed, failed, or no result seen when nothing ended it for 10 minutes), how long it took, the objectives on the way and the last one before it failed
- why it failed, as the result screen said ("Lamar died."), or "Wasted."/"Busted." when that came right before MISSION FAILED
- deaths and busts during it, and the activities and places seen in it

Every WASTED, BUSTED, MISSION FAILED and MISSION PASSED is also kept with the activities seen in the minute before it. One result screen read by several readers (text, SLOT1's model, the AI) counts once.

The worker rebuilds a stream's stories (`mission_attempts`, `story_events`) whenever a mission entry arrives or the stream ends, at most every 2 minutes per stream (`packages/db/src/stories.ts`). Across streams, attempts group by the mission's name, or by their first objective when no name was read.

The Learning page shows every mission (attempts, passed, how long passing takes, where it fails and why) and what leads to each result. "Ask SLOT1 about the game" answers "how do I pass …" and "why do I keep dying" from them, with the result screens as proof.


## Everything it named

Besides the fixed activities, the Learning page lists every name SLOT1 saw, with no fixed list (`namedThings` in `packages/db/src/knowledge.ts`):

- what the AI named in the picture (its `entities`: vehicles, people, items, places, signs, other), except those it was unsure of
- every objective read on screen
- car and weapon names the game showed: whole lines of on-screen text that are exactly a name in `gta-names.ts` (the car's name when the player gets in, a weapon's name on the weapon wheel). Only whole lines count, because many of those names are ordinary words too.

Names group without case or punctuation, are counted across public streams and link to their newest moment. "Ask SLOT1 about the game" answers about a named thing when a question names it.
