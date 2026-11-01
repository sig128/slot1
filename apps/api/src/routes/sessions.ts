import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createQaProvider } from "@slot1/analysis";
import { AskInput, CorrectionInput, type ObservationDetail, type ObservationPage, type SessionSummary } from "@slot1/contracts";
import {
  applyCorrection,
  backfillSessionEvents,
  getAssets,
  getBroadcaster,
  getLibraryItemForRecording,
  getObservation,
  getRecordingBySession,
  getSession,
  getSettings,
  latestJobRunForSession,
  latestSessionEventId,
  listCorrections,
  listObservations,
  listSources,
  nearestReadyClip,
  requestSessionDeletion,
  setSessionVisibility,
  withTx,
  type StoredEvent,
  type StreamSessionRow,
} from "@slot1/db";
import { QUEUES } from "@slot1/platform";
import { answerQuestion, canViewSession, clipView, emitObservation, isOwner, sessionSummary, signedAssetUrl, type ServerContext } from "@slot1/services";
import { forbidden, notFound } from "../lib/errors";
import type { EventHub } from "../lib/hub";
import { requireBroadcaster } from "../lib/session";

const IdParam = z.object({ id: z.string().uuid() });

/** Load a session and enforce read access server-side. 404 (not 403) hides private sessions. */
export async function authorizeSession(ctx: ServerContext, req: FastifyRequest, id: string): Promise<{ session: StreamSessionRow; owner: boolean }> {
  const session = await getSession(ctx.db, id);
  if (!session) throw notFound("Session not found");
  const settings = await getSettings(ctx.db, session.broadcaster_id);
  if (!canViewSession(req.auth.viewer, session, settings)) throw notFound("Session not found");
  return { session, owner: isOwner(req.auth.viewer, session.broadcaster_id) };
}

async function recordingItemForSession(ctx: ServerContext, sessionId: string) {
  const rec = await getRecordingBySession(ctx.db, sessionId);
  return rec ? getLibraryItemForRecording(ctx.db, rec.id) : null;
}

async function summaryFor(ctx: ServerContext, session: StreamSessionRow, owner: boolean): Promise<SessionSummary> {
  const b = (await getBroadcaster(ctx.db, session.broadcaster_id))!;
  const sources = await listSources(ctx.db, session.broadcaster_id);
  let playbackSource = sources.find((s) => s.session_id === session.id && s.kind === "upload" && s.playback_asset_id) ?? null;
  if (!playbackSource) {
    // A finalized live recording plays like an upload. Its video follows the recording's own
    // library visibility: the owner always; others only when the creator shared the recording.
    const rec = sources.find((s) => s.session_id === session.id && s.kind === "recording" && s.playback_asset_id) ?? null;
    const item = rec && !owner ? await recordingItemForSession(ctx, session.id) : null;
    if (rec && (owner || (item && item.status === "ready" && item.visibility !== "private"))) playbackSource = rec;
  }
  return sessionSummary(ctx.db, ctx.storage, ctx.config, session, b, { playbackSource, job: owner ? await latestJobRunForSession(ctx.db, session.id) : null });
}

function selectPayload(e: StoredEvent, owner: boolean): unknown | null {
  return owner ? e.payload : e.publicPayload;
}

