import { randomUUID } from "node:crypto";
import { predictionUncertainty, type FramePrediction, type SampledFrame, type WeakLabel } from "@slot1/analysis";
import {
  GTA_TAXONOMY_VERSION,
  gtaTaxonomy,
  type DatasetVersionView,
  type ModelView,
  type TrainingFrameView,
  type TrainingLabelView,
  type DetectedObject,
} from "@slot1/contracts";
import {
  countSessionTrainingFrames,
  getSettings,
  insertTrainingFrame,
  insertTrainingLabels,
  listFrameLabels,
  type DatasetVersionRow,
  type MediaSourceRow,
  type ModelRow,
  type NewTrainingLabel,
  type StreamSessionRow,
  type TrainingFrameRow,
  type TrainingLabelRow,
} from "@slot1/db";
import { storageKeys } from "@slot1/platform";
import type { ServerContext } from "./context";

/** One frame per this much media time, plus frames with something worth labeling. */
export const TRAINING_SAMPLE_INTERVAL_MS = 10_000;
export const TRAINING_INTERESTING_MIN_GAP_MS = 2_000;
export const TRAINING_MAX_FRAMES_PER_SESSION = 2_000;
/** Fixed for the deployment so a session never changes split between dataset versions. */
export const TRAINING_SPLIT_SEED = "slot1-gta-v1";
/** Model proposals below this are not worth showing a labeler. */
const PROPOSAL_MIN_SCORE = 0.3;

const VEHICLE_OBJECTS = new Set(["car", "truck", "bus", "motorbike", "bicycle", "boat", "plane", "train"]);
/** The GTA box class for an object finder label: people and vehicles are labeled; animals aren't (yet). */
function objectClass(label: string): "person" | "vehicle" | null {
  if (label === "person") return "person";
  return VEHICLE_OBJECTS.has(label) ? "vehicle" : null;
}
type Box = { x: number; y: number; w: number; h: number };
function iou(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * The object finder's people and vehicles in one frame, as box proposals a person confirms before
 * they count. Animals and unsure finds are left out, and a box already proposed for the same
 * thing (by SLOT1's own GTA model) isn't proposed twice.
 */
export function objectProposals(objects: { name: string; items: DetectedObject[] }, existing: readonly NewTrainingLabel[] = []): NewTrainingLabel[] {
  const out: NewTrainingLabel[] = [];
  for (const o of objects.items) {
    const cls = objectClass(o.label);
    if (!cls || o.score < PROPOSAL_MIN_SCORE) continue;
    const [x, y, w, h] = o.box;
    const box = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, 1 - Math.max(0, x)), h: Math.min(h, 1 - Math.max(0, y)) };
    if (box.w <= 0 || box.h <= 0) continue;
    if ([...existing, ...out].some((l) => l.kind === "box" && l.class === cls && l.box && iou(l.box, box) > 0.5)) continue;
    out.push({ kind: "box", class: cls, box, source: "model", confidence: o.score, evidenceText: `${objects.name}: ${o.label}` });
  }
  return out;
}

/** Read width/height from a baseline or progressive JPEG header (SOFn marker). */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * The training-pool side of the pipeline sink. Every live stream is kept for learning unless the
 * creator has switched it off (re-checked every 10 s, so switching it off stops collection
 * quickly), within per-session caps. TEST sources never enter the pool. Automatic labels and
 * model predictions are stored as proposals.
 */
