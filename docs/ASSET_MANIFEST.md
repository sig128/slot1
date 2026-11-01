# Asset manifest

Everything visual or audible that ships with SLOT1, where it comes from, and its license. SLOT1 ships no Rockstar Games, Take-Two, Sony or Twitch artwork, logos, screenshots, footage, music or fonts.

## Fonts (bundled with the web app)

| Asset | Use | Source | License |
|---|---|---|---|
| Barlow Condensed 500, 600, 800, 900 by Jeremy Tribby | Display type: wordmark, headings, tabs, status chips | npm `@fontsource/barlow-condensed` 5.3.0 (self-hosted, no third-party font CDN) | SIL Open Font License 1.1 |
| Inter (variable) by Rasmus Andersson | Body text, data, forms | npm `@fontsource-variable/inter` 5.3.0 (self-hosted) | SIL Open Font License 1.1 |
| Passion One 700, 900 by Fontstage | Poster titles, wordmark, in-game-style moment banners | Files from npm `@fontsource/passion-one` 5.3.0, vendored in `apps/web/public/fonts/passion-one/` with `OFL.txt` | SIL Open Font License 1.1 |
| Share-image fonts: Passion One 900, Barlow Condensed 600 and 800 (WOFF) | Open Graph cards and the home-screen icon, drawn on the server (`apps/web/lib/og.tsx`) | `apps/web/public/fonts/og/`: Passion One converted from `packages/analysis/fonts/PassionOne-Black.ttf` to WOFF without changes (fontTools), Barlow from npm `@fontsource/barlow-condensed`; licenses alongside | SIL Open Font License 1.1 |

Considered and **not** shipped:

- **Pricedown** (the typeface associated with GTA titles) is not served as a webfont. Its free license covers desktop use only and excludes embedding in websites, so live text uses Passion One until a MyFonts Webfont license is bought.
- **Bebas Neue** was evaluated, but nothing uses it, so it was removed from the dependencies.
- **Pricedown** may appear only as finished images (logo, fixed titles) made from the free desktop version, which its license allows for logos and static graphics. The font file itself is never committed or served. Using it as live web text requires the paid MyFonts Webfont license.

## Original artwork (made for SLOT1, in code)

| Asset | File | Notes |
|---|---|---|
| SLOT1 wordmark | `apps/web/components/brand/Wordmark.tsx` | "SLOT" set in Barlow Condensed Black; the "1" sits in a sunset-gradient badge like a channel-number bug. It plays once per browser session and never under reduced motion. |
| Skyline art and the home intro | `apps/web/components/brand/SkylineArt.tsx`, `skyline-geometry.ts`, `skyline.css`; `apps/web/components/home/IntroHud.tsx`, `IntroTips.tsx`, `intro.css` | Inline SVG and CSS drawn for SLOT1: a golden-hour bay city in a loading-screen style with ink outlines, flat shading and halftone dots. It includes a hillside sign spelling SLOT1, palms, a freeway with light trails, a coupe and a helicopter, plus a HUD (radar, stars, counter) that shows real live-channel data. Not traced from any game, photo, cover or loading screen. It uses no Rockstar artwork, logos, characters or fonts (the title uses Passion One, OFL). |
| Share cards (Open Graph / X) | `apps/web/public/og/scene-1200x630.png`; `apps/web/app/opengraph-image.tsx`, `apps/web/app/watch/[channel]/opengraph-image.tsx`, `apps/web/lib/og.tsx` | The PNG is a still of the skyline artwork above: a static render of `SkylineArt` at 1200 × 630, palette-compressed, with no text. The cards draw the gold title card, tagline and the site's host name (read from `SLOT1_PUBLIC_ORIGIN` on each request) on top of it. Live channel cards add Twitch's own live thumbnail, fetched from Twitch's CDN when the card is requested. Same origin and licence as the artwork. |
| App icon | `apps/web/app/icon.svg` | Gradient "1" badge matching the wordmark |
| Color palette | `apps/web/app/globals.css` (`@theme`) | Graphite, ivory, apricot, coral and signal tokens chosen for this project |

## Studio library (sounds, music, ambience and visual elements)

