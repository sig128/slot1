/**
 * SLOT1 load test.
 *
 *   Service mode (default): N simulated live streams × F frames/s of real JPEG frames against the
 *   shared inference service. Reports throughput, latency percentiles, batch sizes and drops.
 *     pnpm exec tsx scripts/load-test.ts --streams 10,50,100 --fps 1 --seconds 20
 *     pnpm exec tsx scripts/load-test.ts --url http://gpu-box:4100 --secret $INFERENCE_SHARED_SECRET --streams 100,300
 *   Without --url, a service is started locally (separate process) with an UNTRAINED copy of the
 *   production scene model (--model bench, MobileNetV3-Small 224px), --model tiny, or --model
 *   path/to/model.onnx --meta path/to/model.json (as written by ml/train_scene.py), on
 *   --providers cpu (default) or e.g. cuda,cpu. Requests carry the timeout as their deadline like
 *   the worker's; --no-deadline leaves it out. See docs/SCALING.md.
 *
 *   Ingest mode: N looping test streams through the local nginx-rtmp gateway and the real worker,
 *   measuring frame lag from source health. Needs the dev stack (README → Continuous ingest).
 *     pnpm exec tsx scripts/load-test.ts --mode ingest --streams 2 --seconds 60
 *
 * Imports are relative on purpose: run from the repository root without any build step.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpus, totalmem, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GTA_EVENTS, GTA_SCENES, GTA_TAXONOMY_VERSION } from "../packages/contracts/src/gta-taxonomy";
import { loadRuntime, parseExecutionProviders, resizeJpeg } from "../packages/gta-runtime/src/index";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const WORK = path.join(tmpdir(), "slot1-load-test");

/* ------------------------------------------------------------------------------------------ */
/* CLI                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
};
const num = (name: string, def: number) => Number(flag(name, String(def)));

const mode = flag("mode", "service");
const streamsList = (flag("streams", "10,50,100") ?? "10").split(",").map(Number);
const fps = num("fps", 1);
const seconds = num("seconds", 20);
const timeoutMs = num("timeout", 1500);
const fullFrames = flag("full-frames") === "true";
/** Like the worker, tell the service how long we wait, so it can drop frames we gave up on. */
const sendDeadline = flag("no-deadline") !== "true";

