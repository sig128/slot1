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
| Skyline art | `apps/web/components/brand/SkylineArt.tsx` | Inline SVG: generic night skyline, palms, a low sun and light on the water. Simple geometric shapes, not traced from any game or photo. |
| App icon | `apps/web/app/icon.svg` | Gradient "1" badge matching the wordmark |
| Color palette | `apps/web/app/globals.css` (`@theme`) | Graphite, ivory, apricot, coral and signal tokens chosen for this project |

## Test and fixture media

| Asset | How it's made | Notes |
|---|---|---|
| `tests/fixtures/generated/sample-replay.mp4` | `scripts/make-sample-video.sh`, using ffmpeg's built-in generators (`testsrc2`, `testsrc`, `smptehdbars`, solid black, sine tones, silence) and `drawtext` | Synthetic. It contains no game footage. The overlaid strings are typed text written to exercise OCR. They include place and character names such as "Vespucci Beach" and "Lamar" because they resemble GTA subtitles; they are words, not assets. The file is generated locally and git-ignored. |
| `/demo` fixtures | `apps/web/lib/fixtures.ts` | Invented observations, clearly labeled "DEMO … Fixture data for design review" on the page. They are never mixed into real sessions. |
| E2E screenshots | `tests/e2e/screenshots/{desktop,laptop,narrow}/` | Captured by Playwright from this app running on the synthetic sample |

## System fonts used at runtime (not bundled)

Clip captions and the sample video's overlay text use the first font found among Inter Bold, DejaVu Sans Bold or Arial Bold on the host (`DEFAULT_CAPTION_FONTS` in `packages/analysis/src/media.ts`). The Docker images install `fonts-dejavu-core` (DejaVu fonts license, permissive).

## Third-party embeds

Twitch's player, clip and chat are embedded only through Twitch's official embed URLs (`player.twitch.tv`, `clips.twitch.tv`, `www.twitch.tv/embed/…/chat`). SLOT1 never re-hosts, re-encodes or reads pixels from them.
