import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { decodeYolox, DEFAULT_DECODE, YOLOX_PAD, type DecodeOptions, type DetectedObject } from "@slot1/contracts";

export { decodeYolox, DEFAULT_DECODE, OBJECT_LABELS, yoloxRows, type DecodeOptions, type DetectedObject } from "@slot1/contracts";

/**
 * SLOT1's object finder for the AI overlay: a small general-purpose detector (YOLOX, Apache-2.0,
 * trained on the COCO photo set) that puts boxes around people, vehicles and animals in a frame.
 * It isn't trained on GTA: it finds what looks like a person or a car, with a score, and nothing
 * else. Its boxes feed the overlay only; they never become log entries or training labels.
 */

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
  const data = new Float32Array(3 * plane).fill(YOLOX_PAD);
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
