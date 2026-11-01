import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { StudioAsset, type StudioAssetsResponse } from "@slot1/contracts";
import { loadStudioAssetManifest, loadStudioAssetPeaks, resolveStudioAsset, studioAssetContentType, studioAssetsRev } from "@slot1/analysis";
import type { ServerContext } from "@slot1/services";
import { notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

const ID = StudioAsset.shape.id;
/** A manifest `file` path (sfx/cash/register-01.m4a): lowercase segments and one extension, nothing else. */
const FILE = /^[a-z0-9]+(?:[/-][a-z0-9]+)*\.[a-z0-9]{2,4}$/;

let byFile: { manifest: object; map: Map<string, string> } | null = null;

/** Find a library item by id (canonical) or by its manifest file path. Anything else is not found. */
function lookup(param: string) {
  if (ID.safeParse(param).success) return resolveStudioAsset(param);
  if (!FILE.test(param)) return null;
  const manifest = loadStudioAssetManifest();
  if (byFile?.manifest !== manifest) byFile = { manifest, map: new Map(manifest.assets.map((a) => [a.file, a.id])) };
  const id = byFile.map.get(param);
  return id ? resolveStudioAsset(id) : null;
}

/**
 * The Studio's built-in library (docs/ASSET_MANIFEST.md, "Studio library"): sounds, music,
 * ambience and visual elements SLOT1 ships with. Creators only. File URLs carry `?v=<rev>` from
 * the manifest so browsers can cache them for good; Range requests are supported so audio can
 * seek (and Safari plays it). Files are addressed by item id (canonical) or by the manifest's
 * `file` path; both resolve through resolveStudioAsset, so nothing outside the library is served.
 */
export const studioAssetRoutes =
  (_ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/studio/assets", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply): Promise<StudioAssetsResponse | void> => {
      requireBroadcaster(req);
      const rev = studioAssetsRev();
      const etag = `"lib-${rev}"`;
      reply.header("cache-control", "private, max-age=300");
      reply.header("etag", etag);
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      const { assets } = loadStudioAssetManifest();
      return { version: 1, assets, rev, peaks: loadStudioAssetPeaks() };
    });

    app.get("/api/studio/assets/file/*", { config: { rateLimit: { max: 900, timeWindow: "1 minute" } } }, async (req, reply) => {
      requireBroadcaster(req);
      const found = lookup(String((req.params as { "*"?: string })["*"] ?? ""));
      if (!found) throw notFound("No such library item");
      const { v } = z.object({ v: z.string().max(64).optional() }).parse(req.query);
      const rev = studioAssetsRev();
      const size = (await stat(found.path)).size;
      reply.header("content-type", studioAssetContentType(found.path));
      reply.header("accept-ranges", "bytes");
      reply.header("etag", `"${rev}-${size}"`);
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", v === rev ? "private, max-age=31536000, immutable" : "private, max-age=3600");
      const range = req.headers.range;
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        let end = m[1] && m[2] ? Number(m[2]) : size - 1;
        if (start >= size || start > end) {
          reply.header("content-range", `bytes */${size}`);
          return reply.status(416).send();
        }
        end = Math.min(end, size - 1);
        start = Math.max(0, start);
        reply.status(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
        return reply.send(createReadStream(found.path, { start, end }));
      }
      reply.header("content-length", String(size));
      return reply.send(createReadStream(found.path));
    });
  };
