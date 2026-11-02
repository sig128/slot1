import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReplaySession, getRecordingBySession, insertObservation } from "@slot1/db";
import { sweepInstantReplays } from "@slot1/services";
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
const FPS = 30;

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

function probe(file: string) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,start_time:stream=codec_type,height,start_time", "-of", "json", file]).toString());
  const v = j.streams.find((s: any) => s.codec_type === "video");
  return {
    durationMs: Math.round(Number(j.format.duration) * 1000),
    startMs: Math.round(Number(v?.start_time ?? j.format.start_time) * 1000),
    height: v?.height as number,
    audio: j.streams.some((s: any) => s.codec_type === "audio"),
  };
}
function topBoxes(file: string): string[] {
  const fd = openSync(file, "r");
  const out: string[] = [];
  try {
    let pos = 0;
    const head = Buffer.alloc(16);
    for (let i = 0; i < 12; i++) {
      if (readSync(fd, head, 0, 16, pos) < 8) break;
      let size = head.readUInt32BE(0);
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      out.push(head.toString("latin1", 4, 8));
      if (size < 8) break;
      pos += size;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}
/** A tiny grayscale thumbnail of frame `n` (decoded from the start, no seeking involved). */
function gray(file: string, n: number): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n}),scale=160:90,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"]);
}
/** Every video frame of one stored segment: its time from the segment's start, and a thumbnail. */
function segmentFrames(file: string): { times: number[]; thumbs: Buffer[] } {
  const start = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", file]).toString().trim());
  const times = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file])
    .toString()
    .trim()
    .split(/\r?\n/)
    .map((x) => Number(x.split(",")[0]) - start);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 256 * 1024 * 1024 });
  const size = 160 * 90;
  const thumbs = Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  return { times: times.slice(0, thumbs.length), thumbs };
}
const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

type Ready = { status: "ready"; url: string; source: string; startMs: number; endMs: number; momentOffsetMs: number | null; durationMs: number; expiresAt: string };

/**
 * Instant replay end to end: a real nginx-rtmp publish read by the real live supervisor, a replay
 * cut from the recording segments it stored (start checked frame by frame against those
 * segments), a replay cut from the rolling buffer by the worker holding it, honest reasons when
 * it's off, and access exactly like the session's live video.
 */