const pct = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]! * 10) / 10;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** GPUs on this machine, if nvidia-smi is installed. */
const localGpus = () => {
  try {
    return execFileSync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------------------------------ */
/* Frames and models                                                                           */
/* ------------------------------------------------------------------------------------------ */

function sampleFrames(): Buffer[] {
  if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
  mkdirSync(WORK, { recursive: true });
  const out: Buffer[] = [];
  for (const t of [2, 6, 10, 13, 16, 20, 24, 27, 31, 35]) {
    const file = path.join(WORK, `frame-${t}.jpg`);
    if (!existsSync(file)) {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", SAMPLE, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "4", "-y", file]);
    }
    out.push(readFileSync(file));
  }
  return out;
}

/** Returns [onnxPath, metadataPath] for the requested model. */
function modelFiles(spec: string): [string, string] {
  if (spec.endsWith(".onnx")) {
    const meta = flag("meta");
    if (!meta) throw new Error("--meta path/to/model.json is required with an .onnx model");
    return [spec, meta];
  }
  const arch = spec === "tiny" ? "tiny" : "mobilenet_v3_small";
  const size = spec === "tiny" ? 96 : num("size", 224);
  const dir = path.join(WORK, "models");
  const onnx = path.join(dir, `bench-${arch}-${size}.onnx`);
  if (!existsSync(onnx)) {
    execFileSync(
      "python3",
      [path.join(ROOT, "scripts/loadtest/export_bench_model.py"), dir, "--arch", arch, "--size", String(size), "--scenes", JSON.stringify(GTA_SCENES), "--events", JSON.stringify(GTA_EVENTS)],
      { stdio: "ignore" },
    );
  }
  return [onnx, onnx.replace(/\.onnx$/, ".json")];
}

/* ------------------------------------------------------------------------------------------ */
/* Local service in its own process                                                            */
/* ------------------------------------------------------------------------------------------ */

async function serve() {
  const [onnx, metaPath] = modelFiles(flag("model", "bench")!);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { name: string; version: string; task: "scene" | "detector"; classes: object; input: object; outputs: object };
  const sha = createHash("sha256").update(readFileSync(onnx)).digest("hex");
  const runtime = await loadRuntime(
    [{ id: "bench", name: meta.name, version: meta.version, task: meta.task, taxonomy_version: GTA_TAXONOMY_VERSION, classes: meta.classes, input_spec: { ...meta.input, outputs: meta.outputs }, onnx_storage_key: "local", onnx_sha256: sha }],
    {
      cacheDir: path.join(WORK, "cache"),
      providers: parseExecutionProviders(flag("providers", "cpu")),
      fetchToFile: (_row, dest) => copyFile(onnx, dest),
      onSkip: (_row, why) => {
        throw new Error(why);
      },
    },
  );
  const { StaticModelSource } = await import("../apps/inference/src/models");
  const { buildInferenceServer } = await import("../apps/inference/src/server");
  const { app } = await buildInferenceServer({
    secret: flag("secret")!,
    manager: new StaticModelSource(runtime!),
    batching: { maxBatch: num("max-batch", 16), maxWaitMs: num("max-wait", 8), maxQueue: num("max-queue", 512), maxPerStream: num("max-per-stream", 4), concurrency: num("concurrency", 1) },
  });
  await app.listen({ host: "127.0.0.1", port: num("port", 0) });
  process.stdout.write(`LISTENING ${JSON.stringify(app.server.address())}\n`);
}

async function startLocalService(secret: string): Promise<{ url: string; child: ChildProcess }> {
  const passthrough = ["model", "meta", "size", "providers", "max-batch", "max-wait", "max-queue", "max-per-stream", "concurrency"].flatMap((k) => (flag(k) ? [`--${k}`, flag(k)!] : []));
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--serve", "--secret", secret, ...passthrough], { stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/LISTENING (\{.*\})/);
      if (m) resolve(`http://127.0.0.1:${(JSON.parse(m[1]!) as { port: number }).port}`);
    });
    child.on("exit", (code) => reject(new Error(`local service exited (${code})`)));
  });
  return { url, child };
}

/* ------------------------------------------------------------------------------------------ */
/* Service load                                                                                */
/* ------------------------------------------------------------------------------------------ */

interface LevelResult {
  streams: number;
  fpsPerStream: number;
  offeredFps: number;
  achievedFps: number;
  sent: number;
  ok: number;
  dropped: Record<string, number>;
  timeouts: number;
  errors: number;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  serverQueueMs: { p50: number | null; p95: number | null };
  batchSize: { mean: number | null; max: number };
}

