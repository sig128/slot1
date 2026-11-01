import type { FrameInsight } from "@slot1/analysis";
import { AiViewSnapshot, type AiViewRegion, type SourceLabel } from "@slot1/contracts";
import type { ServerContext } from "./context";

/**
 * "What the AI sees": the worker that analyzes a live stream stores a small snapshot of the
 * last analyzed frame in Redis (with a short TTL); the API serves it to whoever may watch the
 * session. Nothing here is persisted: when analysis stops, the snapshot simply expires.
 */
export const AI_VIEW_TTL_SEC = 60;
/** Frame images outlive their snapshot a little, so a client that just read it can still fetch it. */
export const AI_VIEW_FRAME_TTL_SEC = 90;
export const AI_VIEW_REFRESH_MS = 2000;
/** Width of the stored copy of the analyzed frame (the analysis itself used the full frame). */
export const AI_VIEW_FRAME_WIDTH = 640;

export const aiViewKeys = {
  meta: (sessionId: string) => `slot1:aiview:${sessionId}`,
  frame: (sessionId: string, snapshotId: string) => `slot1:aiview:${sessionId}:f:${snapshotId}`,
  /** Set while somebody has the AI view open; workers only store snapshots then. */
  watched: (sessionId: string) => `slot1:aiview:${sessionId}:watched`,
};
/** How long one look at the AI view keeps snapshots coming without another poll. */
export const AI_VIEW_WATCH_TTL_SEC = 30;

/** Plain-words names for the OCR regions of the game profiles (packages/analysis/src/profiles.ts). */
export const REGION_LABELS: Record<string, string> = {
  bottom_center: "Subtitles and objectives",
  center_banner: "Title cards and result screens",
  bottom_right_area: "Area name",
  top_right_hud: "Cash readout",
  full: "Whole frame (any legible text)",
};

