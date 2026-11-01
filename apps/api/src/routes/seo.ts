import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { SitemapResponse } from "@slot1/contracts";
import { getAsset, getLibraryItem, getSettings, listSitemapChannels, listSitemapCreators, listSitemapItems } from "@slot1/db";
import { playbackUrlTtl, type ServerContext } from "@slot1/services";
import { notFound } from "../lib/errors";

/** Search engines fetch the sitemap rarely; one query set per this long is plenty. */
export const SITEMAP_CACHE_MS = 10 * 60_000;
const VIDEO_KINDS = new Set(["recording", "render", "clip_export"]);
const iso = (d: Date) => new Date(d).toISOString();

let cache: { at: number; data: SitemapResponse } | null = null;
export function clearSitemapCache() {
  cache = null;
}

async function buildSitemap(ctx: ServerContext): Promise<SitemapResponse> {
  const [channels, creators, items] = await Promise.all([listSitemapChannels(ctx.db), listSitemapCreators(ctx.db), listSitemapItems(ctx.db)]);
  return {
    channels: channels.map((c) => ({ login: c.login, updatedAt: iso(c.updated_at) })),
    creators: creators.map((c) => ({ login: c.login, updatedAt: iso(c.updated_at) })),
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      login: i.login,
      displayName: i.display_name,
      createdAt: iso(i.created_at),
      updatedAt: iso(i.updated_at),
      durationMs: i.duration_ms === null ? null : Number(i.duration_ms),
      hasPoster: Boolean(i.poster_asset_id) || (i.kind === "screenshot" && Boolean(i.asset_id)),
      mediaPath: VIDEO_KINDS.has(i.kind) && i.asset_id ? `/api/seo/media/${i.id}` : null,
    })),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Public data for search engines: the sitemap listing, and a stable media address for public
 * videos (signed media links expire, but a VideoObject's contentUrl has to stay valid).
 */
export function seoRoutes(ctx: ServerContext): FastifyPluginAsync {
  return async (app) => {
    app.get("/api/seo/sitemap", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_req, reply): Promise<SitemapResponse> => {
      if (!cache || Date.now() - cache.at > SITEMAP_CACHE_MS) cache = { at: Date.now(), data: await buildSitemap(ctx) };
      reply.header("cache-control", "public, max-age=600");
      return cache.data;
    });

    app.get("/api/seo/media/:id", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const item = await getLibraryItem(ctx.db, id);
      // Exactly what an anonymous visitor may play: public, ready, a video, on a public channel.
      if (!item || item.visibility !== "public" || item.status !== "ready" || !VIDEO_KINDS.has(item.kind) || !item.asset_id) throw notFound("Not found");
      if ((await getSettings(ctx.db, item.broadcaster_id)).visibility !== "public") throw notFound("Not found");
      const a = await getAsset(ctx.db, item.asset_id);
      if (!a || a.deleted_at) throw notFound("Not found");
      const url = await ctx.storage.signedGetUrl(a.storage_key, playbackUrlTtl(ctx.config), a.content_type);
      reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
      return reply.redirect(url, 302);
    });
  };
}
