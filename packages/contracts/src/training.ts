import { z } from "zod";
import { GtaBox, GtaEvent, GtaScene } from "./gta-taxonomy";
import { SourceLabel } from "./enums";

export const TrainingLabelSource = z.enum(["auto_ocr", "auto_measure", "model", "creator", "labeler"]);
export type TrainingLabelSource = z.infer<typeof TrainingLabelSource>;

export const NormalizedBox = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, { message: "Box must stay inside the frame" });
export type NormalizedBox = z.infer<typeof NormalizedBox>;

export const BoxLabelInput = z
  .object({
    class: GtaBox,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, { message: "Box must stay inside the frame" });
export type BoxLabelInput = z.infer<typeof BoxLabelInput>;

export const TrainingLabelView = z.object({
  id: z.string(),
  kind: z.enum(["scene", "event", "box"]),
  class: z.string(),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  source: TrainingLabelSource,
  status: z.enum(["proposed", "accepted", "rejected"]),
  /** Reported by OCR or a model, uncalibrated. Null for human labels. */
  confidence: z.number().nullable(),
  evidenceText: z.string().nullable(),
});
export type TrainingLabelView = z.infer<typeof TrainingLabelView>;

export const TrainingFrameView = z.object({
  id: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string().nullable(),
  sourceLabel: SourceLabel,
  mediaPtsMs: z.number().nullable(),
  imageUrl: z.string(),
  width: z.number(),
  height: z.number(),
  status: z.enum(["unlabeled", "labeled", "skipped"]),
  createdAt: z.string(),
  labels: z.array(TrainingLabelView),
});
export type TrainingFrameView = z.infer<typeof TrainingFrameView>;

export const SubmitLabelsInput = z
  .object({
    /** Skip a frame that can't be labeled (corrupt, not GTA, unreadable). */
    skip: z.boolean().optional(),
    scene: GtaScene.nullable().optional(),
    events: z.array(GtaEvent).max(GtaEvent.options.length).default([]),
    boxes: z.array(BoxLabelInput).max(60).default([]),
  })
  .strict()
  .refine((v) => v.skip === true || Boolean(v.scene), { message: "Pick a scene, or skip the frame" });
export type SubmitLabelsInput = z.infer<typeof SubmitLabelsInput>;

export const ModelEvaluation = z.object({
  datasetVersionId: z.string(),
  datasetVersion: z.number().int().optional(),
  /** sha256 of the sorted test frame ids: models are only compared on identical test sets. */
  testSplitHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** "macro_f1" for scene models, "map50" for detectors. Higher is better. */
  primaryMetric: z.enum(["macro_f1", "map50"]),
  value: z.number().min(0).max(1),
  accuracy: z.number().min(0).max(1).optional(),
  testFrames: z.number().int().nonnegative(),
  perClass: z.record(z.string(), z.object({ precision: z.number(), recall: z.number(), f1: z.number(), support: z.number() })).optional(),
  evaluatedAt: z.string(),
});
export type ModelEvaluation = z.infer<typeof ModelEvaluation>;

/** Metadata the training scripts write next to the .onnx file (ml/README.md). */
export const ModelUploadMetadata = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  task: z.enum(["scene", "detector"]),
  taxonomyVersion: z.number().int(),
  classes: z.object({ scenes: z.array(z.string()).optional(), events: z.array(z.string()).optional(), boxes: z.array(z.string()).optional() }),
  input: z.object({
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mean: z.array(z.number()).length(3),
    std: z.array(z.number()).length(3),
    /** true: [1,3,H,W] (classifiers). false: [3,H,W] (torchvision detectors). */
    batched: z.boolean().default(true),
  }),
  /** Role → ONNX output name, e.g. { scene: "scene_logits", events: "event_logits" } or { boxes, scores, labels }. */
  outputs: z.record(z.string(), z.string()),
  /** Publish thresholds (model-reported scores). Defaults: scene 0.6, event 0.6, box 0.5. */
  thresholds: z.object({ scene: z.number().min(0).max(1), event: z.number().min(0).max(1), box: z.number().min(0).max(1) }).partial().optional(),
  datasetVersionId: z.string().nullable(),
  metrics: z.array(ModelEvaluation).min(1, "Upload at least one evaluation on a dataset test split"),
});
export type ModelUploadMetadata = z.infer<typeof ModelUploadMetadata>;

