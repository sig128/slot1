import type { FastifyPluginAsync } from "fastify";
import { verifyPayload, type FsStorage } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { ApiProblem, notFound } from "../lib/errors";

/**
 * Serves short-lived signed media URLs for the filesystem storage driver (S3 deployments use
 * presigned URLs instead). Authorization happened when the URL was signed; the signature and
 * expiry are verified here. Supports Range requests so replays can seek.
 */
export const mediaRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/media/f/:token", { config: { csrf: false } }, async (req, reply) => {
      if (ctx.storage.driver !== "fs") throw notFound();
      const { token } = req.params as { token: string };
      if (!token || token.length > 2000) throw notFound();
      const v = verifyPayload<{ k: string; exp: number; ct: string }>(ctx.config.sessionSecret, token);
      if (!v.ok) throw new ApiProblem(v.reason === "expired" ? 410 : 403, v.reason, v.reason === "expired" ? "Media link expired — reload the page" : "Invalid media link");
      const storage = ctx.storage as FsStorage;
      const size = await storage.size(v.payload.k);
      if (size === null) throw notFound("Media no longer stored");
      const ct = /^[a-z]+\/[a-z0-9.+-]+$/i.test(v.payload.ct) ? v.payload.ct : "application/octet-stream";
      reply.header("content-type", ct);
      reply.header("accept-ranges", "bytes");
      reply.header("cache-control", `private, max-age=${ctx.config.env.MEDIA_URL_TTL_SECONDS}`);
      reply.header("content-disposition", "inline");
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
        const obj = await storage.getStream(v.payload.k, { start, end });
        reply.status(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
        return reply.send(obj.stream);
      }
      const obj = await storage.getStream(v.payload.k);
      reply.header("content-length", String(obj.contentLength));
      return reply.send(obj.stream);
    });
  };
