/**
 * Site-wide search and share metadata helpers (pure, so they're unit tested). Anything that
 * depends on the deployment is read at request time in lib/site.ts.
 *
 * `PageMeta` is a structural subset of Next's `Metadata`, declared here rather than imported so
 * the unit tests don't pull Next's global type declarations into the rest of the codebase.
 */
export interface PageMeta {
  title: string | { absolute: string };
  description: string;
  alternates: { canonical: string };
  openGraph: {
    type: "website" | "profile" | "video.other" | "article";
    siteName: string;
    locale: string;
    url: string;
    title: string;
    description: string;
    images: OgImage[];
  };
  twitter: { card: "summary_large_image"; title: string; description: string; images: { url: string; alt: string }[] };
  robots?: { index: boolean; follow: boolean };
}
export const SITE = {
  name: "SLOT1",
  /** Home page title: under 60 characters so search results don't cut it. */
  title: "SLOT1: live GTA streams with an AI that shows its evidence",
  description:
    "Watch GTA streams with a live AI log that links every line to the frames it came from. Instant replays, clips, moments and multistreaming for creators.",
  tagline: "Live GTA streams, with an AI that shows its evidence.",
  locale: "en_US",
  themeColor: "#101014",
} as const;

export type OgImage = { url: string; width?: number; height?: number; alt: string };

/** Search-engine site verification tokens are plain tokens; anything else is ignored. */
export function verificationToken(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v && /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : undefined;
}

/** A description trimmed to what search results show (about 160 characters), never mid-word. */
export function clampDescription(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/**
 * Metadata for one page: canonical URL, description, and complete Open Graph and Twitter cards
 * (a page's openGraph replaces the parent's, so every field is set here). Without images the
 * site's default share image is used.
 */
export function pageMetadata(p: {
  title: string;
  /** Use the title as-is, without the "— SLOT1" suffix. */
  absolute?: boolean;
  description: string;
  path: string;
  images?: OgImage[];
  type?: "website" | "profile" | "video.other" | "article";
  noindex?: boolean;
}): PageMeta {
  const description = clampDescription(p.description);
  const shareTitle = p.absolute ? p.title : `${p.title} — SLOT1`;
  const images = p.images && p.images.length > 0 ? p.images : [defaultShareImage()];
  return {
    title: p.absolute ? { absolute: p.title } : p.title,
    description,
    alternates: { canonical: p.path },
    openGraph: { type: p.type ?? "website", siteName: SITE.name, locale: SITE.locale, url: p.path, title: shareTitle, description, images },
    twitter: { card: "summary_large_image", title: shareTitle, description, images: images.map((i) => ({ url: i.url, alt: i.alt })) },
    ...(p.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/** The site-wide share card (app/opengraph-image.tsx). */
export function defaultShareImage(): OgImage {
  return { url: "/opengraph-image", width: 1200, height: 630, alt: SITE.tagline };
}

type WatchMeta = {
  authorized: boolean;
  channel: { login: string; displayName: string; broadcast: { state: string; title: string | null; category: string | null } };
};

/**
 * Watch page metadata. Only SLOT1-connected public channels are indexed: a pasted link to any
 * other Twitch channel opens a watch-only page that search engines shouldn't list as SLOT1's.
 * Logins Twitch can't issue (SLOT1's own demo channel) stay out of search results too.
 */
export function watchMetadata(w: WatchMeta): PageMeta {
  const { login, displayName, broadcast } = w.channel;
  const path = `/watch/${login}`;
  const indexable = w.authorized && /^[a-z0-9_]+$/i.test(login);
  if (!indexable) {
    return pageMetadata({
      title: `Watch ${displayName}`,
      description: `Watch ${displayName} on SLOT1 with Twitch's official player.`,
      path,
      noindex: true,
    });
  }
  const live = broadcast.state === "live";
  const description = live
    ? `${displayName} is live${broadcast.category ? ` in ${broadcast.category}` : ""}${broadcast.title ? `: ${broadcast.title}` : ""}. Watch on SLOT1 with a log of what happened on screen.`
    : `${displayName}'s GTA streams on SLOT1, with an evidence-backed log of what happened on screen, instant replays and clips.`;
  return pageMetadata({ title: live ? `${displayName} is live` : `Watch ${displayName}`, description, path, type: "video.other" });
}
