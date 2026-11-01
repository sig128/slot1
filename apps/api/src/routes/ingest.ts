import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSourceByPublishPath, markPublishEnded, markPublishing, type MediaSourceRow } from "@slot1/db";
import { safeEqual, sha256 } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { verifyWhepToken } from "./live";

/**
 * Media gateway hooks. Publishing is authenticated per source (stream key → hash compare),
 * bound to a creator-owned source, and refused once the source is revoked. Reading the stream is
 * reserved for the SLOT1 worker. Hooks themselves require INGEST_HOOK_SECRET and must only be
 * reachable on the private network (the edge proxy blocks /api/ingest/hooks/*).
 */
export const ingestRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    const hookAuthorized = (req: FastifyRequest) => {
      const secret = ctx.config.env.INGEST_HOOK_SECRET;
      const given = (req.query as { hook_secret?: string }).hook_secret ?? (req.headers["x-slot1-hook-secret"] as string | undefined);
      return Boolean(secret && given && safeEqual(given, secret));
    };

    const checkKey = (src: MediaSourceRow | null, key: string | undefined): src is MediaSourceRow =>
      Boolean(src && src.kind === "live_ingest" && !src.revoked_at && src.publish_key_hash && key && safeEqual(sha256(key), src.publish_key_hash));

    const readerOk = (user: string | undefined, pass: string | undefined) => {
      const pw = ctx.config.env.INGEST_READ_PASSWORD;
      return Boolean(pw && pass && user === ctx.config.env.INGEST_READ_USER && safeEqual(pass, pw));
    };

    /* ---------------------------- nginx-rtmp (on_publish / on_play) ---------------------------- */

    app.post("/api/ingest/hooks/nginx/:event", { config: { csrf: false } }, async (req, reply) => {
      if (!hookAuthorized(req)) return reply.status(403).send();
      const { event } = z.object({ event: z.enum(["publish", "publish_done", "play", "update"]) }).parse(req.params);
      const body = (req.body ?? {}) as Record<string, string>;
      const app_ = body.app ?? "";
      const name = (body.name ?? "").split("?")[0] ?? "";
      if (app_ !== "live" || !/^[a-z0-9]{4,40}$/.test(name)) return reply.status(403).send();
      const src = await getSourceByPublishPath(ctx.db, `live/${name}`);
      if (event === "publish") {
        if (!checkKey(src, body.key)) return reply.status(403).send();
        await markPublishing(ctx.db, src.id, body.addr ?? null);
        return reply.status(200).send();
      }
      if (event === "publish_done") {
        if (src) await markPublishEnded(ctx.db, src.id);
        return reply.status(200).send();
      }
      if (event === "update") {
        // Periodic re-check while connected (on_update). A non-2xx answer makes nginx drop the
        // connection, so revoking or rotating a key cuts an active publisher within one interval.
        if (body.reader !== undefined) return readerOk(body.reader_user ?? ctx.config.env.INGEST_READ_USER, body.reader) && src && !src.revoked_at ? reply.status(200).send() : reply.status(403).send();
        return checkKey(src, body.key) ? reply.status(200).send() : reply.status(403).send();
      }
      // play: only the SLOT1 worker may read a creator's stream.
      return readerOk(body.reader_user ?? ctx.config.env.INGEST_READ_USER, body.reader) && src && !src.revoked_at ? reply.status(200).send() : reply.status(403).send();
    });

    /* --------------------------------- MediaMTX (authMethod: http) ----------------------------- */

    const MediaMtxAuth = z.object({
      user: z.string().optional().default(""),
      password: z.string().optional().default(""),
      token: z.string().optional().default(""),
      ip: z.string().optional(),
      action: z.enum(["publish", "read", "playback", "api", "metrics", "pprof"]),
      path: z.string().optional().default(""),
      protocol: z.string().optional(),
      query: z.string().optional().default(""),
    });

    app.post("/api/ingest/hooks/mediamtx/auth", { config: { csrf: false } }, async (req, reply) => {
      if (!hookAuthorized(req)) return reply.status(403).send();
      const parsed = MediaMtxAuth.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send();
      const a = parsed.data;
      // WebRTC clients (WHIP/WHEP) send "Authorization: Bearer …", which MediaMTX forwards as
      // `token`. A `token=` query parameter is accepted as well.
      const bearer = a.token || new URLSearchParams(a.query).get("token") || "";
      // RTSP clients first try without credentials; 401 makes them send them.
      if (!a.user && !a.password && !bearer && (a.action === "read" || a.action === "publish")) return reply.status(401).send();
      if (a.action === "api" || a.action === "metrics" || a.action === "pprof") return readerOk(a.user, a.password) ? reply.status(200).send() : reply.status(403).send();
      if (!/^live\/[a-z0-9]{4,40}$/.test(a.path)) return reply.status(403).send();
      const src = await getSourceByPublishPath(ctx.db, a.path);
      if (a.action === "publish") {
        const name = a.path.slice("live/".length);
        // OBS WHIP publishing: the bearer token is the stream key secret for exactly this path.
        const whipOk = a.protocol === "webrtc" && bearer !== "" && checkKey(src, bearer);
        const passwordOk = a.user === name && checkKey(src, a.password);
        if (!whipOk && !passwordOk) return reply.status(403).send();
        await markPublishing(ctx.db, src!.id, a.ip ?? null);
        return reply.status(200).send();
      }
      if (a.action === "read" && a.protocol === "webrtc" && bearer) {
        // Viewers: a short-lived token from /api/sessions/:id/live-video, bound to this path.
        return src && !src.revoked_at && verifyWhepToken(ctx, bearer, a.path) ? reply.status(200).send() : reply.status(403).send();
      }
      // Every other read (RTSP, RTMP, playback) is reserved for the SLOT1 worker.
      return a.action === "read" && readerOk(a.user, a.password) && src && !src.revoked_at ? reply.status(200).send() : reply.status(403).send();
    });
  };
