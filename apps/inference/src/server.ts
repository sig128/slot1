import Fastify, { type FastifyInstance } from "fastify";
import type { FramePrediction } from "@slot1/analysis";
import { safeEqual } from "@slot1/platform";
import { DroppedError, FairBatcher, type BatcherOptions } from "./batcher";
import { Metrics } from "./metrics";
import type { ModelSource } from "./models";

export interface InferenceDeps {
  secret: string;
  manager: ModelSource;
  batching: BatcherOptions;
  logger?: boolean | object;
}

const STREAM_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
/** How long the caller will wait for this frame, in ms from sending (optional). */
const DEADLINE_HEADER = "x-slot1-deadline-ms";

export class NoModelError extends Error {
  constructor() {
    super("no active GTA model");
  }
}

/**
 * The shared inference service. Internal network only, and every request must carry the shared
 * secret. Frames from all streams are batched together; the response shape matches what the
 * worker's in-process model returns.
 */
export async function buildInferenceServer(deps: InferenceDeps): Promise<{ app: FastifyInstance; batcher: FairBatcher<Buffer, FramePrediction>; metrics: Metrics }> {
  if (!deps.secret || deps.secret.length < 16) throw new Error("INFERENCE_SHARED_SECRET must be set (at least 16 characters)");
  const metrics = new Metrics();
  const batcher = new FairBatcher<Buffer, FramePrediction>(
    deps.batching,
    (jpegs) =>
      deps.manager.withRuntime(async (rt) => {
        if (!rt) throw new NoModelError();
        return rt.predictBatch(jpegs);
      }),
    (info) => metrics.batch(info.size, info.runMs),
  );

  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 4 * 1024 * 1024 });
  app.addContentTypeParser(["image/jpeg", "application/octet-stream"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeEqual(token, deps.secret)) return reply.status(401).send({ status: "unauthorized" });
  });

  app.get("/healthz", async () => ({ ok: true, model: deps.manager.hasModel }));

  app.get("/v1/model", async () => {
    const s = deps.manager.status();
    return { active: s.active, label: s.label, version: s.version, fingerprint: s.fingerprint, thresholds: s.thresholds, inputSize: s.inputSize, providers: s.providers, notes: s.notes };
  });

  app.get("/metrics", async () => ({
    ...metrics.snapshot(),
    queue: { depth: batcher.depth, inFlightBatches: batcher.inFlight, streamsWaiting: batcher.streams, expectedWaitMs: round(batcher.expectedWaitMs) },
    frames: batcher.counters,
    model: deps.manager.status(),
    swaps: deps.manager.swaps,
    config: deps.batching,
  }));

  app.post("/v1/frames", async (req, reply) => {
    const started = performance.now();
    const stream = String(req.headers["x-slot1-stream"] ?? "");
    if (!STREAM_RE.test(stream)) return reply.status(400).send({ status: "bad_request", message: "x-slot1-stream header is required" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
      return reply.status(400).send({ status: "bad_request", message: "body must be a JPEG image" });
    }
    if (!deps.manager.hasModel) return reply.status(503).send({ status: "no_model" });
    // Frames whose caller has given up never reach the model (see FairBatcher).
    const budget = Number(req.headers[DEADLINE_HEADER]);
    const deadline = Number.isFinite(budget) && budget > 0 ? started + Math.min(budget, 60_000) : undefined;
    const gone = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    try {
      const r = await batcher.submit(stream, body, { deadline, signal: gone.signal });
      const totalMs = performance.now() - started;
      metrics.frame(totalMs, r.queueMs);
      const s = deps.manager.status();
      return {
        status: "ok",
        prediction: r.output,
        model: { label: s.label, version: r.output.version, thresholds: s.thresholds, inputSize: s.inputSize },
        timings: { queueMs: round(r.queueMs), runMs: round(r.runMs), batchSize: r.batchSize, totalMs: round(totalMs) },
      };
    } catch (err) {
      if (err instanceof DroppedError) return reply.status(429).send({ status: "dropped", reason: err.reason });
      if (err instanceof NoModelError) return reply.status(503).send({ status: "no_model" });
      req.log.error({ err: (err as Error).message }, "inference failed");
      return reply.status(500).send({ status: "error", message: "inference failed" });
    }
  });

  app.addHook("onClose", async () => {
    await batcher.close();
  });
  return { app, batcher, metrics };
}

const round = (v: number) => Math.round(v * 10) / 10;
