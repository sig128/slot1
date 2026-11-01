import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  bigMoment,
  CreateProjectInput,
  Edl,
  LibraryItemKind,
  LibraryItemPatch,
  LibraryVisibility,
  ProjectPatch,
  ScreenshotInput,
  type LibraryItemView,
  type LibraryResponse,
  type ProfileResponse,
  type ProjectSourceView,
  type ProjectView,
} from "@slot1/contracts";
import {
  createProject,
  deleteLibraryItem,
  deleteProject,
  getAsset,
  getAssets,
  getBroadcaster,
  getBroadcasterByLogin,
  getCurrentLiveSession,
  getLibraryItem,
  getObservation,
  getProject,
  getRecording,
  getSession,
  getSettings,
  insertAsset,
  insertLibraryItem,
  iso,
  listLibraryItems,
  listObservations,
  listProjects,
  listSources,
  setRecordingStatus,
  storageUsage,
  updateLibraryItem,
  updateProject,
  type BroadcasterRow,
  type LibraryItemRow,
  type StreamSessionRow,
} from "@slot1/db";
import { formatMediaTime } from "@slot1/contracts";
import { QUEUES, storageKeys } from "@slot1/platform";
import { ANONYMOUS, canViewSession, hiddenDemo, isOwner, libraryItemView, momentEdl, playbackUrlTtl, queueRender, type ServerContext } from "@slot1/services";
import { badRequest, conflict, notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

const IdParam = z.object({ id: z.string().uuid() });

/** Remove a library item's own files (they live under the library prefix, outside sessions). */
async function purgeItemFiles(ctx: ServerContext, item: LibraryItemRow) {
  if (item.kind === "render" || item.kind === "screenshot") {
    await ctx.storage.deletePrefix(storageKeys.libraryPrefix(item.broadcaster_id, item.id)).catch(() => 0);
    await ctx.db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE storage_key LIKE $1`, [`${storageKeys.libraryPrefix(item.broadcaster_id, item.id)}/%`]);
  }
}

/** Creator deleted everything: library files go too. */
export async function deleteWholeLibrary(ctx: ServerContext, broadcasterId: string) {
  for (const item of await listLibraryItems(ctx.db, broadcasterId, { limit: 10_000 })) {
    await purgeItemFiles(ctx, item);
    await deleteLibraryItem(ctx.db, item.id);
  }
  await ctx.db.query(`DELETE FROM edit_projects WHERE broadcaster_id = $1`, [broadcasterId]);
}

/**
 * Who may see a library item: the owner always; others only shared (public or unlisted), ready
 * items of a public channel. Making the channel private hides everything at once.
 */
async function itemVisible(ctx: ServerContext, req: FastifyRequest, item: LibraryItemRow): Promise<boolean> {
  if (isOwner(req.auth.viewer, item.broadcaster_id)) return true;
  if (item.status !== "ready" || item.visibility === "private") return false;
  return (await getSettings(ctx.db, item.broadcaster_id)).visibility === "public";
}

async function ownedSession(ctx: ServerContext, b: BroadcasterRow, id: string): Promise<StreamSessionRow> {
  const s = await getSession(ctx.db, id);
  if (!s || s.broadcaster_id !== b.id) throw notFound("Session not found");
  return s;
}

/** Playback info for a session's stored media (upload or finalized recording). */
async function playbackFor(ctx: ServerContext, session: StreamSessionRow) {
  const src = (await listSources(ctx.db, session.broadcaster_id)).find(
    (s) => s.session_id === session.id && (s.kind === "upload" || s.kind === "recording") && s.playback_asset_id,
  );
  if (!src?.playback_asset_id) return null;
  const [a] = await getAssets(ctx.db, [src.playback_asset_id]);
  if (!a || a.deleted_at) return null;
  const poster = (
    await ctx.db.query<{ storage_key: string; content_type: string }>(
      `SELECT storage_key, content_type FROM evidence_assets WHERE source_id = $1 AND kind = 'thumbnail' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [src.id],
    )
  ).rows[0];
  const ttl = playbackUrlTtl(ctx.config);
  return {
    url: await ctx.storage.signedGetUrl(a.storage_key, ttl, a.content_type),
    posterUrl: poster ? await ctx.storage.signedGetUrl(poster.storage_key, ttl, poster.content_type) : null,
    durationMs: src.probe?.durationMs ?? null,
    width: src.probe?.width ?? null,
    height: src.probe?.height ?? null,
  };
}

