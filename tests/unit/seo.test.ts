import { describe, expect, it } from "vitest";
import { FAQ, FEATURES, STEPS } from "../../apps/web/lib/home-content";
import { clipVideo, faqPage, graph, isoDuration, jsonLdString, liveBroadcast, organization, webApplication, website } from "../../apps/web/lib/jsonld";
import { aiProcessors, legalConfig } from "../../apps/web/lib/legal";
import { clampDescription, pageMetadata, SITE, verificationToken, watchMetadata } from "../../apps/web/lib/meta";

const ORIGIN = "https://slot1.example";

describe("structured data", () => {
  it("can't be broken out of its <script> element by user text", () => {
    const s = jsonLdString({ name: '</script><script>alert(1)</script> & "x"' });
    expect(s).not.toContain("</script>");
    expect(s).not.toContain("<");
    expect(JSON.parse(s)).toEqual({ name: '</script><script>alert(1)</script> & "x"' });
  });

  it("writes ISO 8601 durations", () => {
    expect(isoDuration(83_000)).toBe("PT1M23S");
    expect(isoDuration(3_600_000)).toBe("PT1H");
    expect(isoDuration(3_661_000)).toBe("PT1H1M1S");
    expect(isoDuration(400)).toBe("PT1S");
    expect(isoDuration(60_000)).toBe("PT1M");
  });

  it("describes the site as one graph with absolute URLs", () => {
    const g = graph(organization(ORIGIN, "SLOT1"), website(ORIGIN, SITE.description), webApplication(ORIGIN, SITE.description), faqPage(ORIGIN, FAQ)) as {
      "@context": string;
      "@graph": Record<string, unknown>[];
    };
    expect(g["@context"]).toBe("https://schema.org");
    expect(g["@graph"].map((n) => n["@type"])).toEqual(["Organization", "WebSite", "WebApplication", "FAQPage"]);
    expect(g["@graph"][0]).toMatchObject({ url: `${ORIGIN}/`, logo: { url: `${ORIGIN}/icon.svg` } });
    expect(g["@graph"][0]).not.toHaveProperty("legalName");
    expect(organization(ORIGIN, "Example Media AS")).toMatchObject({ legalName: "Example Media AS" });
    expect(g["@graph"][2]).toMatchObject({ isAccessibleForFree: true, offers: { price: "0" } });
  });

  it("puts exactly the visible FAQ into FAQPage", () => {
    const f = faqPage(ORIGIN, FAQ) as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(f.mainEntity).toHaveLength(FAQ.length);
    FAQ.forEach((item, i) => {
      expect(f.mainEntity[i]!.name).toBe(item.q);
      expect(f.mainEntity[i]!.acceptedAnswer.text).toBe(item.a);
    });
  });

  it("describes a public clip with stable URLs only", () => {
    const v = clipVideo({
      origin: ORIGIN,
      id: "11111111-1111-4111-8111-111111111111",
      title: "Docks run",
      description: "A clip by Someone on SLOT1.",
      createdAt: "2026-10-01T12:00:00.000Z",
      durationMs: 42_000,
      posterUrl: `${ORIGIN}/api/library/x/poster`,
      channel: { login: "someone", displayName: "Someone" },
      contentPath: "/api/seo/media/11111111-1111-4111-8111-111111111111",
    });
    expect(v).toMatchObject({
      "@type": "VideoObject",
      duration: "PT42S",
      contentUrl: `${ORIGIN}/api/seo/media/11111111-1111-4111-8111-111111111111`,
      url: `${ORIGIN}/v/11111111-1111-4111-8111-111111111111`,
      thumbnailUrl: [`${ORIGIN}/api/library/x/poster`],
    });
    expect(JSON.stringify(v)).not.toMatch(/sig=|token=|expires/i);
  });

  it("marks a live broadcast with a BroadcastEvent and Twitch's embed", () => {
    const l = liveBroadcast({
      origin: ORIGIN,
      login: "someone",
      displayName: "Someone",
      title: "Heist night",
      category: "Grand Theft Auto V",
      startedAt: "2026-11-01T18:00:00.000Z",
      thumbnailUrl: null,
      embedParent: "slot1.example",
    }) as { publication: { isLiveBroadcast: boolean }; embedUrl: string; name: string };
    expect(l.publication.isLiveBroadcast).toBe(true);
    expect(l.embedUrl).toBe("https://player.twitch.tv/?channel=someone&parent=slot1.example");
    expect(l.name).toBe("Someone: Heist night");
  });
});