async function runLevel(url: string, secret: string, frames: Buffer[], streams: number): Promise<LevelResult> {
  const lat: number[] = [];
  const queue: number[] = [];
  const batches: number[] = [];
  const dropped: Record<string, number> = {};
  let sent = 0;
  let ok = 0;
  let timeouts = 0;
  let errors = 0;
  const pending = new Set<Promise<void>>();
  const interval = 1000 / fps;
  const started = Date.now();
  const deadline = started + seconds * 1000;
  const timers: NodeJS.Timeout[] = [];

  const fire = (stream: number) => {
    if (Date.now() >= deadline) return;
    const body = frames[(sent + stream) % frames.length]!;
    sent += 1;
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const p = fetch(`${url}/v1/frames`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "image/jpeg",
        "x-slot1-stream": `load:${stream}`,
        ...(sendDeadline ? { "x-slot1-deadline-ms": String(timeoutMs) } : {}),
      },
      body: new Uint8Array(body),
      signal: ac.signal,
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { status?: string; reason?: string; timings?: { queueMs: number; batchSize: number } } | null;
        if (res.status === 200 && json?.timings) {
          ok += 1;
          lat.push(performance.now() - t0);
          queue.push(json.timings.queueMs);
          batches.push(json.timings.batchSize);
        } else if (res.status === 429) dropped[json?.reason ?? "dropped"] = (dropped[json?.reason ?? "dropped"] ?? 0) + 1;
        else errors += 1;
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") timeouts += 1;
        else errors += 1;
      })
      .finally(() => {
        clearTimeout(timer);
        pending.delete(p);
      });
    pending.add(p);
  };

  for (let s = 0; s < streams; s++) {
    // Spread stream phases across the interval, like independent live sources.
    timers.push(
      setTimeout(() => {
        fire(s);
        timers.push(setInterval(() => fire(s), interval));
      }, (s / streams) * interval),
    );
  }
  await sleep(seconds * 1000);
  timers.forEach((t) => clearTimeout(t));
  await Promise.all(pending);
  const elapsed = (Date.now() - started) / 1000;
  return {
    streams,
    fpsPerStream: fps,
    offeredFps: Math.round(streams * fps * 10) / 10,
    achievedFps: Math.round((ok / elapsed) * 10) / 10,
    sent,
    ok,
    dropped,
    timeouts,
    errors,
    latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) },
    serverQueueMs: { p50: pct(queue, 50), p95: pct(queue, 95) },
    batchSize: { mean: batches.length ? Math.round((batches.reduce((a, b) => a + b, 0) / batches.length) * 100) / 100 : null, max: batches.length ? Math.max(...batches) : 0 },
  };
}

async function serviceMode() {
  const secret = flag("secret") ?? randomBytes(24).toString("hex");
  let frames = sampleFrames();
  let url = flag("url");
  let child: ChildProcess | null = null;
  if (!url) ({ url, child } = await startLocalService(secret));
  const info = (await (await fetch(`${url}/v1/model`, { headers: { authorization: `Bearer ${secret}` } })).json()) as { version: string; providers: string[]; notes: string[]; inputSize: { width: number; height: number } | null };
  // Like the worker: frames are reduced to the model's input size before they travel.
  if (!fullFrames && info.inputSize) frames = await Promise.all(frames.map((f) => resizeJpeg(f, info.inputSize!.width, info.inputSize!.height)));
  const results: LevelResult[] = [];
  for (const n of streamsList) {
    const r = await runLevel(url, secret, frames, n);
    results.push(r);
    console.log(
      `${String(n).padStart(4)} streams × ${fps} fps = ${String(r.offeredFps).padStart(6)} offered | ${String(r.achievedFps).padStart(6)} done/s | p50 ${r.latencyMs.p50} ms p95 ${r.latencyMs.p95} ms p99 ${r.latencyMs.p99} ms | batch mean ${r.batchSize.mean} max ${r.batchSize.max} | dropped ${JSON.stringify(r.dropped)} timeouts ${r.timeouts} errors ${r.errors}`,
    );
    await sleep(1000);
  }
  const report = {
    at: new Date().toISOString(),
    // With --url the service runs elsewhere: this block then describes the load generator only.
    hardware: { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? "unknown", memoryGb: Math.round(totalmem() / 2 ** 30), gpus: localGpus() ?? "none detected", serviceOnThisMachine: !flag("url") },
    service: url,
    model: info.version,
    providers: info.providers,
    providerNotes: info.notes,
    frameBytes: Math.round(frames.reduce((a, f) => a + f.length, 0) / frames.length),
    settings: { fps, seconds, timeoutMs, fullFrames, sendDeadline },
    results,
  };
  if (flag("json")) writeFileSync(flag("json")!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ hardware: report.hardware, model: report.model, providers: report.providers, providerNotes: report.providerNotes, frameBytes: report.frameBytes }));
  child?.kill("SIGTERM");
}

