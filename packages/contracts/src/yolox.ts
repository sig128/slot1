/**
 * YOLOX output decoding, shared by the worker (ONNX Runtime for Node) and viewers' browsers
 * (ONNX Runtime Web): the AI overlay's object finder, a small general-purpose detector (YOLOX,
 * Apache-2.0, trained on the COCO photo set). It isn't trained on GTA: it finds what looks like a
 * person, a vehicle or an animal, with a score, and nothing else. Pure, no dependencies.
 */

/** The COCO classes the overlay shows (YOLOX's 0-based COCO order), in plain words. */
export const OBJECT_LABELS: Readonly<Record<number, string>> = {
  0: "person",
  1: "bicycle",
  2: "car",
  3: "motorbike",
  4: "plane",
  5: "bus",
  6: "train",
  7: "truck",
  8: "boat",
  14: "bird",
  15: "cat",
  16: "dog",
  17: "horse",
  18: "sheep",
  19: "cow",
};
const CLASS_IDS = Object.keys(OBJECT_LABELS).map(Number);
const ANIMALS = new Set([14, 15, 16, 17, 18, 19]);
const CLASSES = 80;
const ROW = 5 + CLASSES;
const STRIDES = [8, 16, 32] as const;
/** YOLOX pads the letterboxed frame with this gray. */
export const YOLOX_PAD = 114;

export interface DetectedObject {
  label: string;
  /** Objectness × class score, 0..1. */
  score: number;
  /** Normalized [x, y, width, height] inside the frame (0..1). */
  box: [number, number, number, number];
}

export interface DecodeOptions {
  /** People and vehicles below this score are left out. */
  minScore: number;
  /** Animals need more: a general detector often reads a crouching person in a game as a dog. */
  animalMinScore: number;
  /** Boxes of one class overlapping more than this are the same object (non-maximum suppression). */
  iou: number;
  /** Boxes of any class overlapping more than this are one object seen two ways: the surer one stays. */
  anyIou: number;
  max: number;
}

export const DEFAULT_DECODE: DecodeOptions = { minScore: 0.3, animalMinScore: 0.55, iou: 0.45, anyIou: 0.7, max: 24 };

interface Candidate {
  cls: number;
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

function iou(a: Candidate, b: Candidate): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/** Rows YOLOX produces for a square input: one per grid cell of each stride. */
export function yoloxRows(input: number): number {
  return STRIDES.reduce((n, s) => n + (input / s) ** 2, 0);
}

/**
 * Turn YOLOX's raw output into boxes. Each row is [cx, cy, w, h, objectness, 80 class scores] for
 * one grid cell, scores already squashed to 0..1 and the box still relative to its cell. `scale`
 * is how much the frame was shrunk to fit the input (letterboxed at the top left). Pure.
 */
export function decodeYolox(out: Float32Array, input: number, scale: number, frameW: number, frameH: number, o: DecodeOptions = DEFAULT_DECODE): DetectedObject[] {
  if (out.length < yoloxRows(input) * ROW) throw new Error(`object model output too short: ${out.length} values for a ${input}px input`);
  const found: Candidate[] = [];
  let i = 0;
  for (const s of STRIDES) {
    const cells = input / s;
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++, i++) {
        const at = i * ROW;
        const objectness = out[at + 4]!;
        if (objectness < o.minScore) continue;
        let cls = -1;
        let score = 0;
        for (const k of CLASS_IDS) {
          const sc = objectness * out[at + 5 + k]!;
          if (sc > score) {
            score = sc;
            cls = k;
          }
        }
        if (cls < 0 || score < (ANIMALS.has(cls) ? o.animalMinScore : o.minScore)) continue;
        const cx = (out[at]! + gx) * s;
        const cy = (out[at + 1]! + gy) * s;
        const w = Math.exp(out[at + 2]!) * s;
        const h = Math.exp(out[at + 3]!) * s;
        found.push({ cls, score, x1: (cx - w / 2) / scale, y1: (cy - h / 2) / scale, x2: (cx + w / 2) / scale, y2: (cy + h / 2) / scale });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const c of found) {
    if (kept.length >= o.max) break;
    if (kept.some((k) => iou(k, c) > (k.cls === c.cls ? o.iou : o.anyIou))) continue;
    kept.push(c);
  }
  return kept.flatMap((k) => {
    const x1 = Math.max(0, Math.min(frameW, k.x1));
    const y1 = Math.max(0, Math.min(frameH, k.y1));
    const x2 = Math.max(0, Math.min(frameW, k.x2));
    const y2 = Math.max(0, Math.min(frameH, k.y2));
    if (x2 - x1 < 2 || y2 - y1 < 2) return [];
    return [{ label: OBJECT_LABELS[k.cls]!, score: r3(k.score), box: [r4(x1 / frameW), r4(y1 / frameH), r4((x2 - x1) / frameW), r4((y2 - y1) / frameH)] as [number, number, number, number] }];
  });
}

