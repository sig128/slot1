import { describe, expect, it } from "vitest";
import { CLIP_GUIDE_LIST, CLIP_GUIDES } from "../../apps/web/lib/clip-guides";
import { breadcrumbList, faqPage, graph, jsonLdString, webPage } from "../../apps/web/lib/jsonld";

/** Setting names and server commands never reach visitors (see tests/e2e/onboarding.spec.ts). */
const SERVER_WORDS = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\bslot1 (?:twitch|ai|update|demo|logs)\b|this deployment|README/;
const ORIGIN = "https://slot1.example";

describe("clipping guides (SEO landing pages)", () => {
  it("each has its own title, description and h1, sized for search results", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const g of CLIP_GUIDE_LIST) {
      expect(g.description.length, g.slug).toBeLessThanOrEqual(160);
      expect(g.description.length, g.slug).toBeGreaterThan(110);
      // The layout adds " — SLOT1": titles stay under about 60 characters in results.
      expect(`${g.title} — SLOT1`.length, g.slug).toBeLessThanOrEqual(66);
      expect(g.h1.length, g.slug).toBeGreaterThan(10);
      titles.add(g.title);
      descriptions.add(g.description);
    }
    expect(titles.size).toBe(CLIP_GUIDE_LIST.length);
    expect(descriptions.size).toBe(CLIP_GUIDE_LIST.length);
  });

  it("targets what people search for: TikTok, Shorts and Reels, by console", () => {
    const text = (slug: keyof typeof CLIP_GUIDES) => JSON.stringify(CLIP_GUIDES[slug]);
    for (const slug of ["gta-clips", "ps5", "xbox", "pc"] as const) {
      expect(text(slug)).toMatch(/TikTok/);
      expect(text(slug)).toMatch(/YouTube Shorts/);
      expect(text(slug)).toMatch(/Instagram Reels/);
    }
    expect(CLIP_GUIDES.ps5.title).toMatch(/PS5/);
    expect(text("ps5")).toMatch(/PlayStation App/);
    expect(CLIP_GUIDES.xbox.title).toMatch(/Xbox/);
    expect(text("xbox")).toMatch(/Xbox app/);
    expect(CLIP_GUIDES["gta-6"].title).toMatch(/GTA 6/);
    expect(text("gta-6")).toMatch(/19 November 2026/);
  });

  it("stays honest: no setting names, no claims SLOT1 can't back", () => {
    for (const g of CLIP_GUIDE_LIST) {
      const all = JSON.stringify(g);
      expect(all, g.slug).not.toMatch(SERVER_WORDS);
      // Consoles' own broadcasts never reach SLOT1; nothing is installed on a console.
      expect(all, g.slug).not.toMatch(/only way|install SLOT1 on|SLOT1 app for (PS5|Xbox)/i);
    }
    // GTA VI moments are promised for after release only.
    expect(JSON.stringify(CLIP_GUIDES["gta-6"])).toMatch(/after (release|launch)/);
    expect(JSON.stringify(CLIP_GUIDES.ps5)).toMatch(/Broadcast button only sends to Twitch or YouTube/);
  });

  it("links every guide to the others and has questions for each", () => {
    const paths = new Set(CLIP_GUIDE_LIST.map((g) => g.path));
    for (const g of CLIP_GUIDE_LIST) {
      expect(g.faq.length, g.slug).toBeGreaterThanOrEqual(4);
      expect(new Set(g.faq.map((f) => f.q)).size, g.slug).toBe(g.faq.length);
      for (const r of g.related) expect(paths.has(r.path), `${g.slug} → ${r.path}`).toBe(true);
      expect(g.related.some((r) => r.path === g.path), g.slug).toBe(false);
      expect(g.trail.at(-1)?.path).toBe(g.path);
    }
  });

  it("describes each page to search engines: the page, its breadcrumb and its questions", () => {
    const g = CLIP_GUIDES.ps5;
    const data = graph(webPage(ORIGIN, { path: g.path, name: g.h1, description: g.description, breadcrumb: true }), breadcrumbList(ORIGIN, g.path, g.trail), faqPage(ORIGIN, g.faq, g.path));
    const parsed = JSON.parse(jsonLdString(data)) as { "@graph": Record<string, unknown>[] };
    const [page, crumbs, faq] = parsed["@graph"] as [Record<string, unknown>, { itemListElement: { position: number; name: string; item: string }[] }, { "@id": string; mainEntity: unknown[] }];
    expect(page).toMatchObject({ "@type": "WebPage", url: `${ORIGIN}/gta-clips/ps5`, breadcrumb: { "@id": `${ORIGIN}/gta-clips/ps5#breadcrumb` } });
    expect(crumbs.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "GTA clips", item: `${ORIGIN}/gta-clips` },
      { "@type": "ListItem", position: 3, name: "PS5", item: `${ORIGIN}/gta-clips/ps5` },
    ]);
    expect(faq["@id"]).toBe(`${ORIGIN}/gta-clips/ps5#faq`);
    expect(faq.mainEntity).toHaveLength(g.faq.length);
    // The home page's questions keep their id.
    expect(faqPage(ORIGIN, [{ q: "a", a: "b" }])["@id"]).toBe(`${ORIGIN}/#faq`);
  });
});

describe("clipping guide share cards", () => {
  it("use only characters the card font has (no arrows or middle dots)", () => {
    for (const g of CLIP_GUIDE_LIST) expect(`${g.card.title} ${g.card.line}`, g.slug).toMatch(/^[A-Za-z0-9 ,.:'’!?&()-]+$/);
  });
});