The clip editor's built-in library lives in `packages/analysis/studio-assets/`. The API and worker builds copy it to `dist/studio-assets` (`tsup.config.ts`), and `resolveStudioAsset` in `packages/analysis/src/studio-assets.ts` finds it there. Every item was generated from code for SLOT1 by `scripts/make-studio-assets.py`: audio is synthesized with numpy and scipy, and graphics are drawn as SVG and rasterized with librsvg. It uses no samples, recordings, stock packs, loops from elsewhere, or traced artwork. Text on stickers is set in the OFL fonts above (Passion One, Barlow Condensed) in SLOT1's own colors. Words such as "Wasted" or "Mission complete" are plain words; no game's lettering, logo or layout is reproduced.

Every item's license, recorded in the manifest's `license` field, is **Original (SLOT1)**.

| Family (kind) | Count | Files | How it's made |
|---|---|---|---|
| Sound effects (`sfx`) | 138 in 15 categories: camera, cash, comedy, drops, engines, explosions, glitches, impacts, phone, record, risers, sirens, stingers, UI, whooshes | `sfx/<category>/<name>.m4a` | Band-limited saw and square, FM, inharmonic partials, shaped noise, filters, envelopes and a synthetic-impulse reverb (`scripts/studio_assets/sfx.py`). Each is normalized so its loudest 400 ms reads −16 LUFS, with peaks at or below −1 dBTP. 0.03 to 5 s long. |
| Music loops (`music`) | 14 in 6 genres: synthwave, drive, trap, lo-fi, funk, cinematic. 76 to 150 BPM | `music/<genre>/<name>.m4a` | Drums, bass, chords and leads sequenced and synthesized in code (`music.py`). Each is mastered as one buffer and cut to a whole number of bars, so the end runs into the start. −16 LUFS integrated, 11 to 21 s long. |
| Ambience (`ambience`) | 8: city at night, rain, wind, neon hum, crowd murmur, ocean waves, club through the wall, highway | `ambience/<name>.m4a` | Filtered noise, hums and generated events such as passing cars and horns (`ambience.py`). The tail is crossfaded into the start so they loop. −24 LUFS, so a bed sits under everything at full volume. 16 to 24 s long. |
| Stickers (`sticker`) | 69 in 7 categories: annotate, badge, countdown, HUD, mission, phone, reaction | `elements/stickers/<category>/<name>.png` | Flat-ink SVG with ink outlines, hard offset shadows and the site palette (`visuals.py`). Transparent PNGs, trimmed to the artwork. |
| Overlays (`overlay`) | 16: textures (film grain, scanlines, VHS noise, halftone, dust, CRT), light (light leaks, vignettes, color wash), weather (rain) | `elements/overlays/<category>/<name>.png` | Full-frame 16:9 transparent PNGs. Film grain is gray plus alpha. |
| Frames (`frame`) | 10: comic panel, corner brackets, CRT TV, film strip, HUD corners, neon borders, phone screen, instant photo, VHS camcorder | `elements/frames/<name>.png` | Full-frame borders with a transparent middle: 16:9, or 9:16 for the vertical phone screen. |
| Transitions (`transition`) | 10: glitch slabs, gold flash, halftone wipe, ink swipe, neon streak, paper tear, smoke wipe, speed lines, star burst, white flash | `elements/transitions/<name>.png` | One full-frame graphic each. Its `motion:` tag (`fade`, `slide-left`, `slide-right`, `zoom` or `shake`) says how the editor moves it over `durationMs` (600). |

All audio is AAC-LC in MP4 (`.m4a`) at 48 kHz, which every browser and ffmpeg play. Effects use 56 kb/s mono or 80 kb/s stereo, music 112 kb/s stereo and ambience 64 kb/s stereo. Graphics are palette PNGs where the art is flat. The library totals about 10.5 MB (audio about 6.9 MB). `tests/unit/studio-assets.test.ts` holds it to its budget (audio under 8 MB, everything under 14 MB), validates the manifest and checks that every file exists.

**Regenerating.** Run `python3 scripts/make-studio-assets.py` from the repository root to rebuild everything, or add `--only sfx|music|ambience|elements` for one family. It needs Python 3.11+ with numpy, scipy, Pillow, fontTools and brotli, plus ffmpeg (native AAC encoder) and `rsvg-convert`. The output is deterministic, and the generated files are committed. It rewrites `manifest.json`, which follows the `StudioAssetManifest` contract in `packages/contracts/src/studio-assets.ts`, and `waveforms.json`, which holds 48 preview peaks (0 to 1) per audio item.

