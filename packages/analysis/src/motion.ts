import sharp from "sharp";
import type { EvidenceRef } from "@slot1/contracts";
import type { FrameRef } from "./candidates";
import type { Candidate } from "./fusion";

/**
 * How much the picture changed since the previous sampled frame, measured on a 64×36 greyscale
 * copy (cheap: well under a millisecond of arithmetic per frame). Used to send frames to the vision
 * model only when something changed, and to flag sudden action: crashes, explosions, camera shake.
 * The camera mask is already blacked out in the frames, so a creator's webcam never counts.
 */
export interface FrameChange {
  /** Mean absolute difference, 0 (identical) to 1 (every pixel flipped). */
  diff: number;
  /** Much more change than this stream's recent normal: sudden action. */
  spike: boolean;
  /** The whole picture changed: a cut, a menu, a loading screen. */
  cut: boolean;
}

const W = 64;
const H = 36;

export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / (n * 255);
}

/** The motion rules, separate from image decoding so they can be tested on numbers alone. */
export class MotionRule {
  /** Recent typical change (moving average), so a busy chase and a quiet menu each get their own normal. */
  private baseline: number | null = null;

  next(diff: number): FrameChange {
    const base = this.baseline ?? diff;
    const cut = diff >= 0.32;
    const spike = !cut && this.baseline !== null && diff >= Math.max(0.1, base * 3);
    this.baseline = base * 0.85 + Math.min(diff, 0.25) * 0.15;
    return { diff, spike, cut };
  }
}

export class MotionMeter {
  private prev: Uint8Array | null = null;
  private readonly rule = new MotionRule();

  async measure(jpeg: Buffer): Promise<FrameChange> {
    const { data } = await sharp(jpeg).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const cur = new Uint8Array(data);
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return { diff: 0, spike: false, cut: false };
    return this.rule.next(frameDiff(prev, cur));
  }
}

/** A sudden-action entry for the live log: measured, so it says what was measured and nothing more. */
export function motionCandidate(change: FrameChange, frame: FrameRef, nowIso: string): Candidate {
  const evidence: EvidenceRef = { assetId: frame.assetId, kind: "frame", mediaPtsMs: frame.ptsMs };
  return {
    type: "movement",
    description: `Sudden action on screen: the picture changed ${Math.round(change.diff * 100)}% in a second`,
    origin: "video",
    interpretation: "inferred",
    mediaStartMs: frame.ptsMs,
    mediaEndMs: frame.ptsMs,
    evidence: [evidence],
    rawText: null,
    model: { provider: "slot1-motion", version: "1" },
    modelConfidence: null,
    relatedEntities: [],
    receivedAt: frame.receivedAt.toISOString(),
    analyzedAt: nowIso,
    capturedAt: frame.capturedAt?.toISOString() ?? null,
    minReadings: 1,
  };
}
