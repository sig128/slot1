import type { FastifyPluginAsync } from "fastify";
import { MomentsQuery, SaveMomentInput, type MomentView } from "@slot1/contracts";
import { createMoment, getClipJob, getObservation, getSession, listMoments } from "@slot1/db";
import { clipView, emitMoment, momentView, type ServerContext } from "@slot1/services";
import { badRequest, notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

export const momentRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /** Library search, authorized in SQL: own channel + public analysis of opted-in channels. */
    app.get("/api/moments", async (req): Promise<{ moments: MomentView[] }> => {
      const f = MomentsQuery.parse(req.query);
      const rows = await listMoments(ctx.db, { viewerBroadcasterId: req.auth.viewer.broadcasterId }, f);
      const moments: MomentView[] = [];
      for (const r of rows) {
        const clipRow = r.clip_job_id ? await getClipJob(ctx.db, r.clip_job_id) : null;
        const clip = clipRow ? await clipView(ctx.db, ctx.storage, ctx.config, clipRow) : null;
        const view = await momentView(ctx.db, ctx.storage, ctx.config, r, clip);
        // Exports are only offered to the owner.
        if (r.broadcaster_id !== req.auth.viewer.broadcasterId && view.clip) view.clip = { ...view.clip, exports: [] };
        if (r.broadcaster_id !== req.auth.viewer.broadcasterId) view.canExport = false;
        moments.push(view);
      }
      return { moments };
    });

    app.post("/api/moments", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
      const b = requireBroadcaster(req);
      const input = SaveMomentInput.parse(req.body);
      const session = await getSession(ctx.db, input.sessionId);
      if (!session || session.broadcaster_id !== b.id) throw notFound("Session not found");
      let start = input.mediaStartMs ?? null;
      let end = input.mediaEndMs ?? null;
      if (input.observationId) {
        const o = await getObservation(ctx.db, input.observationId);
        if (!o || o.sessionId !== session.id) throw badRequest("That observation isn't part of this session");
        start = start ?? o.mediaStartMs;
        end = end ?? o.mediaEndMs;
      }
      if (start !== null && end !== null && end < start) throw badRequest("End must be after start");
      const m = await createMoment(ctx.db, {
        broadcasterId: b.id,
        sessionId: session.id,
        observationId: input.observationId ?? null,
        title: input.title,
        note: input.note ?? null,
        mediaStartMs: start,
        mediaEndMs: end,
        userId: req.auth.user!.id,
      });
      await emitMoment(ctx.db, ctx.publisher, session, { id: m.id, title: input.title, mediaStartMs: start });
      return { id: m.id };
    });
  };