describe("page metadata", () => {
  it("keeps descriptions to what search results show, at a word boundary", () => {
    const long = "word ".repeat(80);
    const d = clampDescription(long);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.endsWith("…")).toBe(true);
    expect(clampDescription("short")).toBe("short");
    expect(SITE.description.length).toBeLessThanOrEqual(160);
    expect(SITE.title.length).toBeLessThanOrEqual(60);
  });

  it("sets canonical, complete share cards and a default image", () => {
    const m = pageMetadata({ title: "Privacy Policy", description: "What SLOT1 collects.", path: "/privacy" });
    expect(m.alternates?.canonical).toBe("/privacy");
    expect(m.openGraph).toMatchObject({ url: "/privacy", siteName: "SLOT1", title: "Privacy Policy — SLOT1", images: [{ url: "/opengraph-image" }] });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", images: [{ url: "/opengraph-image" }] });
    expect(m.robots).toBeUndefined();
    expect(pageMetadata({ title: "x", description: "y", path: "/x", noindex: true }).robots).toEqual({ index: false, follow: true });
    expect(pageMetadata({ title: SITE.title, absolute: true, description: "y", path: "/" }).title).toEqual({ absolute: SITE.title });
  });

  it("indexes only SLOT1-connected public channels", () => {
    const channel = (login: string, state = "live") => ({
      login,
      displayName: login,
      broadcast: { state, title: "Heist night", category: "Grand Theft Auto V" },
    });
    const live = watchMetadata({ authorized: true, channel: channel("someone") });
    expect(live.robots).toBeUndefined();
    // Each channel shares its own card; watch-only pages too (it shows only public facts).
    expect(live.openGraph.images[0]).toMatchObject({ url: "/watch/someone/opengraph-image", width: 1200, height: 630 });
    expect(watchMetadata({ authorized: false, channel: channel("someone_else") }).twitter.images[0]!.url).toBe("/watch/someone_else/opengraph-image");
    expect(live.title).toBe("someone is live");
    expect(String(live.description)).toContain("Heist night");
    expect(watchMetadata({ authorized: true, channel: channel("someone", "offline") }).title).toBe("Watch someone");
    // A pasted link to any other Twitch channel, and SLOT1's own demo channel, stay out of search.
    expect(watchMetadata({ authorized: false, channel: channel("someone_else") }).robots).toEqual({ index: false, follow: true });
    expect(watchMetadata({ authorized: true, channel: channel("slot1-demo") }).robots).toEqual({ index: false, follow: true });
  });

  it("accepts only plain search-engine verification tokens", () => {
    expect(verificationToken(" abcDEF123_-xyz ")).toBe("abcDEF123_-xyz");
    expect(verificationToken('abc" onload="x')).toBeUndefined();
    expect(verificationToken("")).toBeUndefined();
    expect(verificationToken(undefined)).toBeUndefined();
  });
});

describe("legal settings", () => {
  it("reads well with nothing configured", () => {
    expect(legalConfig({})).toEqual({ name: "SLOT1", nameIsDefault: true, address: null, email: null, governingLaw: null });
  });

  it("uses the operator's details and rejects malformed ones", () => {
    const c = legalConfig({
      SLOT1_LEGAL_NAME: "  Example Media AS ",
      SLOT1_LEGAL_ADDRESS: "Street 1,\n0150 Oslo",
      SLOT1_CONTACT_EMAIL: "Hello@Example.com",
      SLOT1_GOVERNING_LAW: "Norway",
    });
    expect(c).toEqual({ name: "Example Media AS", nameIsDefault: false, address: "Street 1, 0150 Oslo", email: "hello@example.com", governingLaw: "Norway" });
    expect(legalConfig({ SLOT1_CONTACT_EMAIL: "not an email" }).email).toBeNull();
    expect(legalConfig({ SLOT1_LEGAL_NAME: "<script>x</script>" }).name).not.toContain("<");
  });

  it("lists only the AI services that are actually switched on", () => {
    expect(aiProcessors({ VISION_PROVIDER: "none" })).toEqual([]);
    // A provider without its key or model sends nothing anywhere.
    expect(aiProcessors({ VISION_PROVIDER: "anthropic", ANTHROPIC_VISION_MODEL: "m" })).toEqual([]);
    expect(aiProcessors({ VISION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_VISION_MODEL: "m" }).map((p) => p.name)).toEqual(["Anthropic"]);
    expect(aiProcessors({ VISION_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_VISION_MODEL: "m" }).map((p) => p.name)).toEqual(["OpenAI"]);
    expect(aiProcessors({ TRANSCRIPTION_PROVIDER: "openai_compatible", TRANSCRIPTION_MODEL: "w" }).map((p) => p.name)).toEqual(["OpenAI"]);
    expect(aiProcessors({ TRANSCRIPTION_PROVIDER: "openai_compatible", TRANSCRIPTION_MODEL: "w", TRANSCRIPTION_BASE_URL: "https://stt.example.net/v1" })[0]!.name).toBe(
      "the speech-to-text service at stt.example.net",
    );
  });
});

describe("home page copy", () => {
  it("lists every feature once, with a destination", () => {
    expect(new Set(FEATURES.map((f) => f.name)).size).toBe(FEATURES.length);
    for (const f of FEATURES) expect(f.href).toMatch(/^\/[a-z-]*([#/][a-z-]+)?$/);
    expect(STEPS).toHaveLength(4);
  });

  it("doesn't overclaim the GTA model or the live delay", () => {
    const all = [...FEATURES.map((f) => f.body), ...STEPS.map((s) => s.body), ...FAQ.map((f) => f.a)].join(" ");
    expect(all).toMatch(/still being trained and isn't used/);
    expect(all).not.toMatch(/zero latency|no delay|100% accurate|always right/i);
  });
});
