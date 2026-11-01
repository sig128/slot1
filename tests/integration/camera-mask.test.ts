import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateSettings } from "@slot1/db";
import { LiveSupervisor } from "../../apps/worker/src/live/supervisor";
import { Browser, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const RTMP_MODULE = "/usr/lib/nginx/modules/ngx_rtmp_module.so";
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const hasTools = (() => {
  try {
    execFileSync("nginx", ["-v"], { stdio: "ignore" });
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    return existsSync(RTMP_MODULE) && existsSync(FONT);
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
 * Mean brightness (0–255, limited-range gray, so black reads about 16) of a box inside an image or
 * a video's first frame, the box given as fractions of the picture. ffmpeg does the decoding, so
 * the test reads the pixels exactly as stored, with no image library in between.
 */
function brightness(file: string, box: { x: number; y: number; w: number; h: number }): number {
  const crop = `crop=floor(iw*${box.w}):floor(ih*${box.h}):floor(iw*${box.x}):floor(ih*${box.y})`;
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", `format=gray,${crop},scale=1:1:flags=area`, "-f", "rawvideo", "-"]);
  return out[0]!;
}

/** Where the test picture puts things (fractions of the frame). */
const CAM = { x: 0, y: 0, w: 0.4, h: 0.4 }; // the "webcam": white, with SECRET CAM TEXT on it
const INSIDE_CAM = { x: 0.03, y: 0.05, w: 0.34, h: 0.3 };
const OPEN_GRAY = { x: 0.45, y: 0.05, w: 0.15, h: 0.25 }; // plain gray, never hidden
const LOWER_RIGHT = { x: 0.6, y: 0.6, w: 0.4, h: 0.4 };

/**
 * "Hide your camera from the AI", end to end with real tools: a real ffmpeg publisher sends a test
 * picture (a white "webcam" with text on it, plain gray, and MISSION PASSED) into a real
 * nginx-rtmp gateway; the real live supervisor reads it, real tesseract reads the text, and the
 * real Anthropic vision client sends frames to a local stand-in of Anthropic's API that records
 * the images it receives. Checks every place a frame goes after the worker samples it.
 */
describe.skipIf(!hasTools)("hide your camera from the AI", () => {
  let h: Harness;
  let anon: Browser;
  let creator: Browser;
  let other: Browser;
  let nginx: ChildProcess | null = null;
  let publisher: ChildProcess | null = null;
  let supervisor: LiveSupervisor | null = null;
  let vision: Server | null = null;
  const visionImages: Buffer[] = [];
  let sourceId = "";
  let sessionId = "";
  let broadcasterId = "";
  let work = "";

  beforeAll(async () => {
    // A stand-in for Anthropic's Messages API: records every image, answers with a valid result.
    vision = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        try {
          const json = JSON.parse(body) as { messages: { content: { type: string; source?: { data: string } }[] }[] };
          for (const m of json.messages) for (const c of m.content) if (c.type === "image" && c.source) visionImages.push(Buffer.from(c.source.data, "base64"));
        } catch {
          /* ignore */
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify({ scene: { summary: "A test picture", isGameplay: "no" }, findings: [] }) }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
            model: "claude-it",
          }),
        );
      });
    });
    await new Promise<void>((r) => vision!.listen(0, "127.0.0.1", () => r()));
    const visionPort = (vision.address() as AddressInfo).port;

    const rtmpPort = await freePort();
    const env = {
      INGEST_GATEWAY: "nginx-rtmp",
      INGEST_PUBLIC_RTMP_URL: `rtmp://127.0.0.1:${rtmpPort}/live`,
      INGEST_READ_URL_TEMPLATE: `rtmp://127.0.0.1:${rtmpPort}/{path}?reader={password}`,
      INGEST_READ_PASSWORD: randomBytes(12).toString("hex"),
      INGEST_HOOK_SECRET: randomBytes(16).toString("hex"),
      VISION_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "it-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${visionPort}`,
      ANTHROPIC_VISION_MODEL: "claude-it",
      VISION_FRAMES_PER_CALL: "2",
    };
    h = await startHarness(env);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = (h.app.server.address() as AddressInfo).port;
    work = path.join(h.storageRoot, "mask");
    const runDir = path.join(h.storageRoot, "nginx");
    await mkdir(runDir, { recursive: true });
    await mkdir(work, { recursive: true });
    const conf = readFileSync(path.join(ROOT, "infra/nginx-rtmp/nginx.conf.template"), "utf8")
      .replaceAll("${SLOT1_HOOK_BASE}", `http://127.0.0.1:${apiPort}`)
      .replaceAll("${INGEST_HOOK_SECRET}", env.INGEST_HOOK_SECRET)
      .replaceAll("${INGEST_RTMP_PORT}", String(rtmpPort))
      .replaceAll("${NGINX_RUN_DIR}", runDir);
    writeFileSync(path.join(runDir, "nginx.conf"), conf);
    nginx = spawn("nginx", ["-c", path.join(runDir, "nginx.conf"), "-p", runDir, "-g", "daemon off;"], { stdio: "ignore" });
    await sleep(500);
    anon = new Browser(h);
    await anon.refreshCsrf();
    creator = new Browser(h);
    const me = (await creator.signInLocal("Mask Crew")) as { broadcaster: { id: string } };
    broadcasterId = me.broadcaster.id;
    other = new Browser(h);
    await other.signInLocal("Someone Else");
  });

  afterAll(async () => {
    publisher?.kill("SIGTERM");
    await supervisor?.stopAll();
    nginx?.kill("SIGQUIT");
    vision?.close();
    await h?.close();
  });

  it("lets only the source's creator save boxes, and only valid ones", async () => {
    const created = await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "live" } });
    expect(created.status).toBe(200);
    const c = created.json<{ source: { id: string; cameraMask: unknown[] }; publishUrl: string }>();
    sourceId = c.source.id;
    expect(c.source.cameraMask).toEqual([]);
    await writeFile(path.join(work, "publish-url.txt"), c.publishUrl);

    const url = `/api/studio/sources/${sourceId}/camera-mask`;
    const ok = await creator.request("PUT", url, { json: { boxes: [{ ...CAM, x: 0.000004 }] } });
    expect(ok.status).toBe(200);
    expect(ok.json<{ source: { cameraMask: unknown[] } }>().source.cameraMask).toEqual([CAM]);
    // Studio's overview shows it too.
    const studio = (await creator.get("/api/studio")).json<{ sources: { id: string; cameraMask: unknown[] }[] }>();
    expect(studio.sources.find((s) => s.id === sourceId)!.cameraMask).toEqual([CAM]);

    // Nobody else can change (or discover) it.
    expect((await other.request("PUT", url, { json: { boxes: [] } })).status).toBe(404);
    expect((await anon.request("PUT", url, { json: { boxes: [] } })).status).toBe(401);
    // Boxes must be inside the picture, big enough, and at most three.
    expect((await creator.request("PUT", url, { json: { boxes: [{ x: 0.8, y: 0, w: 0.3, h: 0.3 }] } })).status).toBe(400);
    expect((await creator.request("PUT", url, { json: { boxes: [{ x: 0, y: 0, w: 0.001, h: 0.3 }] } })).status).toBe(400);
    expect((await creator.request("PUT", url, { json: { boxes: Array.from({ length: 4 }, () => CAM) } })).status).toBe(400);
    expect((await creator.request("PUT", "/api/studio/sources/00000000-0000-4000-8000-000000000000/camera-mask", { json: { boxes: [] } })).status).toBe(404);
    // Still the creator's saved box.
    const row = (await h.ctx.db.query(`SELECT camera_mask FROM media_sources WHERE id = $1`, [sourceId])).rows[0];
    expect(row.camera_mask).toEqual([CAM]);
  });

  it("blacks the box out before OCR, AI vision, stored evidence and the AI view, and nowhere else", async () => {
    await updateSettings(h.ctx.db, broadcasterId, {
      agentEnabled: true,
      sampleIntervalMs: 2000,
      gameProfile: "generic",
      recordingConsent: true,
      rollingBufferEnabled: true,
      rollingBufferSeconds: 30,
    });
    const publishUrl = (await readFile(path.join(work, "publish-url.txt"), "utf8")).trim();
    const text = (file: string, s: string) => {
      writeFileSync(path.join(work, file), s);
      return path.join(work, file).replace(/:/g, "\\:");
    };
    const secret = text("secret.txt", "SECRET CAM TEXT");
    const passed = text("passed.txt", "MISSION PASSED");
    const vf = [
      // The "webcam": a white box in the top left with text on it.
      "drawbox=x=0:y=0:w=512:h=288:color=white:t=fill",
      `drawtext=fontfile=${FONT}:textfile=${secret}:fontsize=44:fontcolor=black:x=40:y=120`,
      // Text the AI should read, outside the box (dark on light: tesseract's most reliable case).
      "drawbox=x=700:y=520:w=560:h=110:color=white:t=fill",
      `drawtext=fontfile=${FONT}:textfile=${passed}:fontsize=52:fontcolor=black:x=730:y=545`,
    ].join(",");
    publisher = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "color=0x808080:s=1280x720:r=15", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-g", "15", "-pix_fmt", "yuv420p", "-f", "flv", publishUrl],
      { stdio: "ignore" },
    );
    supervisor = new LiveSupervisor(h.ctx, "it-mask-worker");
    supervisor.start();
    sessionId = await waitFor(
      async () => (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE id = $1 AND status = 'publishing'`, [sourceId])).rows[0]?.session_id,
      40_000,
      "the test stream to publish",
    );

    // The AI view stores snapshots only while someone looks: keep looking (as the creator).
    const snapshot = async () => {
      const r = (await creator.get(`/api/sessions/${sessionId}/ai-view`)).json<{ available: boolean; snapshot: any }>();
      return r.available ? r.snapshot : null;
    };

    // OCR read the text outside the box, from the masked frames.
    const observations = await waitFor(async () => {
      await snapshot();
      const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=500`)).json<{ observations: any[] }>();
      return page.observations.some((o) => /MISSION PASSED/i.test(`${o.rawText ?? ""} ${o.description ?? ""}`)) ? page.observations : null;
    }, 90_000, "OCR to read MISSION PASSED");
    // …and never the text inside it.
    const everything = JSON.stringify(observations);
    expect(everything).not.toMatch(/SECRET/i);
    expect(everything).not.toMatch(/CAM TEXT/i);

    // The vision provider received frames, and the box is black in every one of them.
    await waitFor(async () => visionImages.length > 0, 30_000, "a vision request");
    for (const [i, img] of visionImages.entries()) {
      const f = path.join(work, `vision-${i}.jpg`);
      await writeFile(f, img);
      expect(brightness(f, INSIDE_CAM), `vision image ${i}: inside the hidden box`).toBeLessThan(40);
      expect(brightness(f, OPEN_GRAY), `vision image ${i}: the open gray area`).toBeGreaterThan(90);
    }

    // Stored evidence frames: black inside the box too.
    const frames = await waitFor(async () => {
      const rows = (await h.ctx.db.query(`SELECT storage_key FROM evidence_assets WHERE session_id = $1 AND kind = 'frame' AND deleted_at IS NULL`, [sessionId])).rows;
      return rows.length ? rows : null;
    }, 30_000, "a stored evidence frame");
    for (const r of frames.slice(0, 5)) {
      const f = path.join(h.storageRoot, "storage", r.storage_key);
      expect(brightness(f, INSIDE_CAM), `${r.storage_key}: inside the hidden box`).toBeLessThan(40);
      expect(brightness(f, OPEN_GRAY)).toBeGreaterThan(90);
    }

    // "What the AI sees": the snapshot names the hidden box, and its frame is black there.
    const s = await waitFor(snapshot, 30_000, "an AI view snapshot");
    expect(s.hidden).toEqual([[CAM.x, CAM.y, CAM.w, CAM.h]]);
    const img = await creator.get(s.frame.url);
    expect(img.status).toBe(200);
    const viewFile = path.join(work, "ai-view.jpg");
    await writeFile(viewFile, img.raw);
    expect(brightness(viewFile, INSIDE_CAM)).toBeLessThan(40);

    // Viewers' copy is untouched: the rolling buffer (instant replays) still has the white webcam.
    const bufferDir = path.resolve(h.ctx.config.env.INGEST_SEGMENT_DIR, sourceId);
    const segment = await waitFor(async () => {
      const names = (await readdir(bufferDir).catch(() => [] as string[])).filter((n) => n.endsWith(".ts"));
      const sized = await Promise.all(names.map(async (n) => ({ n, size: (await stat(path.join(bufferDir, n))).size, at: (await stat(path.join(bufferDir, n))).mtimeMs })));
      // A finished segment: not the one being written (the newest).
      const done = sized.filter((x) => x.size > 20_000).sort((a, b) => a.at - b.at);
      return done.length >= 2 ? path.join(bufferDir, done[0]!.n) : null;
    }, 40_000, "a finished rolling-buffer segment");
    expect(brightness(segment, INSIDE_CAM), "the viewers' stream keeps the webcam").toBeGreaterThan(200);
  }, 240_000);

  it("applies a changed box within seconds", async () => {
    const r = await creator.request("PUT", `/api/studio/sources/${sourceId}/camera-mask`, { json: { boxes: [LOWER_RIGHT] } });
    expect(r.status).toBe(200);
    const s = await waitFor(async () => {
      const v = (await creator.get(`/api/sessions/${sessionId}/ai-view`)).json<{ available: boolean; snapshot: any }>();
      return v.available && JSON.stringify(v.snapshot.hidden) === JSON.stringify([[0.6, 0.6, 0.4, 0.4]]) ? v.snapshot : null;
    }, 45_000, "the AI view to use the new box");
    const img = await creator.get(s.frame.url);
    const f = path.join(work, "ai-view-2.jpg");
    await writeFile(f, img.raw);
    // The old box is visible again (the white webcam), the new one is black.
    expect(brightness(f, INSIDE_CAM)).toBeGreaterThan(200);
    expect(brightness(f, { x: 0.62, y: 0.62, w: 0.36, h: 0.36 })).toBeLessThan(40);
  }, 90_000);
});
