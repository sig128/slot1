# Everything SLOT1 sees, sorted

Every entry of every live log (what the AI described, what was read on screen, what was said, what SLOT1's own model named) is sorted when it's saved: **what kind of moment** it is and **where** it happened. Across all streams that becomes one searchable, countable picture of the game, which the Learning page shows and "Ask SLOT1 about the game" answers from.

## Activities and places

`packages/contracts/src/game-knowledge.ts` defines:

- **10 categories** (Driving and vehicles, Police and wanted level, Combat, Missions and heists, Money and businesses, Shops and services, Races and activities, People, phone and roleplay, Exploring the world, GTA Online) with **78 activities** under them. Each activity matches an entry by its words (whole words, game vocabulary) or by its type (`possible_collision` is a crash, `mission_title` is starting a mission, `dialogue` is talking to people).
- **GTA V's places** (districts, landmarks, shops, banks), found in any entry's words, plus every place name read on screen (`place_name`, `landmark` entries, cleaned up into title case).

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

`POST /api/learning/ask { question }` (10 a minute per visitor):

1. The question is matched to activities (`questionActivities`, with broader question words like "guns" for buying weapons) and places (`questionPlaces`).
2. SLOT1 finds the entries about them, then entries whose words match (full-text search), newest first, and computes facts: how often each activity was seen, in how many streams, and the places seen with it ("Buying weapons (Ammu-Nation): seen 12 times in 5 streams. Places seen with it: Ammu-Nation (8), Vinewood (3).").
3. With a text model on (Admin → AI), the model answers in two fields that the page keeps apart: **seen** (only what the entries and facts show, citing entry ids; a "seen" answer that cites no real entry is dropped) and **general** (general GTA knowledge, never presented as seen on stream). At most 500 model answers a day across the site; after that, and without a model, the answer comes from SLOT1's records alone.
4. Every cited entry links to its moment (`/m/<id>`).

The question and every entry's text are treated as untrusted data in the prompt.

## Tests

- `tests/unit/game-knowledge.test.ts`: the activities, places, exact results, noise that must not be tagged, and question matching.
- `tests/integration/game-ask.test.ts`: counts on the Learning page (public streams only), answers from records with moments, the background tagging, and a mock text model whose made-up citations are dropped.