export const ModelView = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  task: z.enum(["scene", "detector"]),
  status: z.enum(["candidate", "active", "retired"]),
  taxonomyVersion: z.number(),
  metrics: z.array(ModelEvaluation),
  datasetVersion: z.number().nullable(),
  bytes: z.number(),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
});
export type ModelView = z.infer<typeof ModelView>;

export const DatasetVersionView = z.object({
  id: z.string(),
  version: z.number(),
  taxonomyVersion: z.number(),
  testSplitHash: z.string(),
  counts: z.object({
    frames: z.number(),
    channels: z.number(),
    sessions: z.number(),
    splits: z.object({ train: z.number(), val: z.number(), test: z.number() }),
    scenes: z.record(z.string(), z.number()),
    events: z.record(z.string(), z.number()),
    boxes: z.record(z.string(), z.number()),
  }),
  createdAt: z.string(),
});
export type DatasetVersionView = z.infer<typeof DatasetVersionView>;

export const TrainingOverview = z.object({
  consent: z.boolean(),
  counts: z.object({ frames: z.number(), unlabeled: z.number(), labeled: z.number(), skipped: z.number(), proposals: z.number() }),
  activeModels: z.array(ModelView),
  /** Datasets and the model registry are deployment-wide: only SLOT1 operators manage them. */
  operator: z
    .object({
      datasets: z.array(DatasetVersionView),
      models: z.array(ModelView),
      consentingChannels: z.number(),
      acceptedFrames: z.number(),
    })
    .nullable(),
});
export type TrainingOverview = z.infer<typeof TrainingOverview>;

/* ------------------------------------------------------------------------------------------ */
/* Pure rules shared by the API, worker and tests                                              */
/* ------------------------------------------------------------------------------------------ */

/** FNV-1a 32-bit: stable, dependency-free (runs in the browser too). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Which split a session's frames belong to. Splitting by SESSION (never by frame) keeps
 * near-identical neighbouring frames out of both train and test. With a fixed seed a session
 * never changes split, so the test set is frozen across dataset versions (it only grows).
 */
export function splitForSession(seed: string, sessionId: string): "train" | "val" | "test" {
  const bucket = fnv1a(`${seed}:${sessionId}`) % 100;
  if (bucket < 15) return "test";
  if (bucket < 25) return "val";
  return "train";
}

export interface ActivationDecision {
  allowed: boolean;
  reason: string;
  comparedOn: string | null;
  candidateValue: number | null;
  activeValue: number | null;
}

/**
 * A candidate may replace the active model only if, on the SAME test split, its primary metric is
 * at least as good. Without a shared test split the comparison is meaningless, so it's refused.
 */
export function decideActivation(candidate: ModelEvaluation[], active: ModelEvaluation[] | null, minTestFrames = 1): ActivationDecision {
  const usable = candidate.filter((e) => e.testFrames >= minTestFrames);
  if (usable.length === 0) return { allowed: false, reason: "The candidate has no evaluation on a dataset test split", comparedOn: null, candidateValue: null, activeValue: null };
  if (!active) {
    const best = usable.reduce((a, b) => (b.value > a.value ? b : a));
    return { allowed: true, reason: "No model is active for this task yet", comparedOn: best.testSplitHash, candidateValue: best.value, activeValue: null };
  }
  // Prefer the largest shared test set.
  const shared = usable
    .map((c) => ({ c, a: active.find((a) => a.testSplitHash === c.testSplitHash && a.primaryMetric === c.primaryMetric) }))
    .filter((p): p is { c: ModelEvaluation; a: ModelEvaluation } => Boolean(p.a))
    .sort((p, q) => q.c.testFrames - p.c.testFrames);
  const pair = shared[0];
  if (!pair) {
    return {
      allowed: false,
      reason: "The candidate and the active model were never evaluated on the same test split. Evaluate both on one dataset version (ml/eval.py), then upload the results.",
      comparedOn: null,
      candidateValue: usable[0]!.value,
      activeValue: null,
    };
  }
  const allowed = pair.c.value >= pair.a.value;
  return {
    allowed,
    reason: allowed
      ? `Candidate ${pair.c.primaryMetric} ${pair.c.value.toFixed(3)} ≥ active ${pair.a.value.toFixed(3)} on the same ${pair.c.testFrames}-frame test split`
      : `Candidate ${pair.c.primaryMetric} ${pair.c.value.toFixed(3)} is below the active model's ${pair.a.value.toFixed(3)} on the same test split`,
    comparedOn: pair.c.testSplitHash,
    candidateValue: pair.c.value,
    activeValue: pair.a.value,
  };
}
