import * as ort from "onnxruntime-node";
import sharp from "sharp";

/**
 * SLOT1's object finder for the AI overlay: a small general-purpose detector (YOLOX, Apache-2.0,
 * trained on the COCO photo set) that puts boxes around people, vehicles and animals in a frame.
 * It isn't trained on GTA: it finds what looks like a person or a car, with a score, and nothing
 * else. Its boxes feed the overlay only; they never become log entries or training labels.
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
const PAD = 114;

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

/** The frame letterboxed into YOLOX's square input: top left, gray padding, BGR, 0..255, CHW. */
export async function yoloxInput(jpeg: Buffer, input: number): Promise<{ data: Float32Array; scale: number; width: number; height: number }> {
  const meta = await sharp(jpeg).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("frame has no size");
  const scale = Math.min(input / width, input / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { data: rgb } = await sharp(jpeg).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const plane = input * input;
  const data = new Float32Array(3 * plane).fill(PAD);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 3;
      const dst = y * input + x;
      data[dst] = rgb[src + 2]!; // B
      data[plane + dst] = rgb[src + 1]!; // G
      data[2 * plane + dst] = rgb[src]!; // R
    }
  }
  return { data, scale, width, height };
}

/** One loaded object model. Safe to share across streams in a process. */
export class ObjectDetector {
  private constructor(
    private readonly session: ort.InferenceSession,
    readonly name: string,
    readonly input: number,
  ) {}

  static async load(file: string, name: string): Promise<ObjectDetector> {
    const session = await ort.InferenceSession.create(file, { executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: 2 });
    const dims = (session.inputMetadata?.[0] as { shape?: (number | string)[] } | undefined)?.shape;
    const input = typeof dims?.[3] === "number" ? dims[3] : 416;
    return new ObjectDetector(session, name, input);
  }

  async detect(jpeg: Buffer, o: DecodeOptions = DEFAULT_DECODE): Promise<{ objects: DetectedObject[]; durationMs: number }> {
    const t0 = Date.now();
    const { data, scale, width, height } = await yoloxInput(jpeg, this.input);
    const feeds = { [this.session.inputNames[0]!]: new ort.Tensor("float32", data, [1, 3, this.input, this.input]) };
    const result = await this.session.run(feeds);
    const out = result[this.session.outputNames[0]!]!.data as Float32Array;
    return { objects: decodeYolox(out, this.input, scale, width, height, o), durationMs: Date.now() - t0 };
  }
}