/* ------------------------------------------------------------------------------------------ */
/* Ingest mode: gateway → worker → source health                                               */
/* ------------------------------------------------------------------------------------------ */

async function ingestMode() {
  const api = flag("api", "http://127.0.0.1:4000")!;
  let cookie = "";
  let csrf = "";
  const call = async <T = unknown>(p: string, init: { method?: string; json?: unknown } = {}): Promise<T> => {
    const headers: Record<string, string> = { origin: "http://localhost:3000" };
    if (cookie) headers.cookie = cookie;
    if (init.method && init.method !== "GET") headers["x-slot1-csrf"] = csrf;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${api}${p}`, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
    for (const c of res.headers.getSetCookie()) if (c.startsWith("slot1_session=")) cookie = c.split(";")[0]!;
    if (!res.ok) throw new Error(`${p} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  type Health = { delayMs: number | null; framesDropped: number; framesReceived: number; framesAnalyzed: number };
  type Studio = { readiness: { id: string; status: string }[]; sources: { id: string; health: Health | null }[] };
  csrf = (await call<{ csrfToken: string }>("/api/me")).csrfToken;
  await call("/api/auth/local", { method: "POST", json: { displayName: "Load Test" } });
  csrf = (await call<{ csrfToken: string }>("/api/me")).csrfToken;
  const n = streamsList[0] ?? 1;
  const sources: { id: string; url: string }[] = [];
  for (let i = 0; i < n; i++) {
    const r = await call<{ source: { id: string }; publishUrl: string }>("/api/studio/sources", { method: "POST", json: { name: `Load ${i + 1}`, label: "test" } });
    sources.push({ id: r.source.id, url: r.publishUrl });
  }
  const pubs = sources.map((s) => spawn("bash", [path.join(ROOT, "scripts/publish-test-stream.sh"), s.url], { stdio: "ignore" }));
  const samples: Record<string, { delay: number[]; dropped: number; received: number; analyzed: number }> = {};
  try {
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const studio = await call<Studio>("/api/studio");
      if (studio.readiness.find((x) => x.id === "video_source_ready")?.status === "done") break;
    }
    await call("/api/studio/agent", { method: "POST", json: { enabled: true } });
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      await sleep(2000);
      const studio = await call<Studio>("/api/studio");
      for (const s of studio.sources) {
        if (!sources.some((x) => x.id === s.id) || !s.health) continue;
        const rec = (samples[s.id] ??= { delay: [], dropped: 0, received: 0, analyzed: 0 });
        if (s.health.delayMs !== null) rec.delay.push(s.health.delayMs);
        Object.assign(rec, { dropped: s.health.framesDropped, received: s.health.framesReceived, analyzed: s.health.framesAnalyzed });
      }
    }
  } finally {
    pubs.forEach((p) => p.kill("SIGINT"));
    for (const s of sources) await call(`/api/studio/sources/${s.id}`, { method: "DELETE" }).catch(() => undefined);
  }
  const all = Object.values(samples);
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        hardware: { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? "unknown", memoryGb: Math.round(totalmem() / 2 ** 30) },
        streams: n,
        seconds,
        perSource: all.map((x) => ({ received: x.received, analyzed: x.analyzed, dropped: x.dropped, delayMs: { p50: pct(x.delay, 50), p95: pct(x.delay, 95) } })),
        delayMsAll: { p50: pct(all.flatMap((x) => x.delay), 50), p95: pct(all.flatMap((x) => x.delay), 95) },
      },
      null,
      2,
    ),
  );
}

/* ------------------------------------------------------------------------------------------ */

const main = flag("serve") === "true" ? serve : mode === "ingest" ? ingestMode : serviceMode;
main().catch((err: unknown) => {
  console.error(`load test failed: ${(err as Error).message}`);
  process.exit(1);
});
