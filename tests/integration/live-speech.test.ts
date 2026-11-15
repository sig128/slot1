import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveSupervisor } from "../../apps/worker/src/live/supervisor";
import { Browser, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const RTMP_MODULE = "/usr/lib/nginx/modules/ngx_rtmp_module.so";
const hasNginxRtmp = (() => {
  try {
    execFileSync("nginx", ["-v"], { stdio: "ignore" });
    return existsSync(RTMP_MODULE);
  } catch {
    return false;
  }
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1000);
  }
}
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A Whisper-style speech service (OpenAI-compatible): it hears Turkish in every chunk. */
class MockWhisper {
  server: Server;
  base = "";
  requests: { contentType: string; model: string; format: string; bytes: number; auth: string }[] = [];
  constructor() {
    this.server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const body = Buffer.concat(chunks);
          const form = await new Request("http://x", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body }).formData();
          const file = form.get("file") as File;
          this.requests.push({ contentType: file.type, model: String(form.get("model")), format: String(form.get("response_format")), bytes: file.size, auth: String(req.headers.authorization) });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: " Polis geliyor, kaçın! ", language: "turkish", segments: [{ start: 0.4, end: 2.1, text: " Polis geliyor, kaçın!" }] }));
        })();
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

/**
 * Live speech end to end: a real stream with sound goes through the gateway, the worker's audio
 * reader cuts it into chunks, the speech service (a mock Whisper) detects the language, and what
 * was said lands in the live log with the original words and transcript evidence. Nothing is
 * sent while the creator hasn't switched transcripts on.
 */
describe.skipIf(!hasNginxRtmp)("live speech transcripts, any language", () => {
  let h: Harness;
  let whisper: MockWhisper;
  let nginx: ChildProcess | null = null;
  let supervisor: LiveSupervisor | null = null;
  const publishers: ChildProcess[] = [];

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    whisper = await new MockWhisper().start();
    const rtmpPort = await freePort();
    const env = {
      INGEST_GATEWAY: "nginx-rtmp",
      INGEST_PUBLIC_RTMP_URL: `rtmp://127.0.0.1:${rtmpPort}/live`,
      INGEST_READ_URL_TEMPLATE: `rtmp://127.0.0.1:${rtmpPort}/{path}?reader={password}`,
      INGEST_READ_PASSWORD: randomBytes(12).toString("hex"),
      INGEST_HOOK_SECRET: randomBytes(16).toString("hex"),
      TRANSCRIPTION_PROVIDER: "openai_compatible",
      TRANSCRIPTION_BASE_URL: whisper.base,
      TRANSCRIPTION_MODEL: "whisper-large-v3-turbo",
      TRANSCRIPTION_API_KEY: "gsk_test_key_0123456789",
    };
    h = await startHarness(env);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = (h.app.server.address() as AddressInfo).port;
    const runDir = path.join(h.storageRoot, "nginx");
    await mkdir(runDir, { recursive: true });
    const conf = readFileSync(path.join(ROOT, "infra/nginx-rtmp/nginx.conf.template"), "utf8")
      .replaceAll("${SLOT1_HOOK_BASE}", `http://127.0.0.1:${apiPort}`)
      .replaceAll("${INGEST_HOOK_SECRET}", env.INGEST_HOOK_SECRET)
      .replaceAll("${INGEST_RTMP_PORT}", String(rtmpPort))
      .replaceAll("${NGINX_RUN_DIR}", runDir);
    writeFileSync(path.join(runDir, "nginx.conf"), conf);
    nginx = spawn("nginx", ["-c", path.join(runDir, "nginx.conf"), "-p", runDir, "-g", "daemon off;"], { stdio: "ignore" });
    await sleep(500);
    supervisor = new LiveSupervisor(h.ctx, "it-speech-worker");
    supervisor.start();
  });

  afterAll(async () => {
    for (const p of publishers) p.kill("SIGKILL");
    await supervisor?.stopAll();
    nginx?.kill("SIGQUIT");
    await h?.close();
    await whisper?.stop();
  });

  it("logs what's said, with the language detected, only once the creator switches it on", async () => {
    const creator = new Browser(h);
    await creator.signInLocal("Speech Crew");
    const src = (await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "test" } })).json<{ source: { id: string }; publishUrl: string }>();
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-i", SAMPLE, "-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "flv", src.publishUrl], { stdio: "ignore" });
    publishers.push(p);
    const sessionId = await waitFor(async () => (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE id = $1 AND status = 'publishing'`, [src.source.id])).rows[0]?.session_id as string | undefined, 20_000, "publish");
    await waitFor(async () => (await creator.get("/api/studio")).json().readiness.find((x: { id: string }) => x.id === "video_source_ready")?.status === "done", 30_000, "first frames");

    // Analysis on, transcripts still off: nothing goes to the speech service.
    expect((await creator.request("POST", "/api/studio/agent", { json: { enabled: true } })).status).toBe(200);
    await sleep(6000);
    expect(whisper.requests).toHaveLength(0);

    // The creator switches transcripts on: the next reader run listens.
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { speechTranscripts: true } })).status).toBe(200);
    const said = await waitFor(
      async () =>
        (
          await h.ctx.db.query(
            `SELECT description, origin, raw_text, evidence, model_provider, model_version FROM observations WHERE session_id = $1 AND type = 'dialogue' ORDER BY media_start_ms LIMIT 1`,
            [sessionId],
          )
        ).rows[0],
      40_000,
      "a transcribed line in the live log",
    );
    expect(said).toMatchObject({
      description: "Said (Turkish): “Polis geliyor, kaçın!”",
      origin: "audio",
      raw_text: "Polis geliyor, kaçın!",
      model_provider: "openai_compatible",
      model_version: "whisper-large-v3-turbo",
    });
    // Chunks went as 16 kHz mono WAV (12 s ≈ 384 KB), with the key, asking for the detected language.
    expect(whisper.requests[0]).toMatchObject({ contentType: "audio/wav", model: "whisper-large-v3-turbo", format: "verbose_json", auth: "Bearer gsk_test_key_0123456789" });
    expect(whisper.requests[0]!.bytes).toBeGreaterThan(300_000);
    expect(whisper.requests[0]!.bytes).toBeLessThan(400_000);

    // The evidence is the transcript (text only), kept with the frames.
    const ev = (said.evidence as { assetId: string; kind: string }[])[0]!;
    expect(ev.kind).toBe("transcript");
    const asset = (await h.ctx.db.query(`SELECT kind, content_type, storage_key, expires_at FROM evidence_assets WHERE id = $1`, [ev.assetId])).rows[0];
    expect(asset).toMatchObject({ kind: "transcript", content_type: "application/json" });
    expect(asset.expires_at).not.toBeNull();
    const stored = JSON.parse(await readFile(path.join(h.storageRoot, "storage", asset.storage_key), "utf8"));
    expect(stored).toMatchObject({ language: "turkish", languageName: "Turkish", text: "Polis geliyor, kaçın!", provider: "openai_compatible" });
    expect(stored.segments[0]).toMatchObject({ text: "Polis geliyor, kaçın!" });
    // No audio is kept anywhere.
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM evidence_assets WHERE session_id = $1 AND kind = 'audio_chunk'`, [sessionId])).rows[0].n).toBe(0);
  }, 150_000);
});