export const sessionRoutes =
  (ctx: ServerContext, hub: EventHub): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/sessions/:id", async (req): Promise<SessionSummary> => {
      const { id } = IdParam.parse(req.params);
      const { session, owner } = await authorizeSession(ctx, req, id);
      return summaryFor(ctx, session, owner);
    });

    /** What the current viewer may do in this session (no session cookie is created). */
    app.get("/api/sessions/:id/viewer", async (req) => {
      const { id } = IdParam.parse(req.params);
      const { session, owner } = await authorizeSession(ctx, req, id);
      const settings = await getSettings(ctx.db, session.broadcaster_id);
      const canAsk = owner || settings.viewerQuestions === "anyone" || (settings.viewerQuestions === "signed_in" && req.auth.user !== null);
      return { isCreator: owner, canAsk, askPolicy: settings.viewerQuestions };
    });

    app.get("/api/sessions/:id/observations", async (req): Promise<ObservationPage> => {
      const { id } = IdParam.parse(req.params);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(500) }).parse(req.query);
      const { session, owner } = await authorizeSession(ctx, req, id);
      const observations = await listObservations(ctx.db, session.id, { limit, includeRejected: owner });
      const ids = new Set(observations.map((o) => o.sourceId).filter((x): x is string => Boolean(x)));
      const sources = (await listSources(ctx.db, session.broadcaster_id))
        .filter((s) => ids.has(s.id))
        .map((s) => ({ id: s.id, kind: s.kind, label: s.label, name: s.name, createdAt: s.created_at.toISOString() }));
      return { observations, sources, lastEventId: await latestSessionEventId(ctx.db, session.id), hasMore: observations.length >= limit };
    });

    /**
     * Authenticated SSE stream with event ids. Reconnects send Last-Event-ID and receive a
     * gap-free backfill from Postgres; live events then follow. Public viewers only ever get
     * sanitized public payloads, and only for public sessions.
     */
    app.get("/api/sessions/:id/events", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply: FastifyReply) => {
      const { id } = IdParam.parse(req.params);
      const { session, owner } = await authorizeSession(ctx, req, id);
      const header = req.headers["last-event-id"];
      const fromQuery = (req.query as { after?: string }).after;
      const lastIdRaw = (Array.isArray(header) ? header[0] : header) ?? fromQuery ?? null;
      let lastSent = lastIdRaw && /^\d{1,19}$/.test(lastIdRaw) ? lastIdRaw : null;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`retry: 3000\n\n`);
      const send = (e: StoredEvent) => {
        if (lastSent !== null && BigInt(e.id) <= BigInt(lastSent)) return; // never duplicate
        const data = selectPayload(e, owner);
        lastSent = e.id;
        if (data === null || data === undefined) return;
        res.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify({ id: e.id, sessionId: e.sessionId, at: e.at, kind: e.kind, data })}\n\n`);
      };
      // Subscribe first and buffer, then backfill, then flush: nothing is lost in between.
      const buffered: StoredEvent[] = [];
      let live = false;
      const unsubscribe = await hub.subscribe(session.id, (e) => {
        if (e.sessionId !== session.id) return; // defense in depth: never cross sessions
        if (live) send(e);
        else buffered.push(e);
      });
      try {
        for (;;) {
          const batch = await backfillSessionEvents(ctx.db, session.id, lastSent, 500);
          for (const e of batch) send(e);
          if (batch.length < 500) break;
        }
        for (const e of buffered.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) send(e);
        live = true;
      } catch {
        await unsubscribe();
        res.end();
        return;
      }
      const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
      req.raw.on("close", () => {
        clearInterval(ping);
        void unsubscribe();
      });
    });

    /** Polling fallback for clients that cannot keep an SSE connection. */
    app.get("/api/sessions/:id/events/poll", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
      const { id } = IdParam.parse(req.params);
      const { after } = z.object({ after: z.string().regex(/^\d{1,19}$/).optional() }).parse(req.query);
      const { session, owner } = await authorizeSession(ctx, req, id);
      const events = await backfillSessionEvents(ctx.db, session.id, after ?? null, 500);
      return {
        events: events
          .map((e) => ({ id: e.id, sessionId: e.sessionId, at: e.at, kind: e.kind, data: selectPayload(e, owner) }))
          .filter((e) => e.data !== null && e.data !== undefined),
        lastEventId: events.at(-1)?.id ?? after ?? null,
      };
    });

    app.post("/api/sessions/:id/ask", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (req) => {
      const { id } = IdParam.parse(req.params);
      const { question } = AskInput.parse(req.body);
      const { session, owner } = await authorizeSession(ctx, req, id);
      const settings = await getSettings(ctx.db, session.broadcaster_id);
      if (!owner) {
        if (settings.viewerQuestions === "off") throw forbidden("The creator has turned off viewer questions");
        if (settings.viewerQuestions === "signed_in" && !req.auth.user) throw forbidden("Sign in to ask SLOT1");
      }
      // Read-only: answering never triggers actions or configuration changes.
      return answerQuestion(ctx, session, question, createQaProvider(ctx.config.env));
    });

    app.patch("/api/sessions/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = requireBroadcaster(req);
      const body = z.object({ visibility: z.enum(["public", "private"]) }).strict().parse(req.body);
      if (!(await setSessionVisibility(ctx.db, b.id, id, body.visibility))) throw notFound("Session not found");
      return { ok: true };
    });

    /** Delete a session: media, transcripts and analysis are removed by a background job. */
    app.delete("/api/sessions/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = requireBroadcaster(req);
      if (!(await requestSessionDeletion(ctx.db, b.id, id))) throw notFound("Session not found");
      await ctx.enqueue(QUEUES.maintenance, "delete-session", { sessionId: id, broadcasterId: b.id }, { jobId: `delete-${id}` });
      return { ok: true, scheduled: true };
    });

    app.get("/api/observations/:id", async (req): Promise<ObservationDetail> => {
      const { id } = IdParam.parse(req.params);
      const o = await getObservation(ctx.db, id);
      if (!o) throw notFound("Observation not found");
      const { session, owner } = await authorizeSession(ctx, req, o.sessionId);
      if (o.reviewStatus === "rejected" && !owner) throw notFound("Observation not found");
      const assets = await getAssets(
        ctx.db,
        o.evidence.map((e) => e.assetId),
      );
      const evidence = [];
      for (const a of assets.filter((x) => x.session_id === session.id)) {
        evidence.push({
          assetId: a.id,
          kind: a.kind,
          url: await signedAssetUrl(ctx.storage, ctx.config, a),
          contentType: a.content_type,
          width: a.width,
          height: a.height,
          mediaPtsMs: a.media_pts_ms,
          durationMs: a.duration_ms,
        });
      }
      evidence.sort((a, b) => (a.mediaPtsMs ?? 0) - (b.mediaPtsMs ?? 0));
      const clip = await nearestReadyClip(ctx.db, session.id, o.mediaStartMs, o.receivedAt);
      return {
        observation: o,
        evidence,
        corrections: owner ? await listCorrections(ctx.db, o.id) : [],
        sessionLabel: session.label,
        sessionKind: session.kind,
        nearbyClip: clip ? await clipView(ctx.db, ctx.storage, ctx.config, clip) : null,
        canEdit: owner,
      };
    });

    /** Creator correction with preserved audit history. */
    app.post("/api/observations/:id/corrections", async (req) => {
      const { id } = IdParam.parse(req.params);
      const b = requireBroadcaster(req);
      const correction = CorrectionInput.parse(req.body);
      const updated = await withTx(ctx.db, (tx) => applyCorrection(tx, { observationId: id, broadcasterId: b.id, actorUserId: req.auth.user!.id, correction }));
      if (!updated) throw notFound("Observation not found");
      const session = await getSession(ctx.db, updated.sessionId);
      if (session) await emitObservation(ctx.db, ctx.publisher, session, updated, "observation.updated");
      return updated;
    });
  };
