import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type { FramePrediction } from "@slot1/analysis";
import { GTA_BOXES, GTA_EVENTS, GTA_SCENES, GTA_TAXONOMY_VERSION, type GtaBox, type GtaEvent, type GtaScene } from "@slot1/contracts";

/**
 * ONNX Runtime execution of SLOT1's GTA models, shared by the worker (in-process) and the
 * inference service (batched for many streams). Pre- and post-processing live here once, so both
 * paths produce exactly the same predictions for the same frame.
 */

export const DEFAULT_THRESHOLDS = { scene: 0.6, event: 0.6, box: 0.5 };
export type Thresholds = typeof DEFAULT_THRESHOLDS;

/** The registry fields the runtime needs (structurally a subset of the db ModelRow). */
export interface RuntimeModelInfo {
  id: string;
  name: string;
  version: string;
  task: "scene" | "detector";
  taxonomy_version: number;
  classes: { scenes?: string[]; events?: string[]; boxes?: string[] };
  input_spec: object;
  onnx_storage_key: string;
  onnx_sha256: string;
}

export interface InputSpec {
  name: string;
  width: number;
  height: number;
  mean: number[];
  std: number[];
  /** false: the model takes one image [3, H, W] (torchvision detectors). Default true: [N, 3, H, W]. */
  batched?: boolean;
  outputs?: Record<string, string>;
  thresholds?: Partial<Thresholds>;
}

export interface RuntimePart {
  row: RuntimeModelInfo;
  spec: InputSpec;
  session: ort.InferenceSession;
  /** Cleared after the model refused a multi-frame batch (fixed batch dimension). */
  batchable: boolean;
}

/* ------------------------------------------------------------------------------------------ */
/* Execution providers                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Providers onnxruntime-node can be asked for; which ones work depends on the platform/binaries. */
const KNOWN_PROVIDERS = new Set(["cpu", "cuda", "tensorrt", "webgpu", "dml", "coreml"]);

export function parseExecutionProviders(spec: string | null | undefined): string[] {
  const list = (spec ?? "cpu")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => KNOWN_PROVIDERS.has(p));
  const unique = [...new Set(list)];
  if (!unique.includes("cpu")) unique.push("cpu"); // always keep a working fallback
  return unique;
}

export interface SessionResult {
  session: ort.InferenceSession;
  /** Providers the session was created with (after any fallback). */
  providers: string[];
  /** Why the requested accelerators weren't used, when they weren't. */
  fallbackReason: string | null;
}

/**
 * Create a session with the requested providers. If an accelerator can't load (e.g. the CUDA EP
 * binaries aren't installed), fall back to CPU and say why, instead of failing or pretending.
 */
