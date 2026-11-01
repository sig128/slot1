import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

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

/**
 * Continuous ingest end to end: a real nginx-rtmp gateway calls SLOT1's publish/play hooks, the
 * real live supervisor reads the stream, OCR analyzes frames, and a disconnect turns the rail
 * stale. Skipped when nginx with the RTMP module isn't installed.
 */
describe.skipIf(!hasNginxRtmp)("continuous ingest through nginx-rtmp", () => {
  let h: Harness;
  let creator: Browser;
  let nginx: ChildProcess | null = null;
  let supervisor: LiveSupervisor | null = null;
  let rtmpPort = 0;
  let publishUrl = "";
  let sourceId = "";
  const publishers: ChildProcess[] = [];

  beforeAll(async () => {
    rtmpPort = await freePort();
    const env = {
      INGEST_GATEWAY: "nginx-rtmp",
      INGEST_PUBLIC_RTMP_URL: `rtmp://127.0.0.1:${rtmpPort}/live`,
      INGEST_READ_URL_TEMPLATE: `rtmp://127.0.0.1:${rtmpPort}/{path}?reader={password}`,
      INGEST_READ_PASSWORD: randomBytes(12).toString("hex"),
      INGEST_HOOK_SECRET: randomBytes(16).toString("hex"),
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

    creator = new Browser(h);
    await creator.signInLocal("Capture Crew");
    supervisor = new LiveSupervisor(h.ctx, "it-worker");
    supervisor.start();
  });

  afterAll(async () => {
    for (const p of publishers) p.kill("SIGKILL");
    await supervisor?.stopAll();
    nginx?.kill("SIGQUIT");
    await h?.close();
  });

  function publish(url: string, seconds?: number) {
    const args = ["-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", SAMPLE];
    if (seconds) args.push("-t", String(seconds));
    args.push("-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "flv", url);
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    publishers.push(p);
    return p;
  }

  it("creates a TEST source whose key is shown once and stored only as a hash", async () => {
    const r = await creator.request("POST", "/api/studio/sources", { json: { name: "Capture card", label: "test" } });
    expect(r.status).toBe(200);
    const body = r.json<{ source: { id: string; label: string; publish: { keyHint: string } }; streamKey: string; publishUrl: string }>();
    expect(body.source.label).toBe("test");
    publishUrl = body.publishUrl;
    sourceId = body.source.id;
    const secret = new URL(publishUrl.replace(/^rtmp:/, "http:")).searchParams.get("key")!;
    const { rows } = await h.ctx.db.query(`SELECT publish_key_hash::text AS hash, publish_key_hint FROM media_sources WHERE id = $1`, [sourceId]);
    expect(rows[0].hash).not.toContain(secret);
    expect(secret.endsWith(rows[0].publish_key_hint)).toBe(true);
    const studio = (await creator.get("/api/studio")).json();
    expect(JSON.stringify(studio)).not.toContain(secret);
  });

  it("refuses a publisher with the wrong key and readers without the worker credential", async () => {
    const bad = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-t", "3", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-c:v", "libx264", "-preset", "ultrafast", "-f", "flv", publishUrl.replace(/key=[^&]+/, "key=wrong")], { timeout: 20_000 });
    expect(bad.status).not.toBe(0);
    const src = await h.ctx.db.query(`SELECT status FROM media_sources WHERE id = $1`, [sourceId]);
    expect(src.rows[0].status).not.toBe("publishing");
  });

  it("receives frames, then analyzes them once the agent is enabled", async () => {
    publish(publishUrl);
    await waitFor(async () => (await h.ctx.db.query(`SELECT 1 FROM media_sources WHERE id = $1 AND status = 'publishing'`, [sourceId])).rowCount, 15_000, "publish hook");
    // Readers other than the SLOT1 worker are refused while the stream is live.
    const pathName = publishUrl.replace(/^rtmp:\/\/[^/]+\//, "").split("?")[0];
    const anon = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-rw_timeout", "8000000", "-i", `rtmp://127.0.0.1:${rtmpPort}/${pathName}`, "-frames:v", "1", "-f", "null", "-"], { timeout: 20_000 });
    expect(anon.status).not.toBe(0);

    await waitFor(async () => {
      const s = (await creator.get("/api/studio")).json();
      return s.readiness.find((x: { id: string }) => x.id === "video_source_ready")?.status === "done";
    }, 40_000, "first frames");
    // Enabling the agent is allowed only now that real frames are arriving.
    expect((await creator.request("POST", "/api/studio/agent", { json: { enabled: true } })).status).toBe(200);

    const sessionId = await waitFor(async () => (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE id = $1`, [sourceId])).rows[0]?.session_id as string | null, 20_000, "ingest session");
    const texts = await waitFor(async () => {
      const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=200`)).json<{ observations: { rawText: string | null; evidence: unknown[] }[] }>();
      const t = page.observations.map((o) => o.rawText ?? "").join(" | ");
      return /MISSION PASSED|Vespucci|12,450|docks/i.test(t) ? t : null;
    }, 90_000, "OCR observations from the live stream");
    expect(texts.length).toBeGreaterThan(0);

    const session = (await creator.get(`/api/sessions/${sessionId}`)).json();
    expect(session.kind).toBe("ingest");
    expect(session.label).toBe("test");
    expect(["live_vision", "delayed"]).toContain(session.analysis.state);
  });

  it("turns stale when the publisher disconnects, and a revoked key can't publish again", async () => {
    for (const p of publishers) p.kill("SIGINT");
    const sessionId = (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE id = $1`, [sourceId])).rows[0].session_id as string;
    await waitFor(async () => {
      const s = (await creator.get(`/api/sessions/${sessionId}`)).json();
      return s.analysis.state === "stale" ? s : null;
    }, 45_000, "stale state after disconnect");

    expect((await creator.request("DELETE", `/api/studio/sources/${sourceId}`)).status).toBe(200);
    const again = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-t", "3", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-c:v", "libx264", "-preset", "ultrafast", "-f", "flv", publishUrl], { timeout: 20_000 });
    expect(again.status).not.toBe(0);
  });
});

describe("ingest gateway hooks", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      INGEST_GATEWAY: "mediamtx",
      INGEST_PUBLIC_RTMP_URL: "rtmp://127.0.0.1:1935",
      INGEST_READ_URL_TEMPLATE: "rtsp://{user}:{password}@127.0.0.1:8554/{path}",
      INGEST_READ_PASSWORD: "worker-pass",
      INGEST_HOOK_SECRET: "hook-secret",
    });
  });
  afterAll(async () => h?.close());

  const auth = (body: Record<string, string>, secret = "hook-secret") =>
    h.app.inject({ method: "POST", url: `/api/ingest/hooks/mediamtx/auth?hook_secret=${secret}`, payload: body });

  it("rejects hook calls without the shared secret", async () => {
    expect((await auth({ action: "publish", path: "live/abcd1234", user: "abcd1234", password: "x" }, "wrong")).statusCode).toBe(403);
    expect((await h.app.inject({ method: "POST", url: "/api/ingest/hooks/nginx/publish", payload: "app=live&name=abcd1234&key=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(403);
  });

  it("authorizes MediaMTX publish by stream key and reads only for the worker", async () => {
    const creator = new Browser(h);
    await creator.signInLocal("MediaMTX Crew");
    const created = (await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "live" } })).json<{ streamKey: string; source: { id: string } }>();
    const [name, query] = created.streamKey.split("?");
    const pass = new URLSearchParams(query).get("pass")!;
    // RTSP-style first attempt without credentials gets a 401 challenge.
    expect((await auth({ action: "publish", path: `live/${name}` })).statusCode).toBe(401);
    expect((await auth({ action: "publish", path: `live/${name}`, user: name!, password: "nope" })).statusCode).toBe(403);
    expect((await auth({ action: "publish", path: `live/${name}`, user: "someoneelse", password: pass })).statusCode).toBe(403);
    expect((await auth({ action: "publish", path: `live/${name}`, user: name!, password: pass })).statusCode).toBe(200);
    expect((await auth({ action: "read", path: `live/${name}`, user: name!, password: pass })).statusCode).toBe(403);
    expect((await auth({ action: "read", path: `live/${name}`, user: "slot1-worker", password: "worker-pass" })).statusCode).toBe(200);
    expect((await auth({ action: "publish", path: "../etc/passwd", user: name!, password: pass })).statusCode).toBe(403);
  });
});
