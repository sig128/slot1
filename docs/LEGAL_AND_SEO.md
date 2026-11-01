# Legal pages and search (SEO)

## Privacy Policy and Terms of Service

`/privacy` and `/terms` describe what this codebase actually does, for an international audience. They are not tied to one country.

**What they're based on.** The text was written from the code, not from a template:

| Topic | Source in the code |
|---|---|
| Data, cookies and logs | tables and migrations; the `slot1_session` cookie (`apps/api/src/lib/session.ts`); container log rotation (`docker-compose.yml`) |
| Retention | `retention_days` (default 30) and `recording_retention_days` (default 14); rolling buffer 3–15 minutes; hourly retention sweep; sessions expire after 30 days; EventSub deliveries are kept 7 days |
| Chat | ordinary messages are dropped, commands are logged as a hash (`bot_command_audit`) |
| Ask SLOT1 | questions are not stored |
| Visitor statistics | the cookieless analytics design in the admin dashboard work |

The pages say "Last updated: 1 November 2026" (`apps/web/lib/legal.ts`). Change the date whenever either document changes.

**Who runs SLOT1** is read from the server's environment on every request. The pages never take it from the build.

| Variable | Used for | When unset |
|---|---|---|
| `SLOT1_LEGAL_NAME` | The business that operates SLOT1 (the controller), e.g. the registered company name | "SLOT1" |
| `SLOT1_LEGAL_ADDRESS` | Registered address, shown next to the name | omitted |
| `SLOT1_CONTACT_EMAIL` | A public contact address, shown next to the contact form | only the contact form |
| `SLOT1_GOVERNING_LAW` | e.g. `Norway`: "These terms are governed by the laws of Norway" | "the laws of the place where the operator of SLOT1 is established" |

Every contact route points to `/contact?topic=privacy|copyright|support|general`, so the pages work without an email address.

**AI services are listed live.** The Privacy Policy reads the same settings the worker uses: `VISION_PROVIDER` with its key and model, and `TRANSCRIPTION_PROVIDER` with its model. It names the services that are actually switched on (Anthropic, OpenAI, or the speech-to-text host). When none is, it says frames are analyzed only on SLOT1's own server.

**Not legal advice.** These are careful plain-language drafts, not lawyer-reviewed documents. Have them reviewed before relying on them, especially once a business is registered. Things a reviewer should confirm:
- consumer-law wording for the countries you target
- the liability cap
- whether you need an EU/UK representative
- the GPU provider for training, once there is one

## Search engines and share cards

| What | Where |
|---|---|
| Title template, description, Open Graph, Twitter cards, verification tags | `apps/web/lib/site.ts`, `apps/web/lib/meta.ts` (`rootMetadata`, `pageMetadata`) |
| `robots.txt` | `apps/web/app/robots.ts`. Disallows `/admin`, `/studio` and `/api/`, but allows `/api/library/*/poster` (share-card images) and `/api/seo/media/` (video files referenced by structured data). |
| `sitemap.xml` | `apps/web/app/sitemap.ts`. Lists static public pages, plus On Air channels, public creator profiles and public library items from `GET /api/seo/sitemap`. Videos get video-sitemap entries, screenshots image entries. |
| Web app manifest | `apps/web/app/manifest.ts`, with the icon from `apps/web/app/apple-icon.tsx` |
| Share images | `apps/web/app/opengraph-image.tsx` and `twitter-image.tsx` (site card), `apps/web/app/watch/[channel]/opengraph-image.tsx` (channel card, with Twitch's live thumbnail when live). Fonts are WOFF copies of the OFL fonts in `apps/web/public/fonts/og/`. |
| Structured data (JSON-LD) | `apps/web/lib/jsonld.ts`. Home page: Organization, WebSite, WebApplication, FAQPage (the visible FAQ, word for word). `/v/[id]`: VideoObject for public videos. `/watch/[channel]`: VideoObject with a live BroadcastEvent while a connected public channel is live. |
| Landing content | `apps/web/components/home/HomeLanding.tsx`, copy in `apps/web/lib/home-content.ts` |

**What gets indexed.** Only what an anonymous visitor may already open:
- Public creator profiles and public items, from public channels.
- Watch pages of SLOT1-connected public channels.
- `noindex`: watch pages of other Twitch channels (watch-only), unlisted items, private previews, `/m/` links, `/studio`, `/admin` and `/demo`.
- The sitemap lists only Twitch-connected creators. Local development accounts and SLOT1's demo channel never appear.

**Origin at runtime.** The production image is built without `.env`, so:
- every page is rendered per request (`dynamic = "force-dynamic"` in the root layout);
- `metadataBase`, canonical URLs, `robots.txt` and the sitemap use `SLOT1_PUBLIC_ORIGIN` from the running server.

**Verification tags** (optional, read at request time):
- `SLOT1_GOOGLE_SITE_VERIFICATION`: the `content` value Google Search Console gives you.
- `SLOT1_BING_SITE_VERIFICATION`: the `msvalidate.01` value from Bing Webmaster Tools.

Once the site is live on its final domain, submit `https://<domain>/sitemap.xml` in both consoles.

## What was verified

| Area | Test |
|---|---|
| JSON-LD escaping and builders, durations, metadata helpers, indexing rules, legal settings, live AI-service listing, home copy (no overclaiming) | `tests/unit/seo.test.ts` |
| Sitemap listing on real SQL, and the stable media redirect (public videos only, followed to the real file) | `tests/integration/seo.test.ts` |
| Pages in Chromium at desktop and 390 px | `tests/e2e/legal-seo.spec.ts` |

The sitemap test covers:
- what is listed: On Air channels only, public creators, public items;
- what is never listed: private channels, private, unlisted and unfinished items, local accounts, disconnected channels;
- that privacy changes are respected.

The e2e test checks:
- privacy, terms and home with its JSON-LD, with no console errors and no sideways scrolling;
- `robots.txt` and `sitemap.xml`.

**Not verified:** real search-engine crawling and indexing, rich-result eligibility in Google's tools, and share cards on each social network.