export interface AiViewContext {
  sessionId: string;
  label: SourceLabel;
  demo: boolean;
  intervalMs: number;
  measuredCadenceMs: number | null;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const box = (b: readonly number[] | undefined | null): [number, number, number, number] | null =>
  b && b.length === 4 ? [round(b[0]!), round(b[1]!), round(b[2]!), round(b[3]!)] : null;

/** Turn what the pipeline did with one frame into the public snapshot shape. Pure. */
export function buildAiViewSnapshot(
  id: string,
  c: AiViewContext,
  i: FrameInsight,
  /** The stored copy's size, and the size the frame was analyzed at. */
  image: { width: number; height: number; analyzedWidth: number; analyzedHeight: number },
): AiViewSnapshot {
  const regions: AiViewRegion[] = i.profile.regions.map((r) => ({
    id: r.id,
    label: REGION_LABELS[r.id] ?? r.id.replace(/_/g, " "),
    box: box(r.box)!,
    readings: i.ocr.lines
      .filter((l) => l.regionId === r.id)
      .map((l) => ({ text: l.text, confidence: Math.round(l.confidence * 10) / 10, type: l.type, box: box(l.bbox) })),
  }));
  const p = i.model.prediction;
  const top: { label: string; p: number }[] = [];
  if (p?.scene) top.push({ label: `scene: ${p.scene.class}`, p: round(p.scene.score, 3) });
  for (const e of p?.events ?? []) top.push({ label: `event: ${e.class}`, p: round(e.score, 3) });
  for (const b of p?.boxes ?? []) top.push({ label: `object: ${b.class}`, p: round(b.score, 3) });
  top.sort((a, b) => b.p - a.p);

  const v = i.vision;
  const findings = (v.result?.analysis.findings ?? []).slice(0, 8).map((f) => ({ type: f.type, description: f.description, confidence: f.confidence }));
  let visionNote = v.note;
  if (!v.enabled) visionNote = c.demo ? "Paid AI vision is off for the demo stream: only OCR (and SLOT1's own model, once one is active) looks at it" : "No AI vision provider is configured on this server";
  else if (v.state === "batching") visionNote = `Waiting for ${v.batch.need - v.batch.have} more frame${v.batch.need - v.batch.have === 1 ? "" : "s"} to send a batch`;

  return AiViewSnapshot.parse({
    id,
    sessionId: c.sessionId,
    frame: {
      url: `/api/sessions/${c.sessionId}/ai-view/frame/${id}`,
      width: image.width,
      height: image.height,
      analyzedWidth: image.analyzedWidth,
      analyzedHeight: image.analyzedHeight,
      mediaMs: Number.isFinite(i.frame.ptsMs) ? i.frame.ptsMs : null,
      capturedAt: i.frame.capturedAt ? i.frame.capturedAt.toISOString() : null,
      receivedAt: i.frame.receivedAt.toISOString(),
      analyzedAt: i.analyzedAt.toISOString(),
    },
    latencyMs: Math.max(0, i.analyzedAt.getTime() - i.frame.receivedAt.getTime()),
    sampling: { intervalMs: c.intervalMs, measuredCadenceMs: c.measuredCadenceMs },
    ocr: {
      status: !i.ocr.enabled ? "off" : i.ocr.error ? "error" : "read",
      engine: i.ocr.engine,
      profile: { id: i.profile.id, name: i.profile.name, validation: i.profile.validation },
      regions,
      durationMs: i.ocr.durationMs,
      note: !i.ocr.enabled ? "OCR isn't available on this server (tesseract not installed)" : i.ocr.error ? `OCR failed on this frame: ${i.ocr.error.slice(0, 160)}` : null,
    },
    vision: {
      status: v.state,
      provider: v.provider,
      model: v.model,
      summary: v.result?.analysis.scene.summary || null,
      findings,
      note: visionNote,
    },
    gtaModel: {
      status: !i.model.enabled ? "none" : i.model.error ? "error" : p ? "predicted" : "skipped",
      label: i.model.label,
      top: top.slice(0, 5),
      note: !i.model.enabled
        ? "No trained GTA model is active yet, so only OCR (and AI vision, when configured) look at the frames"
        : i.model.error
          ? `The model failed on this frame: ${i.model.error.slice(0, 160)}`
          : p
            ? null
            : `Skipped this frame: ${i.model.skipped ?? "the model was busy"}`,
    },
    produced: i.produced.slice(0, 12),
    source: { label: c.label, demo: c.demo },
  });
}

/** Someone is looking at this session's AI view (called by the API on every poll). */
export async function markAiViewWatched(ctx: Pick<ServerContext, "redis">, sessionId: string): Promise<void> {
  await ctx.redis.set(aiViewKeys.watched(sessionId), "1", "EX", AI_VIEW_WATCH_TTL_SEC);
}

/** Whether a worker should store snapshots for this session right now. */
export async function aiViewWatched(ctx: Pick<ServerContext, "redis">, sessionId: string): Promise<boolean> {
  return (await ctx.redis.exists(aiViewKeys.watched(sessionId))) === 1;
}

/** The latest snapshot for a session, or null when nothing was analyzed in the last minute. */
export async function readAiView(ctx: Pick<ServerContext, "redis">, sessionId: string): Promise<AiViewSnapshot | null> {
  const raw = await ctx.redis.get(aiViewKeys.meta(sessionId));
  if (!raw) return null;
  try {
    const parsed = AiViewSnapshot.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readAiViewFrame(ctx: Pick<ServerContext, "redis">, sessionId: string, snapshotId: string): Promise<Buffer | null> {
  return ctx.redis.getBuffer(aiViewKeys.frame(sessionId, snapshotId));
}

/** Store a snapshot and its frame image (both expire on their own). */
export async function storeAiView(ctx: Pick<ServerContext, "redis">, snapshot: AiViewSnapshot, jpeg: Buffer): Promise<void> {
  await ctx.redis
    .multi()
    .set(aiViewKeys.frame(snapshot.sessionId, snapshot.id), jpeg, "EX", AI_VIEW_FRAME_TTL_SEC)
    .set(aiViewKeys.meta(snapshot.sessionId), JSON.stringify(snapshot), "EX", AI_VIEW_TTL_SEC)
    .exec();
}
