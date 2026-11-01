import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InstantReplayRequest, type InstantReplayResponse, type InstantReplayStatus, type MomentLinkTarget } from "@slot1/contracts";
import { getBroadcaster, getObservation } from "@slot1/db";
import { closeInstantReplay, instantReplayStatus, makeInstantReplay, type ServerContext } from "@slot1/services";
import { ApiProblem, notFound } from "../lib/errors";
import { authorizeSession } from "./sessions";

const Id = z.object({ id: z.string().uuid() });

/**
 * Instant replay and moment links. Both are authorized exactly like the session itself (and so
 * like its SLOT1 live video): the owner always, everyone else only for public sessions. A moment
 * the viewer may not see answers 404, the same as a moment that doesn't exist.
 */
export const instantRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.addHook("onClose", async () => closeInstantReplay(ctx));

    /** Whether instant replay works in this session right now, and if not, exactly why. */
    app.get("/api/sessions/:id/instant-replay", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply): Promise<InstantReplayStatus> => {
      const { id } = Id.parse(req.params);
      const { session } = await authorizeSession(ctx, req, id);
      reply.header("cache-control", "no-store");
      const { available, reason, source, bufferSeconds } = await instantReplayStatus(ctx, session);
      return { available, reason, source, bufferSeconds };
    });

    /** Cut (or reuse) a short replay around a moment. Ephemeral: never added to the library. */
    app.post("/api/sessions/:id/instant-replay", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply): Promise<InstantReplayResponse> => {
      const { id } = Id.parse(req.params);
      const { session } = await authorizeSession(ctx, req, id);
      const body = InstantReplayRequest.parse(req.body ?? {});
      reply.header("cache-control", "no-store");
      return makeInstantReplay(ctx, session, body);
    });

    /**
     * Where a moment link (`/m/<observationId>`) should open: the live watch page with an instant
     * replay while the stream is live, or the recording at that second once it has finished.
     */
    app.get("/api/moment-links/:id", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply): Promise<MomentLinkTarget> => {
      const { id } = Id.parse(req.params);
      const o = await getObservation(ctx.db, id);
      if (!o || o.reviewStatus === "rejected") throw notFound("Moment not found");
      let session;
      try {
        ({ session } = await authorizeSession(ctx, req, o.sessionId));
      } catch (err) {
        if (err instanceof ApiProblem && err.status === 404) throw notFound("Moment not found");
        throw err;
      }
      reply.header("cache-control", "no-store");
      const live = session.kind !== "replay" && !session.ended_at && !session.delete_requested_at;
      if (live) {
        const b = await getBroadcaster(ctx.db, session.broadcaster_id);
        if (b) return { kind: "live", login: b.login, sessionId: session.id, observationId: o.id };
      }
      return { kind: "replay", sessionId: session.id, observationId: o.id, tMs: o.mediaStartMs };
    });
  };