**Serving.** Both routes are for creators only:

- `GET /api/studio/assets` returns the manifest plus `rev` (it changes whenever the library changes) and `peaks` (the `StudioAssetsResponse` contract), with an ETag and a five-minute private cache.
- `GET /api/studio/assets/file/<id>?v=<rev>` serves one file with Range support. When `v` matches the current `rev` it is cached for a year as immutable. The manifest's `file` path also works in place of the id. Anything that isn't a manifest item is a 404, so nothing outside the library can be reached.

In the browser, `apps/web/components/clipper/library/studio-assets-client.ts` loads the manifest once per page and builds file URLs. The editor's library panel (`AssetLibraryPanel`) drags an item as `application/x-slot1-asset`, with the item's JSON as the payload; `isAssetDrag` and `readAssetDrag` read it on the timeline. Favorites are remembered per browser.

**How the AI picks library items.** The clip AI works only from the catalog and refers to items only by `id`; it never invents an id or a file path.

1. Build the catalog with `studioAssetCatalog(kinds?)` from `@slot1/analysis`, which gives `id`, `kind`, `category`, `name`, `tags`, `durationMs` and `loop`. Narrow it to what the request is about (the clip AI's `libraryCatalogue` ranks by tags, then category, then name).
2. Choose the kind from the job. Accents and hits on a moment are `sfx`: impacts, whooshes, stingers, cash, sirens. Music under a whole clip is `music`; a bed is `ambience`. Something on screen is a `sticker`, `overlay` or `frame`. A cut between segments is a `transition`.
3. Match `tags` and `category` to the moment. For example, a chase takes `sirens`, `engines` or `drive` music; a payout takes `cash`; a fail takes a fail stinger with a "Wasted" or "Mission failed" banner sticker. Prefer items whose `durationMs` fits the gap.
4. Place an item in the edit as `{ kind: "library", assetId: <id> }`. The worker resolves it with `resolveStudioAsset` when it renders.
5. Levels are already matched, so keep effects near volume 1. Duck music under speech, and leave ambience at 1.

**Looping in a render.** To repeat a music or ambience loop, cut each copy to `durationMs` and join the copies with a ~15 ms equal-power crossfade (ffmpeg `acrossfade=d=0.015:c1=qsin:c2=qsin`). The PCM is periodic, but AAC adds a few milliseconds of padding and edge ringing at each end of the file. Trimming to `durationMs` and the short crossfade hide both.

## Test and fixture media

| Asset | How it's made | Notes |
|---|---|---|
| `tests/fixtures/generated/sample-replay.mp4` | `scripts/make-sample-video.sh`, using ffmpeg's built-in generators (`testsrc2`, `testsrc`, `smptehdbars`, solid black, sine tones, silence) and `drawtext` | Synthetic. It contains no game footage. The overlaid strings are typed text written to exercise OCR. They include place and character names such as "Vespucci Beach" and "Lamar" because they resemble GTA subtitles; they are words, not assets. The file is generated locally and git-ignored. |
| Live demo stream | `apps/worker/src/demo/scene.ts`, `broadcast.ts` | Generated live by ffmpeg's built-in sources and `drawtext` with the OFL fonts in `packages/analysis/fonts`. It is a synthetic GTA-style HUD scene with typed mission titles, subtitles, result screens and a money counter, plus a generated tone bed. It contains no game footage or music, and every page that shows it labels it as a demo with a synthetic test video. See [DEMO.md](DEMO.md). |
| E2E screenshots | `tests/e2e/screenshots/{desktop,laptop,narrow}/` | Captured by Playwright from this app running on the synthetic sample |

## System fonts used at runtime (not bundled)

Clip captions and the sample video's overlay text use the first font found among Inter Bold, DejaVu Sans Bold or Arial Bold on the host (`DEFAULT_CAPTION_FONTS` in `packages/analysis/src/media.ts`). The Docker images install `fonts-dejavu-core` (DejaVu fonts license, permissive).

## Third-party embeds

Twitch's player, clip and chat are embedded only through Twitch's official embed URLs (`player.twitch.tv`, `clips.twitch.tv`, `www.twitch.tv/embed/…/chat`). SLOT1 never re-hosts, re-encodes or reads pixels from them.
