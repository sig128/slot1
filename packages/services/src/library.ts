import { bigMoment, Edl, type LibraryItemView, type Observation } from "@slot1/contracts";
import {
  createJobRun,
  createProject,
  findOverlappingAutoProject,
  getAssets,
  getJobRun,
  getSettings,
  insertLibraryItem,
  iso,
  updateLibraryItem,
  type LibraryItemRow,
  type StreamSessionRow,
} from "@slot1/db";
import { QUEUES } from "@slot1/platform";
import type { ServerContext } from "./context";
import { playbackUrlTtl } from "./views";

/** Library view with short-lived signed URLs, only when the caller may see the item. */
export async function libraryItemView(ctx: ServerContext, row: LibraryItemRow, opts: { canView: boolean; canEdit: boolean }): Promise<LibraryItemView> {
  const ids = [row.asset_id, row.poster_asset_id].filter((x): x is string => Boolean(x));
  const assets = opts.canView && ids.length ? await getAssets(ctx.db, ids) : [];
  const sign = async (id: string | null) => {
    const a = id ? assets.find((x) => x.id === id && !x.deleted_at) : undefined;
    // Videos get a playback-length link (players re-request ranges on seek); images the default.
    const ttl = a?.content_type.startsWith("video/") ? playbackUrlTtl(ctx.config) : ctx.config.env.MEDIA_URL_TTL_SECONDS;
    return a ? ctx.storage.signedGetUrl(a.storage_key, ttl, a.content_type) : null;
  };
  let progress: number | null = null;
  if (row.status === "processing" && row.job_run_id) progress = (await getJobRun(ctx.db, row.job_run_id))?.progress ?? null;
  const url = await sign(row.asset_id);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    visibility: row.visibility,
    featured: row.featured,
    status: row.status,
    error: row.error,
    progress,
    createdAt: iso(row.created_at)!,
    sessionId: row.session_id,
    recordingId: row.recording_id,
    projectId: row.project_id,
    auto: row.project_origin === "auto",
    mediaMs: row.media_ms,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    bytes: row.bytes,
    url,
    posterUrl: (await sign(row.poster_asset_id)) ?? (row.kind === "screenshot" ? url : null),
    externalUrl: row.external_url,
    viewPath: `/v/${row.id}`,
    canEdit: opts.canEdit,
  };
}

/** A one-segment edit around a moment: vertical, whole frame visible over a blurred backdrop. */
export function momentEdl(sessionId: string, inMs: number, outMs: number, opts: { runId?: string | null; text?: string | null; aspect?: Edl["aspect"] } = {}): Edl {
  const total = outMs - inMs;
  return Edl.parse({
    version: 1,
    aspect: opts.aspect ?? "9:16",
    layout: "fit",
    segments: [{ id: "s1", sessionId, runId: opts.runId ?? null, inMs, outMs, speed: 1, reframe: { x: 0.5, y: 0.5, zoom: 1 } }],
    texts: opts.text ? [{ id: "t1", text: opts.text, startMs: 0, endMs: Math.min(total, 3000), position: "top", style: "poster" }] : [],
    fadeInMs: 0,
    fadeOutMs: Math.min(400, Math.floor(total / 4)),
  });
}

/** Queue a render of a project into a new library item (status processing until done). */
export async function queueRender(
  ctx: ServerContext,
  p: { broadcasterId: string; projectId: string; title: string; sessionId: string | null; delayMs?: number },
): Promise<LibraryItemRow> {
  const item = await insertLibraryItem(ctx.db, { broadcasterId: p.broadcasterId, kind: "render", title: p.title, status: "processing", sessionId: p.sessionId, projectId: p.projectId });
  const job = await createJobRun(ctx.db, { broadcasterId: p.broadcasterId, sessionId: p.sessionId, queue: QUEUES.library, name: "render-project" });
  const row = (await updateLibraryItem(ctx.db, item.id, { jobRunId: job.id }))!;
  await ctx.enqueue(QUEUES.library, "render-project", { itemId: item.id, projectId: p.projectId, jobRunId: job.id }, { jobId: `render-${item.id}`, delay: p.delayMs ?? 0, attempts: 4 });
  return row;
}

/**
 * Auto clips: when SLOT1 reads a big result message on screen (MISSION PASSED, WASTED…), cut a
 * vertical clip around it. Opt-in per channel. Live sessions need Recording on (the clip is
 * rendered from recorded segments once the post-roll exists); replays render immediately.
 */
export async function maybeAutoClip(ctx: ServerContext, session: StreamSessionRow, o: Observation, runId: string | null): Promise<string | null> {
  const big = bigMoment(o);
  if (!big || o.mediaStartMs === null) return null;
  const settings = await getSettings(ctx.db, session.broadcaster_id);
  if (!settings.autoClips) return null;
  const live = session.kind !== "replay";
  if (live && !runId) return null;
  const inMs = Math.max(0, o.mediaStartMs - settings.autoClipPreRollMs);
  const outMs = o.mediaStartMs + settings.autoClipPostRollMs;
  const runKey = live ? runId : null;
  if (await findOverlappingAutoProject(ctx.db, { broadcasterId: session.broadcaster_id, sessionId: session.id, runId: runKey, title: big.text, inMs, outMs })) return null;
  const project = await createProject(ctx.db, {
    broadcasterId: session.broadcaster_id,
    title: big.text,
    origin: "auto",
    autoKey: `obs:${o.id}`,
    edl: momentEdl(session.id, inMs, outMs, { runId: live ? runId : null, text: big.text }),
    sourceObservationId: o.id,
  });
  if (!project) return null; // already clipped
  const item = await queueRender(ctx, {
    broadcasterId: session.broadcaster_id,
    projectId: project.id,
    title: big.text,
    sessionId: session.id,
    // Live: wait until the post-roll has been recorded and uploaded.
    delayMs: live ? settings.autoClipPostRollMs + 15_000 : 0,
  });
  return item.id;
}
