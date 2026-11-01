import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/origin";

// The origin comes from the server's environment at request time, not from the build.
export const dynamic = "force-dynamic";

/**
 * Crawl everything public. Studio and the admin dashboard are private tools, and the API is not
 * content — except share-card posters and the stable media addresses that structured data points
 * at, which link previews and video search need to fetch.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await publicOrigin();
  return {
    rules: [{ userAgent: "*", allow: ["/", "/api/library/*/poster", "/api/seo/media/"], disallow: ["/admin", "/studio", "/api/"] }],
    sitemap: `${origin}/sitemap.xml`,
  };
}
