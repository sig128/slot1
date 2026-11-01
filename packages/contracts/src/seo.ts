import { z } from "zod";
import { LibraryItemKind } from "./clipper";

/**
 * What search engines may list (GET /api/seo/sitemap). Only things an anonymous visitor can
 * already open: public channels listed on On Air, public creator profiles, and public items.
 * Private and unlisted items never appear.
 */
export const SitemapResponse = z.object({
  channels: z.array(z.object({ login: z.string(), updatedAt: z.string() })),
  creators: z.array(z.object({ login: z.string(), updatedAt: z.string() })),
  items: z.array(
    z.object({
      id: z.string(),
      kind: LibraryItemKind,
      title: z.string(),
      login: z.string(),
      displayName: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      durationMs: z.number().nullable(),
      hasPoster: z.boolean(),
      /** Stable path crawlers can fetch the media from (redirects to a short-lived signed URL). */
      mediaPath: z.string().nullable(),
    }),
  ),
  generatedAt: z.string(),
});
export type SitemapResponse = z.infer<typeof SitemapResponse>;