export async function createSession(file: string, providers: string[]): Promise<SessionResult> {
  const opts = (eps: string[]): ort.InferenceSession.SessionOptions => ({ executionProviders: eps, graphOptimizationLevel: "all" });
  if (providers.length === 1 && providers[0] === "cpu") return { session: await ort.InferenceSession.create(file, opts(["cpu"])), providers: ["cpu"], fallbackReason: null };
  try {
    return { session: await ort.InferenceSession.create(file, opts(providers)), providers, fallbackReason: null };
  } catch (err) {
    const reason = (err as Error).message.split("\n")[0]?.slice(0, 300) ?? "unknown error";
    return { session: await ort.InferenceSession.create(file, opts(["cpu"])), providers: ["cpu"], fallbackReason: `${providers.join(",")} unavailable (${reason}); running on CPU` };
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Loading models from the registry                                                            */
/* ------------------------------------------------------------------------------------------ */

const sessions = new Map<string, Promise<SessionResult>>();

export interface LoadOptions {
  cacheDir: string;
  providers: string[];
  /** Copy the registry's model file to this local path (storage driver of the caller). */
  fetchToFile(row: RuntimeModelInfo, dest: string): Promise<void>;
  /** A model that can't be used is reported here and skipped, never faked. */
  onSkip(row: RuntimeModelInfo, reason: string): Promise<void> | void;
}

/** Download once, verify the registry checksum, keep one session per file and provider list. */
async function sessionFor(row: RuntimeModelInfo, o: LoadOptions): Promise<SessionResult> {
  const key = `${row.onnx_sha256}:${o.providers.join(",")}`;
  const cached = sessions.get(key);
  if (cached) return cached;
  const p = (async () => {
    await mkdir(o.cacheDir, { recursive: true });
    const file = path.join(o.cacheDir, `${row.onnx_sha256}.onnx`);
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.${Date.now()}.part`;
      await o.fetchToFile(row, tmp);
      await rename(tmp, file);
    }
    const sha = createHash("sha256").update(await readFile(file)).digest("hex");
    if (sha !== row.onnx_sha256) throw new Error(`Model file for ${row.name}@${row.version} doesn't match its registry checksum`);
    return createSession(file, o.providers);
  })();
  sessions.set(key, p);
  p.catch(() => sessions.delete(key));
  return p;
}

export async function loadRuntime(rows: RuntimeModelInfo[], o: LoadOptions): Promise<GtaRuntime | null> {
  const parts: RuntimePart[] = [];
  const providers = new Set<string>();
  const notes: string[] = [];
  for (const row of rows) {
    if (row.taxonomy_version !== GTA_TAXONOMY_VERSION) {
      await o.onSkip(row, `uses taxonomy v${row.taxonomy_version}; this build expects v${GTA_TAXONOMY_VERSION}`);
      continue;
    }
    try {
      const s = await sessionFor(row, o);
      s.providers.forEach((p) => providers.add(p));
      if (s.fallbackReason) notes.push(s.fallbackReason);
      parts.push({ row, spec: { ...(row.input_spec as InputSpec) }, session: s.session, batchable: (row.input_spec as InputSpec).batched !== false });
    } catch (err) {
      await o.onSkip(row, (err as Error).message);
    }
  }
  return parts.length ? new GtaRuntime(parts, [...providers], notes) : null;
}

/** Drop cached sessions that no active model uses any more (after a hot swap). */
export async function releaseUnused(activeSha: Set<string>): Promise<void> {
  for (const [key, p] of sessions) {
    if (activeSha.has(key.split(":")[0]!)) continue;
    sessions.delete(key);
    try {
      await (await p).session.release();
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Pre/post-processing                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Stretch a frame to the model's input size and re-encode it, exactly like the model's own
 * preprocessing resize. Used to shrink frames before they travel to the inference service.
 */
export async function resizeJpeg(jpeg: Buffer, width: number, height: number, quality = 90): Promise<Buffer> {
  return sharp(jpeg).resize(width, height, { fit: "fill" }).jpeg({ quality }).toBuffer();
}

/** JPEG → normalized float32 CHW in the layout the model was trained with. */
export async function jpegToCHW(jpeg: Buffer, spec: InputSpec): Promise<Float32Array> {
  const { data } = await sharp(jpeg).resize(spec.width, spec.height, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const plane = spec.width * spec.height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 3 + c]! / 255 - spec.mean[c]!) / spec.std[c]!;
  }
  return out;
}

const softmax = (v: ArrayLike<number>) => {
  let max = -Infinity;
  for (let i = 0; i < v.length; i++) max = Math.max(max, v[i]!);
  const exps = Array.from(v, (x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
};
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function decodeScene(pred: FramePrediction, part: RuntimePart, sceneLogits: ArrayLike<number> | null, eventLogits: ArrayLike<number> | null) {
  const sceneNames = (part.row.classes.scenes ?? []) as GtaScene[];
  if (sceneLogits && sceneNames.length) {
    const probs = softmax(sceneLogits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i]! > probs[best]!) best = i;
    const cls = sceneNames[best];
    if (cls && (GTA_SCENES as readonly string[]).includes(cls)) pred.scene = { class: cls, score: probs[best]!, modelId: part.row.id };
  }
  const eventNames = (part.row.classes.events ?? []) as GtaEvent[];
  if (eventLogits && eventNames.length) {
    eventNames.forEach((name, i) => {
      if ((GTA_EVENTS as readonly string[]).includes(name) && eventLogits[i] !== undefined) pred.events.push({ class: name, score: sigmoid(eventLogits[i]!), modelId: part.row.id });
    });
  }
}

function decodeDetector(pred: FramePrediction, part: RuntimePart, result: ort.InferenceSession.OnnxValueMapType) {
  const outputs = part.spec.outputs ?? {};
  const boxNames = (part.row.classes.boxes ?? []) as GtaBox[];
  const boxes = result[outputs.boxes ?? "boxes"]?.data as Float32Array | undefined;
  const scores = result[outputs.scores ?? "scores"]?.data as Float32Array | undefined;
  const labels = result[outputs.labels ?? "labels"]?.data as BigInt64Array | Int32Array | undefined;
  if (!boxes || !scores || !labels) return;
  const { width, height } = part.spec;
  for (let i = 0; i < scores.length; i++) {
    // torchvision detectors reserve label 0 for background.
    const name = boxNames[Number(labels[i]) - 1];
    if (!name || !(GTA_BOXES as readonly string[]).includes(name)) continue;
    const [x1, y1, x2, y2] = [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!];
    const x = Math.max(0, x1 / width);
    const y = Math.max(0, y1 / height);
    const w = Math.min(1 - x, (x2 - x1) / width);
    const h = Math.min(1 - y, (y2 - y1) / height);
    if (w <= 0 || h <= 0) continue;
    pred.boxes.push({ class: name, score: scores[i]!, box: { x, y, w, h }, modelId: part.row.id });
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Runtime                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** SLOT1's active GTA model(s): a scene/event classifier and/or a box detector. */
export class GtaRuntime {
  readonly label: string;
  readonly version: string;
  readonly thresholds: Thresholds;

  constructor(
    readonly parts: RuntimePart[],
    readonly providers: string[] = ["cpu"],
    readonly notes: string[] = [],
  ) {
    this.label = `GTA model (${parts.map((p) => `${p.row.name} ${p.row.version}`).join(", ")})`;
    this.version = parts.map((p) => `${p.row.name}@${p.row.version}`).join("+");
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...parts.reduce((t, p) => ({ ...t, ...(p.spec.thresholds ?? {}) }), {}) };
  }

  /** The largest input any part needs: frames can be reduced to this before they travel. */
  get inputSize(): { width: number; height: number } {
    return {
      width: Math.max(...this.parts.map((p) => p.spec.width)),
      height: Math.max(...this.parts.map((p) => p.spec.height)),
    };
  }

  /** Identifies the exact model files (changes on every activation). */
  get fingerprint(): string {
    return this.parts.map((p) => p.row.onnx_sha256).sort().join("+");
  }

  async predict(jpeg: Buffer): Promise<FramePrediction> {
    return (await this.predictBatch([jpeg]))[0]!;
  }

  /**
   * Predict many frames at once. Batchable models (scene/event classifiers exported with a
   * dynamic batch axis) run ONE session call for the whole batch; single-image models
   * (torchvision detectors) run per frame on the same session. Results keep input order.
   */
  async predictBatch(jpegs: Buffer[]): Promise<FramePrediction[]> {
    const preds: FramePrediction[] = jpegs.map(() => ({ scene: null, events: [], boxes: [], provider: "slot1-gta", version: this.version }));
    if (jpegs.length === 0) return preds;
    for (const part of this.parts) {
      const inputs = await Promise.all(jpegs.map((j) => jpegToCHW(j, part.spec)));
      if (part.row.task === "scene") await this.runScene(part, inputs, preds);
      else {
        const shape = part.spec.batched === false ? [3, part.spec.height, part.spec.width] : [1, 3, part.spec.height, part.spec.width];
        for (let i = 0; i < inputs.length; i++) {
          const result = await part.session.run({ [part.spec.name]: new ort.Tensor("float32", inputs[i]!, shape) });
          decodeDetector(preds[i]!, part, result);
        }
      }
    }
    return preds;
  }

  private async runScene(part: RuntimePart, inputs: Float32Array[], preds: FramePrediction[]) {
    const outputs = part.spec.outputs ?? {};
    const sceneName = outputs.scene ?? "scene_logits";
    const eventName = outputs.events ?? "event_logits";
    const { width, height } = part.spec;
    const single = async (x: Float32Array) => {
      const shape = part.spec.batched === false ? [3, height, width] : [1, 3, height, width];
      return part.session.run({ [part.spec.name]: new ort.Tensor("float32", x, shape) });
    };
    if (inputs.length > 1 && part.batchable) {
      const plane = 3 * width * height;
      const stacked = new Float32Array(inputs.length * plane);
      inputs.forEach((x, i) => stacked.set(x, i * plane));
      try {
        const result = await part.session.run({ [part.spec.name]: new ort.Tensor("float32", stacked, [inputs.length, 3, height, width]) });
        const scene = result[sceneName];
        const events = result[eventName];
        const sPer = scene ? scene.data.length / inputs.length : 0;
        const ePer = events ? events.data.length / inputs.length : 0;
        for (let i = 0; i < inputs.length; i++) {
          decodeScene(
            preds[i]!,
            part,
            scene ? (scene.data as Float32Array).subarray(i * sPer, (i + 1) * sPer) : null,
            events ? (events.data as Float32Array).subarray(i * ePer, (i + 1) * ePer) : null,
          );
        }
        return;
      } catch {
        // Exported with a fixed batch size: remember and run frame by frame from now on.
        part.batchable = false;
      }
    }
    for (let i = 0; i < inputs.length; i++) {
      const result = await single(inputs[i]!);
      decodeScene(preds[i]!, part, (result[sceneName]?.data as Float32Array | undefined) ?? null, (result[eventName]?.data as Float32Array | undefined) ?? null);
    }
  }
}
