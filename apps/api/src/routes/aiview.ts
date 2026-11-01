import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AiViewResponse } from "@slot1/contracts";
import { listSources, type StreamSessionRow } from "@slot1/db";
import { AI_VIEW_REFRESH_MS, analysisStatus, markAiViewWatched, readAiView, readAiViewFrame, type ServerContext } from "@slot1/services";
import { notFound } from "../lib/errors";
import { authorizeSession } from "./sessions";

const unavailable = (reason: string): AiViewResponse => ({ available: false, reason, snapshot: null, refreshMs: AI_VIEW_REFRESH_MS });

/** Why there's no recent analyzed frame, in plain words. */
async function noSnapshotReason(ctx: ServerContext, session: StreamSessionRow): Promise<string> {
  const sources = await listSources(ctx.db, session.broadcaster_id);
  const live = sources.find((s) => s.kind === "live_ingest" && s.session_id === session.id && s.status === "publishing" && !s.revoked_at);
  if (!live) {
    return session.kind === "ingest"
      ? "The creator isn't sending video to SLOT1 right now, so there's no frame to show"
      : "This channel doesn't send its video to SLOT1, so SLOT1 can't see the gameplay";
  }
  const st = analysisStatus(session, ctx.config);
  if (st.state === "ready" && st.reason?.includes("agent not enabled")) return "AI analysis is off for this stream";
  if (st.state === "stopped") return "Analysis is paused by the creator";
  if (st.state === "stale") return "The video source went quiet, so nothing is being analyzed";
  return "Waiting for the first analyzed frame";
}

export const aiViewRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * "What the AI sees": the last frame SLOT1 analyzed in this live session and what each
     * analyzer did with it. Authorized exactly like the session's live video: the creator
     * always, everyone else only for public sessions with public analysis.
     */
    app.get("/api/sessions/:id/ai-view", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply): Promise<AiViewResponse> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { session } = await authorizeSession(ctx, req, id);
      reply.header("cache-control", "no-store");
      if (session.kind === "replay") return unavailable("This is an uploaded replay. Its evidence frames are in the log; the live AI view is for live streams");
      if (session.ended_at) return unavailable("This session has ended");
      await markAiViewWatched(ctx, session.id);
      const snapshot = await readAiView(ctx, session.id);
      if (!snapshot) return unavailable(await noSnapshotReason(ctx, session));
      return { available: true, reason: null, snapshot, refreshMs: AI_VIEW_REFRESH_MS };
    });

    /** The downscaled copy of exactly the analyzed frame (expires about a minute later). */
    app.get("/api/sessions/:id/ai-view/frame/:frameId", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { id, frameId } = z.object({ id: z.string().uuid(), frameId: z.string().uuid() }).parse(req.params);
      const { session } = await authorizeSession(ctx, req, id);
      const jpeg = await readAiViewFrame(ctx, session.id, frameId);
      if (!jpeg) throw notFound("That frame has expired");
      return reply.header("cache-control", "private, max-age=120, immutable").header("x-content-type-options", "nosniff").type("image/jpeg").send(jpeg);
    });
  };
