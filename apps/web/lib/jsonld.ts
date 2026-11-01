/**
 * schema.org structured data builders. Pure functions (no Next.js imports) so they are unit
 * tested. Values come from SLOT1's own data; user-supplied text (titles, channel names) is
 * escaped by `jsonLdString` before it reaches the page.
 */

type Thing = Record<string, unknown>;

/** JSON for a <script type="application/ld+json"> block: "<" can't close the element early. */
export function jsonLdString(data: object | object[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function abs(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

/** ISO 8601 duration ("PT1M23S") from milliseconds, as schema.org wants for VideoObject. */
export function isoDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

export function organization(origin: string, legalName: string): Thing {
  return {
    "@type": "Organization",
    "@id": abs(origin, "/#organization"),
    name: "SLOT1",
    ...(legalName !== "SLOT1" ? { legalName } : {}),
    url: abs(origin, "/"),
    logo: { "@type": "ImageObject", url: abs(origin, "/icon.svg") },
  };
}

export function website(origin: string, description: string): Thing {
  return {
    "@type": "WebSite",
    "@id": abs(origin, "/#website"),
    name: "SLOT1",
    url: abs(origin, "/"),
    description,
    inLanguage: "en",
    publisher: { "@id": abs(origin, "/#organization") },
  };
}

export function webApplication(origin: string, description: string): Thing {
  return {
    "@type": "WebApplication",
    "@id": abs(origin, "/#app"),
    name: "SLOT1",
    url: abs(origin, "/"),
    description,
    applicationCategory: "EntertainmentApplication",
    operatingSystem: "Any (web browser)",
    browserRequirements: "Requires a modern web browser with JavaScript.",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": abs(origin, "/#organization") },
  };
}

export function faqPage(origin: string, items: { q: string; a: string }[]): Thing {
  return {
    "@type": "FAQPage",
    "@id": abs(origin, "/#faq"),
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
  };
}

export function graph(...nodes: Thing[]): Thing {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** A public clip, render or recording on /v/[id]. */
export function clipVideo(o: {
  origin: string;
  id: string;
  title: string;
  description: string;
  createdAt: string;
  durationMs: number | null;
  posterUrl: string | null;
  channel: { login: string; displayName: string };
  /** Stable media URL for crawlers (a redirect to a fresh signed URL). */
  contentPath: string | null;
}): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "@id": abs(o.origin, `/v/${o.id}#video`),
    name: o.title,
    description: o.description,
    uploadDate: o.createdAt,
    ...(o.durationMs ? { duration: isoDuration(o.durationMs) } : {}),
    ...(o.posterUrl ? { thumbnailUrl: [o.posterUrl] } : {}),
    ...(o.contentPath ? { contentUrl: abs(o.origin, o.contentPath) } : {}),
    url: abs(o.origin, `/v/${o.id}`),
    inLanguage: "en",
    isFamilyFriendly: false,
    creator: { "@type": "Person", name: o.channel.displayName, url: abs(o.origin, `/c/${o.channel.login}`) },
    publisher: { "@id": abs(o.origin, "/#organization") },
  };
}

/**
 * A channel that is live right now on a SLOT1-connected public channel: a VideoObject with a
 * BroadcastEvent (Google's live badge). Only emitted while Twitch reports the stream live.
 */
export function liveBroadcast(o: {
  origin: string;
  login: string;
  displayName: string;
  title: string | null;
  category: string | null;
  startedAt: string;
  thumbnailUrl: string | null;
  embedParent: string;
}): Thing {
  const name = o.title ? `${o.displayName}: ${o.title}` : `${o.displayName} live`;
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "@id": abs(o.origin, `/watch/${o.login}#live`),
    name,
    description: `${o.displayName} is live${o.category ? ` in ${o.category}` : ""}. Watch on SLOT1 with a log of what SLOT1 saw happen on screen.`,
    uploadDate: o.startedAt,
    ...(o.thumbnailUrl ? { thumbnailUrl: [o.thumbnailUrl] } : {}),
    embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(o.login)}&parent=${encodeURIComponent(o.embedParent)}`,
    url: abs(o.origin, `/watch/${o.login}`),
    publication: { "@type": "BroadcastEvent", isLiveBroadcast: true, startDate: o.startedAt },
    creator: { "@type": "Person", name: o.displayName, url: `https://www.twitch.tv/${o.login}` },
  };
}
