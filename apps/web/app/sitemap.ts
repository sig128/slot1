import type { MetadataRoute } from "next";
import type { SitemapResponse } from "@slot1/contracts";
import { publicOrigin } from "@/lib/origin";
import { clampDescription } from "@/lib/site";

// Read at request time: the origin is the server's, and the listing comes from the live API.
export const dynamic = "force-dynamic";

const API = process.env.SLOT1_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

const STATIC: { path: string; changeFrequency: "always" | "daily" | "weekly" | "monthly" | "yearly"; priority: number }[] = [
  { path: "/", changeFrequency: "always", priority: 1 },
  { path: "/los-santos", changeFrequency: "always", priority: 0.9 },
  { path: "/moments", changeFrequency: "daily", priority: 0.6 },
  { path: "/setup", changeFrequency: "monthly", priority: 0.7 },
  { path: "/contact", changeFrequency: "yearly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

async function listing(): Promise<SitemapResponse | null> {
  try {
    const res = await fetch(`${API}/api/seo/sitemap`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as SitemapResponse) : null;
  } catch {
    return null;
  }
}

/** Public pages only. When the API can't be reached, the static pages are still listed. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await publicOrigin();
  const at = (path: string) => `${origin}${path}`;
  const data = await listing();
  const entries: MetadataRoute.Sitemap = STATIC.map((s) => ({ url: at(s.path), changeFrequency: s.changeFrequency, priority: s.priority }));
  if (!data) return entries;
  for (const c of data.channels) entries.push({ url: at(`/watch/${c.login}`), lastModified: c.updatedAt, changeFrequency: "hourly", priority: 0.8 });
  for (const c of data.creators) entries.push({ url: at(`/c/${c.login}`), lastModified: c.updatedAt, changeFrequency: "daily", priority: 0.7 });
  for (const i of data.items) {
    const poster = i.hasPoster ? at(`/api/library/${i.id}/poster`) : null;
    const description = clampDescription(`${i.kind === "screenshot" ? "A screenshot" : "A GTA clip"} by ${i.displayName} on SLOT1: ${i.title}`, 300);
    entries.push({
      url: at(`/v/${i.id}`),
      lastModified: i.updatedAt,
      changeFrequency: "monthly",
      priority: 0.6,
      ...(poster ? { images: [poster] } : {}),
      ...(poster && i.mediaPath
        ? {
            videos: [
              {
                title: i.title.slice(0, 100),
                thumbnail_loc: poster,
                description,
                content_loc: at(i.mediaPath),
                ...(i.durationMs ? { duration: Math.max(1, Math.min(28_800, Math.round(i.durationMs / 1000))) } : {}),
                publication_date: i.createdAt,
                family_friendly: "no" as const,
              },
            ],
          }
        : {}),
    });
  }
  return entries;
}