export function createTrainingCollector(ctx: ServerContext, session: StreamSessionRow, source: MediaSourceRow) {
  let consent: { value: boolean; at: number } | null = null;
  let count: number | null = null;
  let lastPts = -Infinity;
  let lastInteresting = -Infinity;

  return async (input: { frame: SampledFrame; weakLabels: WeakLabel[]; prediction: FramePrediction | null; objects?: { name: string; items: DetectedObject[] } | null }): Promise<void> => {
    if (source.label === "test") return;
    const now = Date.now();
    if (!consent || now - consent.at > 10_000) consent = { value: (await getSettings(ctx.db, session.broadcaster_id)).trainingConsent, at: now };
    if (!consent.value) return;
    if (count === null) count = await countSessionTrainingFrames(ctx.db, session.id);
    if (count >= TRAINING_MAX_FRAMES_PER_SESSION) return;

    const { frame, weakLabels, prediction } = input;
    const uncertainty = prediction ? predictionUncertainty(prediction) : 0;
    // Scene cuts (transitions, black screens, menus) and frames with something to label come first.
    const interesting = weakLabels.length > 0 || uncertainty >= 0.4 || frame.reason === "scene";
    const due = frame.ptsMs - lastPts >= TRAINING_SAMPLE_INTERVAL_MS;
    if (!due && !(interesting && frame.ptsMs - lastInteresting >= TRAINING_INTERESTING_MIN_GAP_MS)) return;

    const size = frame.width && frame.height ? { width: frame.width, height: frame.height } : jpegSize(frame.jpeg);
    if (!size) return;
    const key = `${storageKeys.sessionPrefix(session.broadcaster_id, session.id)}/training/${randomUUID()}.jpg`;
    const { bytes } = await ctx.storage.putBuffer(key, frame.jpeg, "image/jpeg");
    const priority = weakLabels.length > 0 ? 1 + Math.max(...weakLabels.map((l) => l.confidence)) : uncertainty;
    const row = await insertTrainingFrame(ctx.db, {
      broadcasterId: session.broadcaster_id,
      sessionId: session.id,
      sourceId: source.id,
      // Recordings are never re-analyzed; their frames come from the live reader.
      sourceKind: source.kind === "recording" ? "live_ingest" : source.kind,
      sourceLabel: source.label,
      mediaPtsMs: frame.ptsMs,
      storageKey: key,
      width: size.width,
      height: size.height,
      bytes,
      priority,
    });
    const labels: NewTrainingLabel[] = weakLabels.map((l) => ({ kind: l.kind, class: l.class, box: l.box, source: l.source, confidence: l.confidence, evidenceText: l.evidenceText }));
    if (prediction?.scene && prediction.scene.score >= PROPOSAL_MIN_SCORE) {
      labels.push({ kind: "scene", class: prediction.scene.class, box: null, source: "model", confidence: prediction.scene.score, modelId: prediction.scene.modelId });
    }
    for (const e of prediction?.events ?? []) {
      if (e.score >= PROPOSAL_MIN_SCORE) labels.push({ kind: "event", class: e.class, box: null, source: "model", confidence: e.score, modelId: e.modelId });
    }
    for (const b of prediction?.boxes ?? []) {
      if (b.score >= PROPOSAL_MIN_SCORE) labels.push({ kind: "box", class: b.class, box: b.box, source: "model", confidence: b.score, modelId: b.modelId });
    }
    if (input.objects) labels.push(...objectProposals(input.objects, labels));
    await insertTrainingLabels(ctx.db, row.id, labels);
    count += 1;
    lastPts = frame.ptsMs;
    if (interesting) lastInteresting = frame.ptsMs;
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Views                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export function labelView(l: TrainingLabelRow): TrainingLabelView {
  return {
    id: l.id,
    kind: l.kind,
    class: l.class,
    box: l.kind === "box" ? { x: l.x!, y: l.y!, w: l.w!, h: l.h! } : null,
    source: l.source,
    status: l.status,
    confidence: l.confidence,
    evidenceText: l.evidence_text,
  };
}

export async function trainingFrameViews(ctx: ServerContext, frames: TrainingFrameRow[]): Promise<TrainingFrameView[]> {
  const labels = await listFrameLabels(ctx.db, frames.map((f) => f.id));
  const out: TrainingFrameView[] = [];
  for (const f of frames) {
    out.push({
      id: f.id,
      sessionId: f.session_id,
      sessionTitle: f.session_title ?? null,
      sourceLabel: f.source_label,
      mediaPtsMs: f.media_pts_ms === null ? null : Number(f.media_pts_ms),
      imageUrl: await ctx.storage.signedGetUrl(f.storage_key, ctx.config.env.MEDIA_URL_TTL_SECONDS, "image/jpeg"),
      width: f.width,
      height: f.height,
      status: f.status,
      createdAt: f.created_at.toISOString(),
      labels: labels.filter((l) => l.frame_id === f.id).map(labelView),
    });
  }
  return out;
}

export function datasetView(d: DatasetVersionRow): DatasetVersionView {
  return { id: d.id, version: d.version, taxonomyVersion: d.taxonomy_version, testSplitHash: d.test_split_hash, counts: d.counts, createdAt: d.created_at.toISOString() };
}

export function modelView(m: ModelRow): ModelView {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    task: m.task,
    status: m.status,
    taxonomyVersion: m.taxonomy_version,
    metrics: m.metrics,
    datasetVersion: m.dataset_version ?? null,
    bytes: Number(m.bytes),
    createdAt: m.created_at.toISOString(),
    activatedAt: m.activated_at?.toISOString() ?? null,
  };
}

export const modelStorageKey = (name: string, version: string) => `models/${name}/${version}.onnx`;

/** classes.json written into every dataset export and expected back in model metadata. */
export function datasetClassMap() {
  return { ...gtaTaxonomy(), version: GTA_TAXONOMY_VERSION };
}