describe.skipIf(!hasNginxRtmp)("instant replay through nginx-rtmp", () => {
  let h: Harness;
  let creator: Browser;
  let stranger: Browser;
  let anon: Browser;
  let nginx: ChildProcess | null = null;
  let supervisor: LiveSupervisor | null = null;
  let publisher: ChildProcess | null = null;
  let broadcasterId = "";
  let sourceId = "";
  let sessionId = "";
  let recordedObs: { id: string; receivedAt: string; mediaStartMs: number } | null = null;
  let work = "";

  /** Ask until the replay is cut (the end of the window may still be being saved). */
  async function replay(b: Browser, body: Record<string, unknown>, timeoutMs = 45_000): Promise<{ r: Ready; ms: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t0 = Date.now();
      const res = await b.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: body });
      const ms = Date.now() - t0;
      expect(res.status).toBe(200);
      const j = res.json();
      if (j.status === "ready") return { r: j as Ready, ms };
      if (j.status === "unavailable") throw new Error(`replay unavailable: ${j.reason}`);
      if (Date.now() > deadline) throw new Error(`replay still pending: ${j.reason}`);
      await sleep(Math.min(4000, j.retryAfterMs));
    }
  }
  async function download(b: Browser, url: string, name: string): Promise<string> {
    const res = await b.get(url);
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/video\/mp4/);
    const file = path.join(work, name);
    await writeFile(file, res.raw);
    return file;
  }
  /** A MISSION PASSED reading received at least `afterMs` after `sinceIso`. */
  async function passedAfter(sinceMs: number, timeoutMs: number) {
    return waitFor(async () => {
      const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=1000`)).json<{ observations: any[] }>();
      return page.observations.find((o) => o.origin === "ocr" && /MISSION PASSED/i.test(o.rawText ?? "") && o.mediaStartMs !== null && Date.parse(o.receivedAt) >= sinceMs) ?? null;
    }, timeoutMs, "a MISSION PASSED reading");
  }

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    work = await mkdtemp(path.join(tmpdir(), "slot1-ireplay-it-"));
    const rtmpPort = await freePort();
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
    stranger = new Browser(h);
    anon = new Browser(h);
    broadcasterId = ((await creator.signInLocal("Replay Crew")) as { broadcaster: { id: string } }).broadcaster.id;
    await stranger.signInLocal("Couch Viewer");
    await anon.refreshCsrf();
    supervisor = new LiveSupervisor(h.ctx, "it-ireplay-worker");
    supervisor.start();
  });

  afterAll(async () => {
    publisher?.kill("SIGKILL");
    await supervisor?.stopAll();
    nginx?.kill("SIGQUIT");
    await h?.close();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("says exactly why it's off until recording or the rolling buffer is on", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { visibility: "public", publicAnalysis: true } })).status).toBe(200);
    const src = (await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "test" } })).json<{ source: { id: string }; publishUrl: string }>();
    sourceId = src.source.id;
    // The sample on a loop, in real time, like OBS would send it.
    publisher = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", SAMPLE, "-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "flv", src.publishUrl],
      { stdio: "ignore" },
    );
    sessionId = await waitFor(async () => (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE id = $1 AND status = 'publishing'`, [sourceId])).rows[0]?.session_id, 20_000, "publish");
    await waitFor(async () => {
      const s = (await creator.get("/api/studio")).json();
      return s.readiness.find((x: { id: string }) => x.id === "video_source_ready")?.status === "done";
    }, 30_000, "first frames");
    expect((await creator.request("PATCH", `/api/sessions/${sessionId}`, { json: { visibility: "public" } })).status).toBe(200);

    const off = "Instant replay is off: the creator hasn't turned on recording or the rolling buffer in Studio.";
    for (const b of [creator, stranger, anon]) {
      const st = await b.get(`/api/sessions/${sessionId}/instant-replay`);
      expect(st.status).toBe(200);
      expect(st.json()).toEqual({ available: false, reason: off, source: null, bufferSeconds: null });
    }
    const r = await creator.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: { observationId: randomUUID() } });
    expect(r.json()).toEqual({ status: "unavailable", reason: off });
    // Exactly one of a moment or "the last N seconds".
    expect((await creator.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: {} })).status).toBe(400);

    const upload = await createReplaySession(h.ctx.db, broadcasterId, "Uploaded run", "private");
    expect((await creator.get(`/api/sessions/${upload.id}/instant-replay`)).json().reason).toMatch(/^This is an uploaded replay/);
    expect((await stranger.get(`/api/sessions/${upload.id}/instant-replay`)).status).toBe(404);
  }, 60_000);

  it("cuts an exact window around a moment from the recorded segments", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { recordingConsent: true, recordingEnabled: true } })).status).toBe(200);
    expect((await creator.request("POST", "/api/studio/agent", { json: { enabled: true } })).status).toBe(200);
    const run = await waitFor(async () => {
      const rec = await getRecordingBySession(h.ctx.db, sessionId);
      const open = rec?.runs.find((x) => x.wallEnd === null && x.segments.length > 0);
      return open ?? null;
    }, 40_000, "a recording run");
    // A moment with the full 8 s run-up inside this run.
    const o = await passedAfter(Date.parse(run.wallStart) + 12_000, 100_000);
    recordedObs = { id: o.id, receivedAt: o.receivedAt, mediaStartMs: o.mediaStartMs };

    const st = (await creator.get(`/api/sessions/${sessionId}/instant-replay`)).json();
    expect(st).toEqual({ available: true, reason: null, source: "recording", bufferSeconds: null });
    const { r, ms } = await replay(creator, { observationId: o.id });
    console.info(`instant replay from recording segments: cut in ${ms} ms`);
    expect(ms).toBeLessThan(6000);
    expect(r.source).toBe("recording");
    expect(r.startMs).toBe(o.mediaStartMs - 8000);
    // 4 s after the moment, or cut short at the last saved second (at least 2 s after it).
    expect(r.endMs).toBeGreaterThanOrEqual(o.mediaStartMs + 2000);
    expect(r.endMs).toBeLessThanOrEqual(o.mediaStartMs + 4000);
    expect(r.momentOffsetMs).toBe(8000);
    expect(r.durationMs).toBe(r.endMs - r.startMs);
    expect(r.url).toMatch(/^\/api\/media\/f\//);
    expect(Date.parse(r.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);

    const file = await download(creator, r.url, "recording-replay.mp4");
    const p = probe(file);
    expect(Math.abs(p.durationMs - r.durationMs)).toBeLessThan(150);
    expect(Math.abs(p.startMs)).toBeLessThan(50);
    expect(p.height).toBeLessThanOrEqual(720);
    expect(p.audio).toBe(true);
    const boxes = topBoxes(file);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));

    // The first frame is the requested one: find it by timestamp in the stored segment itself.
    const rec = (await getRecordingBySession(h.ctx.db, sessionId))!;
    const segs = rec.runs.find((x) => x.runId === run.runId)!.segments;
    const seg = segs.find((x) => x.startMs <= r.startMs && r.startMs < x.endMs)!;
    const segFile = (h.ctx.storage as unknown as { localPath(k: string): string }).localPath(seg.key);
    const frames = segmentFrames(segFile);
    const target = (r.startMs - seg.startMs) / 1000;
    const k = frames.times.reduce((bi, t, i) => (Math.abs(t - target) < Math.abs(frames.times[bi]! - target) ? i : bi), 0);
    const first = gray(file, 0);
    const near = [-6, -3, -2, -1, 0, 1, 2, 3, 6].filter((d) => frames.thumbs[k + d]).map((d) => ({ d, v: diff(first, frames.thumbs[k + d]!) }));
    const best = near.reduce((a, b) => (b.v < a.v ? b : a));
    expect(Math.abs(best.d), `closest frames ${JSON.stringify(near)}`).toBeLessThanOrEqual(2);
    // Where the picture moves, a second later looks clearly different (a still scene can't tell).
    if (frames.thumbs[k + FPS] && diff(frames.thumbs[k]!, frames.thumbs[k + FPS]!) > 1) expect(diff(first, frames.thumbs[k]!)).toBeLessThan(diff(first, frames.thumbs[k + FPS]!) / 2);
    // And the moment itself is where the response says: SLOT1 read MISSION PASSED on the bars scene.
    const moment = gray(file, Math.round(((r.momentOffsetMs! + 500) * FPS) / 1000));
    expect(diff(moment, gray(SAMPLE, 30 * FPS))).toBeLessThan(diff(moment, gray(SAMPLE, 20 * FPS)) / 3);

    // The same window again is served from the cache, and nothing went into the library.
    // The cache is proven by the single file below; the time only guards against a recut, with
    // headroom for a busy machine.
    const again = await replay(creator, { observationId: o.id });
    expect(again.ms).toBeLessThan(4000);
    const dir = path.join(h.storageRoot, "storage", "b", broadcasterId, "s", sessionId, "instant-replay");
    expect((await readdir(dir)).filter((f) => f.endsWith(".mp4"))).toHaveLength(1);
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM evidence_assets WHERE storage_key LIKE '%/instant-replay/%'`)).rows[0].n).toBe(0);
    const lib = (await creator.get("/api/library")).json<{ items: { kind: string }[] }>().items;
    expect(lib.filter((i) => i.kind !== "recording")).toHaveLength(0);
  }, 200_000);

  it("is authorized like the session's live video", async () => {
    const id = recordedObs!.id;
    // A public session: anyone who can watch its live video can replay a moment.
    expect((await replay(stranger, { observationId: id })).r.source).toBe("recording");
    expect((await anon.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: { observationId: id } })).json().status).toBe("ready");
    expect((await stranger.get(`/api/moment-links/${id}`)).json()).toEqual({ kind: "live", login: expect.any(String), sessionId, observationId: id });

    // Private: the creator only. Others get exactly what a missing session gets.
    expect((await creator.request("PATCH", `/api/sessions/${sessionId}`, { json: { visibility: "private" } })).status).toBe(200);
    for (const b of [stranger, anon]) {
      expect((await b.get(`/api/sessions/${sessionId}/instant-replay`)).status).toBe(404);
      expect((await b.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: { observationId: id } })).status).toBe(404);
      expect((await b.get(`/api/moment-links/${id}`)).status).toBe(404);
      expect((await b.get(`/api/moment-links/${randomUUID()}`)).status).toBe(404);
    }
    expect((await creator.get(`/api/moment-links/${id}`)).json().kind).toBe("live");
    expect((await replay(creator, { observationId: id })).r.status).toBe("ready");
    // A moment from another session can't be replayed here.
    const other = await createReplaySession(h.ctx.db, broadcasterId, "Elsewhere", "private");
    const { observation: foreign } = await insertObservation(h.ctx.db, {
      broadcasterId, sessionId: other.id, sourceId: null, mediaStartMs: 1000, mediaEndMs: 2000, capturedAt: null, receivedAt: new Date().toISOString(),
      analyzedAt: null, type: "mission_title", description: "Elsewhere", origin: "ocr", interpretation: "directly_visible", evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: 1000 }], rawText: "Elsewhere",
      model: null, modelConfidence: null, relatedEntities: [],
    });
    expect((await creator.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: { observationId: foreign.id } })).json()).toEqual({
      status: "unavailable",
      reason: "That moment isn't part of this stream",
    });
    expect((await creator.request("PATCH", `/api/sessions/${sessionId}`, { json: { visibility: "public" } })).status).toBe(200);
  }, 90_000);

  it("cuts from the rolling buffer on the worker that reads the stream", async () => {
    // Recording off, rolling buffer on: the reader restarts and only the buffer holds video.
    const restartedAt = Date.now();
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { recordingEnabled: false, rollingBufferEnabled: true, rollingBufferSeconds: 60 } })).status).toBe(200);
    await waitFor(async () => (await creator.get(`/api/sessions/${sessionId}/instant-replay`)).json().source === "buffer", 20_000, "buffer mode");
    expect((await creator.get(`/api/sessions/${sessionId}/instant-replay`)).json()).toEqual({ available: true, reason: null, source: "buffer", bufferSeconds: 60 });
    // A moment from before the restart is gone from the buffer, and SLOT1 says so.
    await waitFor(async () => existsSync(path.join(h.ctx.config.env.INGEST_SEGMENT_DIR, sourceId, "segments.csv")), 30_000, "the rolling buffer");
    const old = await creator.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: { observationId: recordedObs!.id } });
    expect(old.json()).toEqual({ status: "unavailable", reason: "That moment is no longer in the rolling buffer (it keeps the last 60 s)" });

    const o = await passedAfter(restartedAt + 12_000, 100_000);
    const { r, ms } = await replay(creator, { observationId: o.id });
    console.info(`instant replay from the rolling buffer: cut in ${ms} ms`);
    expect(r.source).toBe("buffer");
    expect(r.momentOffsetMs).toBe(8000);
    expect(r.durationMs).toBeGreaterThanOrEqual(10_000);
    const file = await download(creator, r.url, "buffer-replay.mp4");
    const p = probe(file);
    expect(Math.abs(p.durationMs - r.durationMs)).toBeLessThan(150);
    if (process.env.IREPLAY_DEBUG) {
      const csv = readFileSync(path.join(h.ctx.config.env.INGEST_SEGMENT_DIR, sourceId, "segments.csv"), "utf8");
      console.info(JSON.stringify({ obs: { m: o.mediaStartMs, at: o.receivedAt }, restartedAt: new Date(restartedAt).toISOString(), r: { s: r.startMs, e: r.endMs }, csv }));
      const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=1000`)).json<{ observations: any[] }>();
      console.info(JSON.stringify(page.observations.filter((x) => x.origin === "ocr").slice(-12).map((x) => [x.mediaStartMs, x.receivedAt, x.rawText])));
    }
    expect(Math.abs(p.startMs)).toBeLessThan(50);
    const moment = gray(file, Math.round(((r.momentOffsetMs! + 500) * FPS) / 1000));
    expect(diff(moment, gray(SAMPLE, 30 * FPS))).toBeLessThan(diff(moment, gray(SAMPLE, 20 * FPS)) / 3);
    // "The last 10 seconds" works too.
    const last = await replay(creator, { secondsAgo: 10 });
    expect(last.r.momentOffsetMs).toBeNull();
    expect(last.r.durationMs).toBe(10_000);
  }, 200_000);

  it("is honest when no worker reads the stream, and its files expire", async () => {
    await supervisor!.stopAll();
    supervisor = null;
    const r = await creator.request("POST", `/api/sessions/${sessionId}/instant-replay`, { json: { secondsAgo: 10 } });
    expect(r.json()).toEqual({ status: "unavailable", reason: "SLOT1 isn't reading this stream right now, so its rolling buffer can't be replayed" });

    const dir = path.join(h.storageRoot, "storage", "b", broadcasterId, "s", sessionId, "instant-replay");
    const before = (await readdir(dir)).filter((f) => f.endsWith(".mp4"));
    expect(before.length).toBeGreaterThanOrEqual(3);
    // Nothing is swept while links are valid; everything once they have expired.
    expect(await sweepInstantReplays(h.ctx)).toBe(0);
    const keys = await h.ctx.redis.zrange("slot1:ireplay:keys", 0, -1);
    for (const k of keys) await h.ctx.redis.zadd("slot1:ireplay:keys", Date.now() - 1000, k);
    expect(await sweepInstantReplays(h.ctx)).toBe(keys.length);
    expect((await readdir(dir)).filter((f) => f.endsWith(".mp4"))).toHaveLength(0);
  }, 60_000);
});