async function projectView(ctx: ServerContext, req: FastifyRequest, id: string): Promise<ProjectView> {
  const b = requireBroadcaster(req);
  const p = await getProject(ctx.db, id);
  if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
  const edl = Edl.parse(p.edl);
  const sources: ProjectSourceView[] = [];
  for (const sessionId of [...new Set(edl.segments.map((s) => s.sessionId))]) {
    const session = await getSession(ctx.db, sessionId);
    if (!session || session.broadcaster_id !== b.id) continue;
    const pb = await playbackFor(ctx, session);
    const obs = await listObservations(ctx.db, session.id, { limit: 1000, includeRejected: false });
    const markers = obs
      .filter((o) => o.mediaStartMs !== null && o.origin !== "twitch" && !["session_coverage", "media_facts", "source_gap"].includes(o.type))
      .map((o) => {
        const big = bigMoment(o);
        return { ms: o.mediaStartMs!, label: big ? big.text : o.description.slice(0, 80), kind: big ? ("big" as const) : o.rawText ? ("text" as const) : ("event" as const) };
      });
    const captionLines = Number((await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM transcripts WHERE session_id = $1`, [session.id])).rows[0]?.n ?? 0);
    sources.push({
      sessionId: session.id,
      title: session.title ?? "Untitled session",
      playbackUrl: pb?.url ?? null,
      posterUrl: pb?.posterUrl ?? null,
      durationMs: pb?.durationMs ?? null,
      width: pb?.width ?? null,
      height: pb?.height ?? null,
      markers,
      captionLines,
    });
  }
  const renders = await Promise.all(
    (await listLibraryItems(ctx.db, b.id, { projectId: p.id, limit: 10 })).map((r) => libraryItemView(ctx, r, { canView: true, canEdit: true })),
  );
  return { id: p.id, title: p.title, origin: p.origin, edl, updatedAt: iso(p.updated_at)!, sources, renders };
}

/** Copy an existing stored image (evidence or latest live frame) into the library. */
async function copyImageToLibrary(ctx: ServerContext, b: BroadcasterRow, assetId: string, title: string, sessionId: string | null, mediaMs: number | null): Promise<LibraryItemRow> {
  const a = await getAsset(ctx.db, assetId);
  if (!a || a.broadcaster_id !== b.id || a.deleted_at || !a.content_type.startsWith("image/")) throw notFound("Frame not found");
  const item = await insertLibraryItem(ctx.db, { broadcasterId: b.id, kind: "screenshot", title, status: "processing", sessionId, mediaMs });
  const obj = await ctx.storage.getStream(a.storage_key);
  const chunks: Buffer[] = [];
  for await (const c of obj.stream) chunks.push(c as Buffer);
  const ext = a.content_type === "image/png" ? "png" : a.content_type === "image/webp" ? "webp" : "jpg";
  const key = storageKeys.library(b.id, item.id, `screenshot.${ext}`);
  const { bytes } = await ctx.storage.putBuffer(key, Buffer.concat(chunks), a.content_type);
  const copy = await insertAsset(ctx.db, { broadcasterId: b.id, sessionId: null, sourceId: null, kind: "screenshot", storageKey: key, contentType: a.content_type, bytes, width: a.width, height: a.height, mediaPtsMs: mediaMs });
  return (await updateLibraryItem(ctx.db, item.id, { status: "ready", assetId: copy.id, width: a.width, height: a.height, bytes }))!;
}

export const libraryRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /* ------------------------------------ Library ------------------------------------------ */

    app.get("/api/library", async (req): Promise<LibraryResponse> => {
      const b = requireBroadcaster(req);
      const f = z.object({ kind: LibraryItemKind.optional(), visibility: LibraryVisibility.optional() }).parse(req.query);
      const rows = await listLibraryItems(ctx.db, b.id, f);
      const items = await Promise.all(rows.map((r) => libraryItemView(ctx, r, { canView: true, canEdit: true })));
      return { items, usage: await storageUsage(ctx.db, b.id) };
    });

    app.get("/api/library/:id", async (req): Promise<{ item: LibraryItemView; channel: { login: string; displayName: string } }> => {
      const { id } = IdParam.parse(req.params);
      const item = await getLibraryItem(ctx.db, id);
      if (!item || !(await itemVisible(ctx, req, item))) throw notFound("Not found");
      const owner = isOwner(req.auth.viewer, item.broadcaster_id);
      const b = (await getBroadcaster(ctx.db, item.broadcaster_id))!;
      return { item: await libraryItemView(ctx, item, { canView: true, canEdit: owner }), channel: { login: b.login, displayName: b.display_name } };
    });

    /** Stable poster for link previews (public and unlisted items only; no expiring signature). */
    app.get("/api/library/:id/poster", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const item = await getLibraryItem(ctx.db, id);
      // Link previews are fetched without cookies: only items anyone may see have a poster here.
      if (!item || item.visibility === "private" || !(await itemVisible(ctx, req, item))) throw notFound("Not found");
      const assetId = item.poster_asset_id ?? (item.kind === "screenshot" ? item.asset_id : null);
      const a = assetId ? await getAsset(ctx.db, assetId) : null;
      if (!a || a.deleted_at) throw notFound("Not found");
      const obj = await ctx.storage.getStream(a.storage_key);
      reply.header("content-type", a.content_type).header("cache-control", "public, max-age=300").header("x-content-type-options", "nosniff");
      return reply.send(obj.stream);
    });

    app.patch("/api/library/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const patch = LibraryItemPatch.parse(req.body);
      const item = await getLibraryItem(ctx.db, id);
      if (!item || item.broadcaster_id !== b.id) throw notFound("Not found");
      if (patch.visibility && patch.visibility !== "private" && item.status !== "ready") throw conflict("Only finished items can be shared");
      const row = (await updateLibraryItem(ctx.db, id, patch))!;
      return libraryItemView(ctx, row, { canView: true, canEdit: true });
    });

    app.delete("/api/library/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const item = await getLibraryItem(ctx.db, id);
      if (!item || item.broadcaster_id !== b.id) throw notFound("Not found");
      if (item.kind === "recording" && item.recording_id) {
        // Deleting a recording removes its file; the session's analysis log stays.
        const rec = await getRecording(ctx.db, item.recording_id);
        if (rec?.source_id) {
          const { rows } = await ctx.db.query<{ storage_key: string }>(`SELECT storage_key FROM evidence_assets WHERE source_id = $1 AND deleted_at IS NULL`, [rec.source_id]);
          for (const r of rows) await ctx.storage.delete(r.storage_key).catch(() => undefined);
          await ctx.db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE source_id = $1`, [rec.source_id]);
          await ctx.db.query(`UPDATE media_sources SET status = 'deleted', original_asset_id = NULL, playback_asset_id = NULL WHERE id = $1`, [rec.source_id]);
        }
        if (rec) await setRecordingStatus(ctx.db, rec.id, "expired", "Deleted by the creator");
      }
      await purgeItemFiles(ctx, item);
      await deleteLibraryItem(ctx.db, item.id);
      return { ok: true };
    });

    /* ----------------------------------- Screenshots --------------------------------------- */

    app.post("/api/library/screenshots", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<LibraryItemView> => {
      const b = requireBroadcaster(req);
      const input = ScreenshotInput.parse(req.body);
      if (input.from === "evidence") {
        const o = await getObservation(ctx.db, input.observationId);
        if (!o || o.broadcasterId !== b.id) throw notFound("Observation not found");
        const assetId = input.assetId ?? o.evidence.find((e) => e.kind === "frame")?.assetId;
        if (!assetId || !o.evidence.some((e) => e.assetId === assetId)) throw badRequest("That observation has no evidence frame");
        const ev = o.evidence.find((e) => e.assetId === assetId)!;
        const row = await copyImageToLibrary(ctx, b, assetId, input.title ?? o.description.slice(0, 120), o.sessionId, ev.mediaPtsMs);
        return libraryItemView(ctx, row, { canView: true, canEdit: true });
      }
      const session = await ownedSession(ctx, b, input.sessionId);
      if (input.from === "live") {
        const live = (await listSources(ctx.db, b.id)).filter((s) => s.session_id === session.id && s.kind === "live_ingest");
        const { rows } = await ctx.db.query<{ last_frame_asset_id: string | null }>(
          `SELECT last_frame_asset_id FROM source_health WHERE source_id = ANY($1::uuid[]) AND last_frame_asset_id IS NOT NULL ORDER BY last_frame_at DESC NULLS LAST LIMIT 1`,
          [live.map((s) => s.id)],
        );
        const assetId = rows[0]?.last_frame_asset_id;
        if (!assetId) throw conflict("No live frame has arrived yet");
        const row = await copyImageToLibrary(ctx, b, assetId, input.title ?? `Live screenshot ${new Date().toISOString().slice(11, 19)}`, session.id, null);
        return libraryItemView(ctx, row, { canView: true, canEdit: true });
      }
      if (!(await playbackFor(ctx, session))) throw conflict("This session has no stored video", "Upload the recording, or turn on Recording for live streams");
      const item = await insertLibraryItem(ctx.db, { broadcasterId: b.id, kind: "screenshot", title: input.title ?? `Screenshot ${formatMediaTime(input.atMs)}`, status: "processing", sessionId: session.id, mediaMs: input.atMs });
      await ctx.enqueue(QUEUES.library, "screenshot", { itemId: item.id, sessionId: session.id, atMs: input.atMs }, { jobId: `shot-${item.id}`, attempts: 2 });
      return libraryItemView(ctx, item, { canView: true, canEdit: true });
    });

    /* ------------------------------------ Projects ----------------------------------------- */

    app.get("/api/projects", async (req) => {
      const b = requireBroadcaster(req);
      const rows = await listProjects(ctx.db, b.id);
      return { projects: rows.map((p) => ({ id: p.id, title: p.title, origin: p.origin, updatedAt: iso(p.updated_at)!, segments: (p.edl.segments ?? []).length })) };
    });

    app.post("/api/projects", async (req) => {
      const b = requireBroadcaster(req);
      const input = CreateProjectInput.parse(req.body);
      const session = await ownedSession(ctx, b, input.sessionId);
      const pb = await playbackFor(ctx, session);
      if (!pb) throw conflict("This session has no stored video to edit", "Upload the recording, or turn on Recording for live streams");
      const outMs = pb.durationMs ? Math.min(input.outMs, pb.durationMs) : input.outMs;
      const inMs = Math.max(0, Math.min(input.inMs, outMs - 1000));
      const edl = momentEdl(session.id, inMs, outMs, { aspect: input.aspect ?? "9:16" });
      const p = await createProject(ctx.db, { broadcasterId: b.id, title: input.title ?? `Clip from ${session.title ?? "session"}`.slice(0, 120), origin: "manual", edl, userId: req.auth.user?.id ?? null });
      return { id: p!.id };
    });

    app.get("/api/projects/:id", async (req): Promise<ProjectView> => projectView(ctx, req, IdParam.parse(req.params).id));

    app.patch("/api/projects/:id", async (req): Promise<ProjectView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const patch = ProjectPatch.parse(req.body);
      const p = await getProject(ctx.db, id);
      if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
      if (patch.edl) for (const s of patch.edl.segments) await ownedSession(ctx, b, s.sessionId);
      await updateProject(ctx.db, id, patch);
      return projectView(ctx, req, id);
    });

    app.delete("/api/projects/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const p = await getProject(ctx.db, id);
      if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
      await deleteProject(ctx.db, id);
      return { ok: true };
    });

    app.post("/api/projects/:id/render", { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req): Promise<LibraryItemView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const p = await getProject(ctx.db, id);
      if (!p || p.broadcaster_id !== b.id) throw notFound("Edit not found");
      const edl = Edl.parse(p.edl);
      // Refuse up front when a segment's video is gone, instead of queueing a render that can't work.
      for (const [i, s] of edl.segments.entries()) {
        const session = await getSession(ctx.db, s.sessionId);
        if (!session || session.broadcaster_id !== b.id || session.delete_requested_at) {
          throw conflict(`Segment ${i + 1}'s session no longer exists`, "Remove that segment, or delete this edit");
        }
        if (!s.runId && !(await playbackFor(ctx, session))) throw conflict(`Segment ${i + 1}'s video is no longer stored`, "Retention or deletion removed it; remove that segment");
      }
      const active = Number((await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM library_items WHERE broadcaster_id = $1 AND status = 'processing' AND kind = 'render'`, [b.id])).rows[0]?.n ?? 0);
      if (active >= 4) throw conflict("Four renders are already running. Wait for one to finish");
      const item = await queueRender(ctx, { broadcasterId: b.id, projectId: p.id, title: p.title, sessionId: edl.segments[0]!.sessionId });
      return libraryItemView(ctx, item, { canView: true, canEdit: true });
    });

    /* ------------------------------------ Profiles ----------------------------------------- */

    app.get("/api/profiles/:login", async (req): Promise<ProfileResponse> => {
      const { login } = z.object({ login: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/) }).parse(req.params);
      const b = await getBroadcasterByLogin(ctx.db, login);
      if (!b || hiddenDemo(ctx.config, b)) throw notFound("Creator not found");
      const settings = await getSettings(ctx.db, b.id);
      const owner = isOwner(req.auth.viewer, b.id);
      // A private channel has no public profile; its owner still sees a preview.
      if (settings.visibility !== "public" && !owner) throw notFound("Creator not found");
      const rows = await listLibraryItems(ctx.db, b.id, { publicOnly: true, limit: 120 });
      const views = await Promise.all(rows.map((r) => libraryItemView(ctx, r, { canView: true, canEdit: false })));
      const current = await getCurrentLiveSession(ctx.db, b.id);
      // Same rule as the ON AIR directory: only a session anonymous viewers may already see.
      const live = current && !current.ended_at && canViewSession(ANONYMOUS, current, settings) ? current : null;
      return {
        channel: { login: b.login, displayName: b.display_name, avatarUrl: b.avatar_url, twitchUrl: b.kind === "twitch" ? `https://www.twitch.tv/${b.login}` : null },
        live: live ? { watchPath: `/watch/${b.login}`, title: live.title } : null,
        viewer: { isOwner: owner, channelPublic: settings.visibility === "public" },
        featured: views.filter((v) => v.featured),
        clips: views.filter((v) => v.kind === "render" || v.kind === "clip_export" || v.kind === "twitch_clip"),
        recordings: views.filter((v) => v.kind === "recording"),
        screenshots: views.filter((v) => v.kind === "screenshot"),
      };
    });
  };
