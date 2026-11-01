import { tmpdir } from "node:os";
import path from "node:path";
import type { FrameModel, FramePrediction } from "@slot1/analysis";
import { DEFAULT_THRESHOLDS, loadRuntime, parseExecutionProviders, resizeJpeg, type GtaRuntime, type Thresholds } from "@slot1/gta-runtime";
import { listActiveModels, recordOpsError, type ModelRow } from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";

const CACHE_DIR = path.join(tmpdir(), "slot1-models");

/** The registry's active model, run in this worker process with ONNX Runtime. */
export class OnnxGtaModel implements FrameModel {
  readonly label: string;
  readonly thresholds: Thresholds;
  readonly skipReason = null;

  constructor(readonly runtime: GtaRuntime) {
    this.label = runtime.label;
    this.thresholds = runtime.thresholds;
  }

  predict(jpeg: Buffer): Promise<FramePrediction> {
    return this.runtime.predict(jpeg);
  }
}

export interface RemoteOptions {
  /** Live frames are skipped after a short timeout; replays and clips may wait and retry. */
  live: boolean;
  /** Fairness key at the service: one per media source. */
  streamId: string;
}

/**
 * The registry's active model, run by the shared inference service (INFERENCE_URL). A busy or
 * unreachable service never stalls the pipeline: the frame is skipped, counted, and reported.
 */
export class RemoteGtaModel implements FrameModel {
  label: string;
  /** Updated in place from each response, so a hot-swapped model's thresholds apply at once. */
  readonly thresholds: Thresholds;
  skipReason: string | null = null;
  /** The model's input size: frames are reduced to it here, before they travel. */
  private inputSize: { width: number; height: number } | null;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
    private readonly opts: RemoteOptions,
    info: { label: string | null; thresholds: Partial<Thresholds> | null; inputSize?: { width: number; height: number } | null },
  ) {
    this.label = info.label ? `${info.label} via inference service` : "GTA model via inference service";
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(info.thresholds ?? {}) };
    this.inputSize = info.inputSize ?? null;
  }

  /** Same stretch-to-size as the model's own preprocessing, so the service's resize is a no-op. */
  private async shrink(jpeg: Buffer): Promise<Buffer> {
    if (!this.inputSize) return jpeg;
    return resizeJpeg(jpeg, this.inputSize.width, this.inputSize.height);
  }

  private async post(jpeg: Buffer): Promise<{
    status: number;
    body: { status?: string; reason?: string; prediction?: FramePrediction; model?: { label?: string | null; thresholds?: Partial<Thresholds> | null; inputSize?: { width: number; height: number } | null } } | null;
  }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/v1/frames`, {
        method: "POST",
        // The deadline lets the service drop this frame instead of running it after we gave up.
        headers: { authorization: `Bearer ${this.secret}`, "content-type": "image/jpeg", "x-slot1-stream": this.opts.streamId, "x-slot1-deadline-ms": String(this.timeoutMs) },
        body: new Uint8Array(jpeg),
        signal: ac.signal,
      });
      const body = (await res.json().catch(() => null)) as Awaited<ReturnType<RemoteGtaModel["post"]>>["body"];
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async predict(jpeg: Buffer): Promise<FramePrediction | null> {
    const attempts = this.opts.live ? 1 : 4;
    const body = await this.shrink(jpeg);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const r = await this.post(body);
        if (r.status === 200 && r.body?.prediction) {
          this.skipReason = null;
          if (r.body.model?.thresholds) Object.assign(this.thresholds, r.body.model.thresholds);
          if (r.body.model?.label) this.label = `${r.body.model.label} via inference service`;
          if (r.body.model?.inputSize) this.inputSize = r.body.model.inputSize;
          return r.body.prediction;
        }
        if (r.status === 503) this.skipReason = "the inference service has no active model";
        else if (r.status === 429) this.skipReason = `the inference service is at capacity (${r.body?.reason ?? "dropped"})`;
        else if (r.status === 401) this.skipReason = "the inference service rejected the shared secret";
        else this.skipReason = `the inference service answered ${r.status}`;
        if (r.status !== 429) break; // only overload is worth retrying
      } catch (err) {
        this.skipReason = (err as Error).name === "AbortError" ? `no answer within ${this.timeoutMs} ms` : `inference service unreachable (${sanitizeErrorMessage((err as Error).message)})`;
      }
      if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
    return null;
  }

  /** Ask the service what it runs. Reachable without a model → null (no GTA model, same as local). */
  static async connect(ctx: ServerContext, opts: RemoteOptions): Promise<RemoteGtaModel | null> {
    const env = ctx.config.env;
    const url = env.INFERENCE_URL!.replace(/\/$/, "");
    const secret = env.INFERENCE_SHARED_SECRET ?? "";
    const timeoutMs = opts.live ? env.INFERENCE_TIMEOUT_MS : Math.max(10_000, env.INFERENCE_TIMEOUT_MS);
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      const res = await fetch(`${url}/v1/model`, { headers: { authorization: `Bearer ${secret}` }, signal: ac.signal }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const m = (await res.json()) as { active: boolean; label: string | null; thresholds: Partial<Thresholds> | null; inputSize: { width: number; height: number } | null };
        if (!m.active) return null;
        return new RemoteGtaModel(url, secret, timeoutMs, opts, m);
      }
      await recordOpsError(ctx.db, null, "gta-model", `Inference service answered ${res.status} to /v1/model; frames will be skipped until it recovers`);
    } catch (err) {
      await recordOpsError(ctx.db, null, "gta-model", `Inference service unreachable at startup (${sanitizeErrorMessage((err as Error).message)}); frames will be skipped until it recovers`);
    }
    // Unknown state: keep trying per frame (each skip is counted), never guess.
    return new RemoteGtaModel(url, secret, timeoutMs, opts, { label: null, thresholds: null });
  }
}

/**
 * The GTA model for one pipeline. With INFERENCE_URL the shared service runs it; otherwise the
 * registry's active model loads in this process. No active model → null and the pipeline runs as
 * before. A model that fails to load is reported and skipped, never faked.
 */
export async function loadActiveGtaModel(ctx: ServerContext, opts: Partial<RemoteOptions> = {}): Promise<FrameModel | null> {
  if (ctx.config.env.INFERENCE_URL) return RemoteGtaModel.connect(ctx, { live: opts.live ?? false, streamId: opts.streamId ?? "worker" });
  let active: ModelRow[];
  try {
    active = await listActiveModels(ctx.db);
  } catch {
    return null;
  }
  if (active.length === 0) return null;
  const runtime = await loadRuntime(active, {
    cacheDir: CACHE_DIR,
    // The worker runs on the CPU; GPUs belong to the shared inference service.
    providers: parseExecutionProviders("cpu"),
    fetchToFile: (row, dest) => ctx.storage.downloadToFile(row.onnx_storage_key, dest),
    onSkip: async (row, why) => {
      await recordOpsError(ctx.db, null, "gta-model", `Couldn't load model ${row.name}@${row.version}: ${sanitizeErrorMessage(why)}. Skipped.`);
    },
  });
  return runtime ? new OnnxGtaModel(runtime) : null;
}
