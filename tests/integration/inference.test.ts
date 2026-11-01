import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelManager } from "../../apps/inference/src/models";
import { buildInferenceServer } from "../../apps/inference/src/server";
import { loadActiveGtaModel, RemoteGtaModel } from "../../apps/worker/src/gta/onnx-model";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { getProfile, ObservationPipeline, type FramePrediction } from "@slot1/analysis";
import { GTA_EVENTS, GTA_SCENES, GTA_TAXONOMY_VERSION } from "@slot1/contracts";
import { activateModel, getSession, getSettings, getSource, getSourceHealth, insertModel } from "@slot1/db";
import { loadRuntime } from "@slot1/gta-runtime";
import { createLogger } from "@slot1/platform";
import { createPipelineSink, type ServerContext } from "@slot1/services";
import { Browser, multipart, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const hasTorch = spawnSync("python3", ["-c", "import torch, onnx"], { stdio: "ignore" }).status === 0;
const SECRET = "integration-inference-secret-0123456789";
const SIZE = 32;

/** The shared inference service with the worker's remote adapter, on real ONNX Runtime and Postgres. */
describe.skipIf(!hasTorch)("shared inference service", () => {
  let h: Harness;
  let manager: ModelManager;
  let service: Awaited<ReturnType<typeof buildInferenceServer>>;
  let url = "";
  let workerCtx: ServerContext;
  const frames: Buffer[] = [];
  const work = mkdtempSync(path.join(tmpdir(), "slot1-inference-it-"));

  /** Train-free fixture: a tiny deterministic model, stored and activated like an uploaded one. */
  async function registerModel(version: string, seed: number) {
    const file = path.join(work, `tiny-${version}.onnx`);
    execFileSync("python3", [path.join(__dirname, "support/tiny_scene_model.py"), file, String(SIZE), String(GTA_SCENES.length), String(GTA_EVENTS.length), String(seed)], { stdio: "ignore" });
    const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    const key = `models/${sha}.onnx`;
    const { bytes } = await h.ctx.storage.putFile(key, file, "application/octet-stream");
    const row = await insertModel(h.ctx.db, {
      name: "gta-scene-tiny",
      version,
      task: "scene",
      taxonomy_version: GTA_TAXONOMY_VERSION,
      classes: { scenes: [...GTA_SCENES], events: [...GTA_EVENTS] },
      input_spec: { name: "input", width: SIZE, height: SIZE, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], outputs: { scene: "scene_logits", events: "event_logits" } },
      metrics: [],
      dataset_version_id: null,
      onnx_storage_key: key,
      onnx_sha256: sha,
      bytes,
      uploaded_by: null,
    });
    await activateModel(h.ctx.db, row.id);
    return row;
  }

  const post = (body: Buffer, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/frames`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "image/jpeg", "x-slot1-stream": "it:stream", ...headers }, body: new Uint8Array(body) });

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    for (const t of [3, 13, 20, 30]) {
      const out = path.join(work, `f${t}.jpg`);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", SAMPLE, "-frames:v", "1", "-q:v", "4", "-y", out]);
      frames.push(readFileSync(out));
    }
    h = await startHarness();
    manager = new ModelManager({ db: h.ctx.db, storage: h.ctx.storage, log: createLogger("inference-it", "silent"), providers: ["cpu"], cacheDir: path.join(work, "cache") });
    service = await buildInferenceServer({ secret: SECRET, manager, batching: { maxBatch: 8, maxWaitMs: 15, maxQueue: 64, maxPerStream: 8, concurrency: 1 } });
    await service.app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(service.app.server.address() as AddressInfo).port}`;
    workerCtx = { ...h.ctx, config: { ...h.ctx.config, env: { ...h.ctx.config.env, INFERENCE_URL: url, INFERENCE_SHARED_SECRET: SECRET, INFERENCE_TIMEOUT_MS: 2000 } } };
  });

  afterAll(async () => {
    await h?.ctx.db.query(`UPDATE models SET status = 'retired' WHERE status = 'active'`).catch(() => undefined);
    await service?.app.close();
    await h?.close();
  });

  it("refuses every request without the shared secret", async () => {
    for (const p of ["/healthz", "/metrics", "/v1/model"]) expect((await fetch(`${url}${p}`)).status).toBe(401);
    expect((await fetch(`${url}/v1/model`, { headers: { authorization: "Bearer wrong-secret-wrong-secret" } })).status).toBe(401);
    expect((await post(frames[0]!, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("says when it has no model, and the worker then runs without one", async () => {
    await manager.reload("test");
    const r = await post(frames[0]!);
    expect(r.status).toBe(503);
    expect((await r.json()).status).toBe("no_model");
    expect(await loadActiveGtaModel(workerCtx, { live: true, streamId: "live:x" })).toBeNull();
  });

  it("answers exactly what the in-process runtime answers for the same frame", async () => {
    const row = await registerModel("it-a", 1);
    await manager.reload("activation notice");
    const model = (await (await fetch(`${url}/v1/model`, { headers: { authorization: `Bearer ${SECRET}` } })).json()) as { active: boolean; version: string; inputSize: { width: number } };
    expect(model).toMatchObject({ active: true, version: "gta-scene-tiny@it-a", inputSize: { width: SIZE } });

    const local = await loadRuntime([row], { cacheDir: path.join(work, "local"), providers: ["cpu"], fetchToFile: (r, d) => h.ctx.storage.downloadToFile(r.onnx_storage_key, d), onSkip: () => undefined });
    for (const f of frames) {
      const remote = (await (await post(f)).json()) as { prediction: FramePrediction };
      const mine = await local!.predict(f);
      expect(remote.prediction.scene).toEqual(mine.scene);
      expect(remote.prediction.events.map((e) => e.score)).toEqual(mine.events.map((e) => e.score));
      expect(remote.prediction.version).toBe("gta-scene-tiny@it-a");
    }
  });

  it("batches frames from many streams into shared runs", async () => {
    const before = (await (await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${SECRET}` } })).json()) as { frames: { completed: number } };
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => post(frames[i % frames.length]!, { "x-slot1-stream": `live:stream-${i % 6}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { timings: { batchSize: number } }[];
    expect(Math.max(...bodies.map((b) => b.timings.batchSize))).toBeGreaterThan(1);
    const m = (await (await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${SECRET}` } })).json()) as {
      frames: { completed: number };
      batchSize: { mean: number };
      latencyMs: { p50: number; p95: number };
    };
    expect(m.frames.completed - before.frames.completed).toBe(24);
    expect(m.batchSize.mean).toBeGreaterThan(1);
    expect(m.latencyMs.p95).toBeGreaterThan(0);
  });

  it("feeds the worker's normal pipeline: model outputs, proposals and honest labels", async () => {
    const creator = new Browser(h);
    await creator.signInLocal("Remote Model Crew");
    const form = await multipart({ title: "Remote model run", rightsConfirmed: "true" }, { field: "file", filename: "run.mp4", path: SAMPLE, type: "video/mp4" });
    const up = (await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } })).json<{ sessionId: string; sourceId: string }>();
    const job = h.jobs.find((j) => j.name === "analyze-upload" && (j.data as { sessionId: string }).sessionId === up.sessionId)!;
    await analyzeUpload(workerCtx, job.data as Parameters<typeof analyzeUpload>[1]);
    const session = (await creator.get(`/api/sessions/${up.sessionId}`)).json();
    expect(session.analysis.reason).toMatch(/via inference service/);
    const m = (await (await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${SECRET}` } })).json()) as { frames: { completed: number } };
    expect(m.frames.completed).toBeGreaterThan(24);
    const obs = (await creator.get(`/api/sessions/${up.sessionId}/observations?limit=500`)).json<{ observations: { model: { provider: string } | null; origin: string; evidence: unknown[]; modelConfidence: number | null }[] }>().observations;
    for (const o of obs.filter((x) => x.model?.provider === "slot1-gta")) {
      expect(o.origin).toBe("video");
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.modelConfidence).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("never stalls a live stream: an unreachable or overloaded service skips the frame and counts it", async () => {
    const dead = new RemoteGtaModel("http://127.0.0.1:9", SECRET, 300, { live: true, streamId: "live:dead" }, { label: null, thresholds: null });
    const t0 = Date.now();
    expect(await dead.predict(frames[0]!)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(dead.skipReason).toMatch(/unreachable|no answer/);

    const wrong = new RemoteGtaModel(url, "wrong-secret-wrong-secret", 1000, { live: true, streamId: "live:wrong" }, { label: null, thresholds: null });
    expect(await wrong.predict(frames[0]!)).toBeNull();
    expect(wrong.skipReason).toMatch(/shared secret/);

    // In the real pipeline, a skipped frame is counted as dropped in the source's health.
    const { rows } = await h.ctx.db.query<{ id: string; session_id: string }>(`SELECT id, session_id FROM media_sources WHERE session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
    const source = (await getSource(h.ctx.db, rows[0]!.id))!;
    const session = (await getSession(h.ctx.db, rows[0]!.session_id))!;
    const settings = await getSettings(h.ctx.db, session.broadcaster_id);
    const before = (await getSourceHealth(h.ctx.db, source.id))?.frames_dropped ?? 0;
    const pipeline = new ObservationPipeline({
      ocr: null,
      ocrVersion: "5",
      vision: null,
      gtaModel: dead,
      profile: getProfile("generic"),
      sourceLabel: source.label,
      visionBatchSize: 1,
      coverageMsPerFrame: 1000,
      workDir: path.join(work, "pipe"),
      sink: createPipelineSink(h.ctx, { session, source, settings, retentionDays: 1 }),
    });
    await pipeline.handleFrame({ ptsMs: 1000, receivedAt: new Date(), capturedAt: null, jpeg: frames[0]!, width: 1280, height: 720, reason: "live" });
    expect(pipeline.stats.modelSkipped).toBe(1);
    expect(Number((await getSourceHealth(h.ctx.db, source.id))?.frames_dropped ?? 0)).toBe(Number(before) + 1);
  });

  it("hot-swaps to a newly activated model without failing in-flight frames", async () => {
    const inFlight = Array.from({ length: 30 }, (_, i) => post(frames[i % frames.length]!, { "x-slot1-stream": `live:swap-${i % 5}` }));
    await registerModel("it-b", 2);
    const swap = manager.reload("activation notice");
    const more = Array.from({ length: 30 }, (_, i) => post(frames[i % frames.length]!, { "x-slot1-stream": `live:swap-${i % 5}` }));
    await swap;
    const all = await Promise.all([...inFlight, ...more]);
    expect(all.every((r) => r.status === 200)).toBe(true);
    const after = (await (await post(frames[0]!)).json()) as { prediction: FramePrediction };
    expect(after.prediction.version).toBe("gta-scene-tiny@it-b");
    expect(manager.swaps.at(-1)).toMatchObject({ from: "gta-scene-tiny@it-a", to: "gta-scene-tiny@it-b" });
  });

  it("reports an activated model that can't load, answers no_model, and doesn't retry it every poll", async () => {
    const broken = await registerModel("it-c", 3);
    // The stored file no longer matches the registry's checksum.
    await h.ctx.db.query("UPDATE models SET onnx_sha256 = $2 WHERE id = $1", [broken.id, "0".repeat(64)]);
    const opsErrors = async () => Number((await h.ctx.db.query<{ n: string }>("SELECT count(*) AS n FROM ops_errors WHERE scope = 'gta-model'")).rows[0]!.n);
    const before = await opsErrors();
    await manager.reload("activation notice");
    expect(manager.status()).toMatchObject({ active: false });
    expect(manager.status().lastError).toMatch(/it-c/);
    expect((await post(frames[0]!)).status).toBe(503);
    const reported = await opsErrors();
    expect(reported).toBe(before + 1);
    await manager.reload("poll");
    await manager.reload("poll");
    expect(await opsErrors()).toBe(reported);
  });
});
