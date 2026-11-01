import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ClipRequestInput, type ClipView } from "@slot1/contracts";
import { createClipJob, getBroadcaster, getClipJob, getGrant, getMoment, getSession, getSettings, listClipJobs, listSources } from "@slot1/db";
import { QUEUES } from "@slot1/platform";
import { clipView, emitClip, type ServerContext } from "@slot1/services";
import { conflict, notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";
import { authorizeSession } from "./sessions";

export const clipRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * Request a clip. Three distinct paths: a Twitch live clip (async, may fail), a clip from an
     * authorized Twitch VOD, or a render from media SLOT1 actually possesses. A queued request is
     * never presented as a finished clip.
     */
    app.post("/api/clips", { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req): Promise<ClipView> => {
      const b = requireBroadcaster(req);
      const input = ClipRequestInput.parse(req.body);
      const session = await getSession(ctx.db, input.sessionId);
      if (!session || session.broadcaster_id !== b.id) throw notFound("Session not found");
      const moment = input.momentId ? await getMoment(ctx.db, input.momentId) : null;
      if (input.momentId && (!moment || moment.session_id !== session.id)) throw notFound("Moment not found");
      const broadcaster = (await getBroadcaster(ctx.db, b.id))!;
      const grant = broadcaster.twitch_user_id ? await getGrant(ctx.db, "broadcaster", broadcaster.twitch_user_id) : null;

      let job;
      if (input.kind === "twitch_live") {
        if (!ctx.config.capabilities.twitch.available) throw conflict("Twitch isn't configured", ctx.config.capabilities.twitch.reason);
        if (session.kind !== "twitch_broadcast" || session.broadcast_state !== "live") throw conflict("Live clips need the channel to be live on Twitch");
        if (!grant || grant.status !== "active") throw conflict("Twitch is not connected", "Connect Twitch in Studio");
        if (!grant.scopes.includes("clips:edit")) throw conflict("Missing clip permission", "Reconnect Twitch to grant clips:edit");
        ({ job } = await createClipJob(ctx.db, {
          broadcasterId: b.id,
          sessionId: session.id,
          momentId: input.momentId ?? null,
          kind: "twitch_live",
          idempotencyKey: input.idempotencyKey,
          requestSource: "web",
          userId: req.auth.user!.id,
          chatterId: null,
        }));
        if (job.state === "requested") await ctx.enqueue(QUEUES.twitch, "create-live-clip", { clipJobId: job.id }, { jobId: `clip-${job.id}`, attempts: 1 });
      } else if (input.kind === "twitch_vod") {
        if (session.kind !== "twitch_broadcast" || !session.twitch_stream_id) throw conflict("VOD clips need a past Twitch broadcast");
        if (!grant || !grant.scopes.includes("channel:manage:clips")) throw conflict("Missing VOD clip permission", "Reconnect Twitch with clip analysis enabled (channel:manage:clips)");
        if (!moment) throw conflict("Pick a saved moment to clip from the VOD");
        // VOD offset is ESTIMATED from wall-clock time since the stream started; shown as estimated.
        const at = moment.created_at.getTime();
        const offsetSec = Math.max(30, Math.round((at - session.started_at.getTime()) / 1000));
        ({ job } = await createClipJob(ctx.db, {
          broadcasterId: b.id,
          sessionId: session.id,
          momentId: moment.id,
          kind: "twitch_vod",
          idempotencyKey: input.idempotencyKey,
          requestSource: "web",
          userId: req.auth.user!.id,
          chatterId: null,
          vodOffsetSec: offsetSec,
          durationMs: 30_000,
        }));
        if (job.state === "requested") await ctx.enqueue(QUEUES.twitch, "create-vod-clip", { clipJobId: job.id }, { jobId: `vod-${job.id}`, attempts: 1 });
      } else {
        const settings = await getSettings(ctx.db, b.id);
        const sources = await listSources(ctx.db, b.id);
        const hasUpload = sources.some((s) => s.session_id === session.id && (s.kind === "upload" || s.kind === "recording") && s.original_asset_id && s.status === "ready");
        const hasBuffer = sources.some((s) => s.session_id === session.id && s.kind === "live_ingest") && settings.rollingBufferEnabled && settings.recordingConsent;
        if (!hasUpload && !hasBuffer) throw conflict("SLOT1 doesn't hold media for this session", "Upload the recording, or enable the rolling buffer for live ingest");
        const center = input.centerMs ?? moment?.media_start_ms ?? null;
        if (center === null) throw conflict("Choose a moment or a time to clip");
        ({ job } = await createClipJob(ctx.db, {
          broadcasterId: b.id,
          sessionId: session.id,
          momentId: input.momentId ?? null,
          kind: "owned_render",
          idempotencyKey: input.idempotencyKey,
          requestSource: "web",
          userId: req.auth.user!.id,
          chatterId: null,
          centerMs: center,
          preRollMs: input.preRollMs ?? 8000,
          postRollMs: input.postRollMs ?? 8000,
          vertical: input.vertical ?? false,
          caption: input.caption ?? null,
        }));
        if (job.state === "requested") await ctx.enqueue(QUEUES.media, "render-clip", { jobRunId: job.id, clipJobId: job.id }, { jobId: `render-${job.id}`, attempts: 1 });
      }
      const view = await clipView(ctx.db, ctx.storage, ctx.config, job);
      await emitClip(ctx.db, ctx.publisher, session, view);
      return view;
    });

    app.get("/api/clips/:id", async (req): Promise<ClipView> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const job = await getClipJob(ctx.db, id);
      if (!job) throw notFound("Clip not found");
      const { owner } = await authorizeSession(ctx, req, job.session_id);
      const view = await clipView(ctx.db, ctx.storage, ctx.config, job);
      return owner ? view : { ...view, exports: [], errorMessage: null };
    });

    app.get("/api/sessions/:id/clips", async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { session, owner } = await authorizeSession(ctx, req, id);
      const rows = await listClipJobs(ctx.db, session.id, 30);
      const views = [];
      for (const r of rows) {
        const v = await clipView(ctx.db, ctx.storage, ctx.config, r);
        if (owner) views.push(v);
        else if (v.state === "ready") views.push({ ...v, exports: [], errorMessage: null });
      }
      return { clips: views };
    });
  };
