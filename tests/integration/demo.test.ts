import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIngestSession, getSourceByPublishPath } from "@slot1/db";
import { QUEUES } from "@slot1/platform";
import { DEMO_LIMITS, DEMO_PUBLISH_PATH, DEMO_SESSION_TITLE, demoHousekeeping, findDemoBroadcaster, reconcileDemo } from "@slot1/services";
import { LiveSupervisor } from "../../apps/worker/src/live/supervisor";
import { Browser, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
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

/**
 * The demo broadcast end to end, with nothing faked: the real generator (apps/worker/src/demo/
 * broadcast.ts) publishes its synthetic scene to a real nginx-rtmp gateway, whose hooks ask the
 * real API; the real live supervisor reads it; SLOT1's real OCR reads the HUD lines. Then the AI
 * view, the demo clip cut from the rolling buffer, the hourly session change, housekeeping, and
 * switching the demo off.
 */
describe.skipIf(!hasNginxRtmp)("demo broadcast through nginx-rtmp", () => {
  let h: Harness;
  let anon: Browser;
  let creator: Browser;
  let nginx: ChildProcess | null = null;
  let supervisor: LiveSupervisor | null = null;
  let generator: ChildProcess | null = null;
  let env: Record<string, string> = {};
  let rtmpPort = 0;
  let sessionId = "";
  let demoId = "";
  const generatorLog: string[] = [];

  beforeAll(async () => {
    rtmpPort = await freePort();
    env = {
      INGEST_GATEWAY: "nginx-rtmp",
      INGEST_PUBLIC_RTMP_URL: `rtmp://127.0.0.1:${rtmpPort}/live`,
      INGEST_READ_URL_TEMPLATE: `rtmp://127.0.0.1:${rtmpPort}/{path}?reader={password}`,
      INGEST_READ_PASSWORD: randomBytes(12).toString("hex"),
      INGEST_HOOK_SECRET: randomBytes(16).toString("hex"),
      SLOT1_DEMO: "true",
      SLOT1_DEMO_STREAM_KEY: randomBytes(16).toString("hex"),
      SLOT1_DEMO_SAMPLE_MS: "2000",
    };
    h = await startHarness(env);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = (h.app.server.address() as AddressInfo).port;
    const runDir = path.join(h.storageRoot, "nginx");
    await mkdir(runDir, { recursive: true });
    const conf = readFileSync(path.join(ROOT, "infra/nginx-rtmp/nginx.conf.template"), "utf8")
      .replaceAll("${SLOT1_HOOK_BASE}", `http://127.0.0.1:${apiPort}`)
      .replaceAll("${INGEST_HOOK_SECRET}", env.INGEST_HOOK_SECRET!)
      .replaceAll("${INGEST_RTMP_PORT}", String(rtmpPort))
      .replaceAll("${NGINX_RUN_DIR}", runDir);
    writeFileSync(path.join(runDir, "nginx.conf"), conf);
    nginx = spawn("nginx", ["-c", path.join(runDir, "nginx.conf"), "-p", runDir, "-g", "daemon off;"], { stdio: "ignore" });
    await sleep(500);
    anon = new Browser(h);
    await anon.refreshCsrf();
    creator = new Browser(h);
    await creator.signInLocal("Night Crew");
  });

  afterAll(async () => {
    generator?.kill("SIGTERM");
    await supervisor?.stopAll();
    nginx?.kill("SIGQUIT");
    await h?.close();
    if (generatorLog.length) console.info(`demo generator log:\n${generatorLog.join("\n").slice(-1500)}`);
  });

  it("creates a public demo channel with a TEST source on start, before anything is sent", async () => {
    const r = await reconcileDemo(h.ctx);
    expect(r.state).toBe("enabled");
    // Idempotent: a second start changes nothing.
    expect((await reconcileDemo(h.ctx)).broadcasterId).toBe(r.broadcasterId);
    demoId = r.broadcasterId!;
    const b = (await findDemoBroadcaster(h.ctx.db))!;
    expect(b).toMatchObject({ kind: "local", login: "slot1-demo", display_name: "SLOT1 Demo" });
    const src = (await getSourceByPublishPath(h.ctx.db, DEMO_PUBLISH_PATH))!;
    expect(src).toMatchObject({ broadcaster_id: demoId, kind: "live_ingest", label: "test", status: "awaiting_publisher" });
    const info = (await anon.get("/api/demo")).json();
    expect(info).toMatchObject({ enabled: true, login: "slot1-demo", watchPath: "/watch/slot1-demo", onAir: false, sessionId: null, ocr: true, vision: false });
    // Visitors read a plain line; the server command that checks the generator is for operators.
    expect(info.reason).toBe("The demo stream isn't running right now.");
    const watch = await anon.get("/api/channels/slot1-demo/watch");
    expect(watch.status).toBe(200);
    expect(watch.json().channel.twitchUrl).toBe("");
    expect(watch.json().channel.broadcast.state).toBe("offline");
    // Hyphenated logins never reach Twitch lookups.
    expect((await anon.get("/api/channels/no-such-thing/watch")).status).toBe(404);
  });

  it("is published by the real generator, read by the worker, and logged from real OCR", async () => {
    supervisor = new LiveSupervisor(h.ctx, "it-demo-worker");
    supervisor.start();
    generator = spawn(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "apps/worker/src/demo/broadcast.ts")], {
      cwd: path.join(ROOT, "apps/worker"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        INGEST_GATEWAY: "nginx-rtmp",
        SLOT1_DEMO: "true",
        SLOT1_DEMO_STREAM_KEY: env.SLOT1_DEMO_STREAM_KEY!,
        SLOT1_DEMO_RTMP_URL: `rtmp://127.0.0.1:${rtmpPort}/live`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    generator.stdout?.on("data", (d: Buffer) => generatorLog.push(d.toString().trim()));
    generator.stderr?.on("data", (d: Buffer) => generatorLog.push(d.toString().trim()));
    sessionId = await waitFor(async () => (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE publish_path = $1 AND status = 'publishing'`, [DEMO_PUBLISH_PATH])).rows[0]?.session_id, 40_000, "the demo to publish");
    const s = (await h.ctx.db.query(`SELECT title, label, visibility, kind FROM stream_sessions WHERE id = $1`, [sessionId])).rows[0];
    expect(s).toEqual({ title: DEMO_SESSION_TITLE, label: "test", visibility: "public", kind: "ingest" });
    // The generator's key never appears in its logs.
    expect(generatorLog.join("\n")).not.toContain(env.SLOT1_DEMO_STREAM_KEY);

    // The first HUD lines of the cycle, read by tesseract from the generated video.
    const lines = await waitFor(async () => {
      const page = (await anon.get(`/api/sessions/${sessionId}/observations?limit=500`)).json<{ observations: any[] }>();
      const ocr = page.observations.filter((o) => o.origin === "ocr");
      return ocr.some((o) => /Keep the engine running/.test(o.rawText ?? "")) ? ocr : null;
    }, 60_000, "the first subtitle to be read");
    expect(lines.find((o) => /Keep the engine running/.test(o.rawText ?? ""))!.type).toBe("subtitle");

    const watch = (await anon.get("/api/channels/slot1-demo/watch")).json();
    expect(watch.authorized).toBe(true);
    expect(watch.session.id).toBe(sessionId);
    expect(watch.channel.broadcast).toMatchObject({ state: "live", title: DEMO_SESSION_TITLE });
    expect((await anon.get("/api/demo")).json()).toMatchObject({ onAir: true, sessionId, reason: null });
  }, 150_000);

  it("shows anyone what the AI saw on the last frame: the frame, the regions and the readings", async () => {
    const view = await waitFor(async () => {
      const r = (await anon.get(`/api/sessions/${sessionId}/ai-view`)).json();
      return r.available && r.snapshot.ocr.regions.some((g: any) => g.readings.length > 0) ? r : null;
    }, 40_000, "an AI view with a reading");
    const s = view.snapshot;
    expect(view.refreshMs).toBe(2000);
    expect(s.source).toEqual({ label: "test", demo: true });
    expect(s.ocr.status).toBe("read");
    expect(s.ocr.regions.map((r: any) => r.id)).toEqual(["bottom_center", "center_banner", "bottom_right_area", "top_right_hud"]);
    expect(s.vision.status).toBe("off");
    expect(s.vision.note).toMatch(/Paid AI vision is off for the demo/);
    expect(s.sampling.intervalMs).toBe(2000);
    expect(s.frame.analyzedWidth).toBe(1280);
    // The image is the analyzed frame, downscaled, served same-origin.
    const img = await anon.get(s.frame.url);
    expect(img.status).toBe(200);
    expect(String(img.headers["content-type"])).toMatch(/image\/jpeg/);
    const jpg = path.join(h.storageRoot, "ai-view.jpg");
    await writeFile(jpg, img.raw);
    const dims = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", jpg]).toString().trim();
    expect(dims).toBe("640,360");
    expect((await anon.get(`/api/sessions/${sessionId}/ai-view/frame/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  }, 60_000);

  it("keeps the AI view of a private stream to its creator", async () => {
    const me = (await creator.refreshCsrf()) as { broadcaster: { id: string } };
    const priv = await createIngestSession(h.ctx.db, me.broadcaster.id, "test", "Private test", "private", 5000);
    expect((await anon.get(`/api/sessions/${priv.id}/ai-view`)).status).toBe(404);
    expect((await anon.get(`/api/sessions/${priv.id}/ai-view/frame/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    const own = await creator.get(`/api/sessions/${priv.id}/ai-view`);
    expect(own.status).toBe(200);
    expect(own.json()).toEqual({ available: false, reason: "The creator isn't sending video to SLOT1 right now, so there's no frame to show", snapshot: null, refreshMs: 2000 });
  });

  it("reads MISSION PASSED and cuts a demo clip from the rolling buffer", async () => {
    const passed = await waitFor(async () => {
      const page = (await anon.get(`/api/sessions/${sessionId}/observations?limit=1000`)).json<{ observations: any[] }>();
      return page.observations.find((o) => o.type === "result_screen" && /MISSION PASSED/.test(o.rawText ?? "")) ?? null;
    }, 90_000, "MISSION PASSED");
    expect(passed.origin).toBe("ocr");
    const clip = await waitFor(async () => {
      const p = (await anon.get("/api/profiles/slot1-demo")).json<{ clips: any[] }>();
      return p.clips.find((c) => c.title === "Demo clip: MISSION PASSED") ?? null;
    }, 60_000, "the demo clip");
    expect(clip).toMatchObject({ kind: "render", status: "ready", visibility: "public" });
    expect(clip.durationMs).toBeGreaterThanOrEqual(6000);
    expect(clip.durationMs).toBeLessThanOrEqual(10_500);
    const file = await anon.get(clip.url);
    expect(file.status).toBe(200);
    expect(String(file.headers["content-type"])).toMatch(/video\/mp4/);
    // Paid AI was never called for the demo.
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM usage_events WHERE broadcaster_id = $1`, [demoId])).rows[0].n).toBe(0);
  }, 170_000);

  it("closes its session when it gets too old and carries on in a new one", async () => {
    const limits = DEMO_LIMITS as { sessionMaxMs: number };
    const before = limits.sessionMaxMs;
    limits.sessionMaxMs = 1000;
    try {
      const next = await waitFor(async () => {
        const r = (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE publish_path = $1`, [DEMO_PUBLISH_PATH])).rows[0];
        return r?.session_id && r.session_id !== sessionId ? (r.session_id as string) : null;
      }, 40_000, "a new demo session");
      limits.sessionMaxMs = before;
      const old = (await h.ctx.db.query(`SELECT ended_at FROM stream_sessions WHERE id = $1`, [sessionId])).rows[0];
      expect(old.ended_at).not.toBeNull();
      sessionId = next;
      await waitFor(async () => {
        const r = (await anon.get(`/api/sessions/${next}/ai-view`)).json();
        return r.available ? r : null;
      }, 40_000, "the AI view in the new session");
    } finally {
      limits.sessionMaxMs = before;
    }
  }, 90_000);

  it("deletes old demo sessions and keeps only the newest clips", async () => {
    const old = await createIngestSession(h.ctx.db, demoId, "test", "Old demo hour", "public", 3000);
    await h.ctx.db.query(`UPDATE stream_sessions SET started_at = now() - interval '5 hours', ended_at = now() - interval '3 hours' WHERE id = $1`, [old.id]);
    for (let i = 0; i < DEMO_LIMITS.maxClips + 5; i++) {
      await h.ctx.db.query(`INSERT INTO library_items (broadcaster_id, kind, title, status, created_at) VALUES ($1, 'render', $2, 'processing', now() - make_interval(mins => $3))`, [demoId, `Old ${i}`, 60 + i]);
    }
    const before = h.jobs.length;
    const r = await demoHousekeeping(h.ctx, demoId);
    expect(r.sessions).toBe(1);
    expect(h.jobs.slice(before)).toContainEqual({ queue: QUEUES.maintenance, name: "delete-session", data: { sessionId: old.id, broadcasterId: demoId } });
    const n = (await h.ctx.db.query(`SELECT count(*)::int AS n FROM library_items WHERE broadcaster_id = $1`, [demoId])).rows[0].n;
    expect(n).toBe(DEMO_LIMITS.maxClips);
  });

  it("disappears everywhere when the demo is switched off", async () => {
    generator?.kill("SIGTERM");
    generator = null;
    const off = await startHarness({ ...env, SLOT1_DEMO: "false" });
    try {
      const r = await reconcileDemo(off.ctx);
      expect(r).toEqual({ state: "disabled", broadcasterId: demoId });
      const src = (await getSourceByPublishPath(off.ctx.db, DEMO_PUBLISH_PATH))!;
      expect(src.status).toBe("revoked");
      expect(src.revoked_at).not.toBeNull();
      const a = new Browser(off);
      await a.refreshCsrf();
      expect((await a.get("/api/channels/slot1-demo/watch")).status).toBe(404);
      expect((await a.get("/api/profiles/slot1-demo")).status).toBe(404);
      expect((await a.get("/api/demo")).json()).toMatchObject({ enabled: false, login: null });
      const now = (await a.get("/api/now")).json<{ streams: { login: string }[] }>();
      expect(now.streams.some((s) => s.login === "slot1-demo")).toBe(false);
      // Its sessions are queued for deletion and its clips are gone.
      const sessions = (await off.ctx.db.query(`SELECT id FROM stream_sessions WHERE broadcaster_id = $1`, [demoId])).rows.map((x) => x.id);
      for (const id of sessions) expect(off.jobs).toContainEqual({ queue: QUEUES.maintenance, name: "delete-session", data: { sessionId: id, broadcasterId: demoId } });
      expect((await off.ctx.db.query(`SELECT count(*)::int AS n FROM library_items WHERE broadcaster_id = $1`, [demoId])).rows[0].n).toBe(0);
      // A publisher with the old key is refused from now on.
      const hook = await a.request("POST", `/api/ingest/hooks/nginx/publish?hook_secret=${env.INGEST_HOOK_SECRET}`, {
        body: `call=publish&name=slot1demo&key=${env.SLOT1_DEMO_STREAM_KEY}&addr=127.0.0.1&app=live`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        csrf: false,
      });
      expect(hook.status).toBe(403);
    } finally {
      await off.close();
    }
  }, 60_000);
});
