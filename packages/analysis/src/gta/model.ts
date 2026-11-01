import {
  GTA_BOX_LABEL,
  GTA_BOX_OBSERVATION,
  GTA_EVENT_LABEL,
  GTA_EVENT_OBSERVATION,
  GTA_SCENE_LABEL,
  GTA_TEMPORAL_EVENTS,
  type EvidenceRef,
  type GtaBox,
  type GtaEvent,
  type GtaScene,
} from "@slot1/contracts";
import type { FrameRef } from "../candidates";
import type { Candidate } from "../fusion";

/** One frame's output from SLOT1's own GTA model(s). Scores are model-reported, uncalibrated. */
export interface FramePrediction {
  scene: { class: GtaScene; score: number; modelId: string } | null;
  events: { class: GtaEvent; score: number; modelId: string }[];
  boxes: { class: GtaBox; score: number; box: { x: number; y: number; w: number; h: number }; modelId: string }[];
  /** "slot1-gta" + versions, for the observation's model reference. */
  provider: string;
  version: string;
}

/**
 * A trained model behind the pipeline: ONNX Runtime in the worker, or the shared inference service.
 * `predict` resolves null when the frame was skipped (service busy, unreachable or without a
 * model); `skipReason` then says why. A skipped frame is never replaced by a guess.
 */
export interface FrameModel {
  readonly label: string;
  readonly thresholds: { scene: number; event: number; box: number };
  predict(jpeg: Buffer): Promise<FramePrediction | null>;
  readonly skipReason?: string | null;
}

const frameEvidence = (f: FrameRef): EvidenceRef => ({ assetId: f.assetId, kind: "frame", mediaPtsMs: f.ptsMs });

/**
 * Turns model predictions into observation candidates. Only confident outputs publish:
 * - the scene, when its score passes the threshold (never "other");
 * - single-frame screens (MISSION PASSED, WASTED…) as directly visible;
 * - temporal events only after two consecutive frames agree, labeled inferred, citing both frames;
 * - a few HUD/object boxes that mean something to viewers (wanted stars, vehicle, phone).
 * Everything below threshold stays out of the log and only feeds the labeling queue.
 */
export class GtaPredictionGate {
  private previous: { ref: FrameRef; events: Set<GtaEvent> } | null = null;

  constructor(private readonly thresholds: { scene: number; event: number; box: number }) {}

  candidates(p: FramePrediction, ref: FrameRef, nowIso: string): Candidate[] {
    const base = {
      origin: "video" as const,
      mediaStartMs: ref.ptsMs,
      mediaEndMs: ref.ptsMs,
      rawText: null,
      model: { provider: p.provider, version: p.version },
      relatedEntities: [],
      receivedAt: ref.receivedAt.toISOString(),
      analyzedAt: nowIso,
      capturedAt: ref.capturedAt?.toISOString() ?? null,
      minReadings: 1,
    };
    const out: Candidate[] = [];
    if (p.scene && p.scene.class !== "other" && p.scene.score >= this.thresholds.scene) {
      out.push({
        ...base,
        type: "environment",
        description: `Scene: ${GTA_SCENE_LABEL[p.scene.class]}`,
        interpretation: "directly_visible",
        evidence: [frameEvidence(ref)],
        modelConfidence: round(p.scene.score),
      });
    }
    const confidentEvents = new Set<GtaEvent>();
    for (const e of p.events) {
      if (e.score < this.thresholds.event) continue;
      confidentEvents.add(e.class);
      const map = GTA_EVENT_OBSERVATION[e.class];
      if (!GTA_TEMPORAL_EVENTS.has(e.class)) {
        out.push({ ...base, type: map.type, description: `${GTA_EVENT_LABEL[e.class]} screen`, interpretation: map.interpretation, evidence: [frameEvidence(ref)], modelConfidence: round(e.score) });
      } else if (this.previous?.events.has(e.class)) {
        out.push({
          ...base,
          type: map.type,
          description: `Likely ${GTA_EVENT_LABEL[e.class].toLowerCase()}`,
          interpretation: "inferred",
          mediaStartMs: this.previous.ref.ptsMs,
          evidence: [frameEvidence(this.previous.ref), frameEvidence(ref)],
          modelConfidence: round(e.score),
        });
      }
    }
    for (const b of p.boxes) {
      const type = GTA_BOX_OBSERVATION[b.class];
      if (!type || b.score < this.thresholds.box) continue;
      out.push({
        ...base,
        type,
        description: `${GTA_BOX_LABEL[b.class]} on screen`,
        interpretation: "directly_visible",
        evidence: [frameEvidence(ref)],
        modelConfidence: round(b.score),
      });
    }
    this.previous = { ref, events: confidentEvents };
    return out;
  }
}

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;

/** How unsure the model was about this frame (0 = sure, 1 = clueless): drives review order. */
export function predictionUncertainty(p: FramePrediction | null): number {
  if (!p || !p.scene) return 0.5;
  return Math.max(0, Math.min(1, 1 - p.scene.score));
}
