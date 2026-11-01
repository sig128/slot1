import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderOwnedClip } from "../../apps/worker/src/jobs/clips";
import { finalizeRecording, renderProject, sweepRecordings, takeScreenshot } from "../../apps/worker/src/jobs/library";
import { deleteSession } from "../../apps/worker/src/jobs/maintenance";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { LiveSupervisor } from "../../apps/worker/src/live/supervisor";
import { Browser, multipart, startHarness, type Harness } from "./harness";

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

/* ------------------------------- media checks (ffprobe / ffmpeg) -------------------------------- */

function probe(file: string) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]).toString());
  const v = j.streams.find((s: any) => s.codec_type === "video");
  return { durationMs: Math.round(Number(j.format.duration) * 1000), width: v?.width as number, height: v?.height as number, audio: j.streams.some((s: any) => s.codec_type === "audio") };
}

/** Top-level MP4 boxes in file order (faststart puts moov before mdat). */
function topBoxes(file: string): string[] {
  const fd = openSync(file, "r");
  const out: string[] = [];
  try {
    let pos = 0;
    const head = Buffer.alloc(16);
    for (let i = 0; i < 12; i++) {
      if (readSync(fd, head, 0, 16, pos) < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      out.push(type);
      if (size < 8) break;
      pos += size;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

/** A tiny grayscale thumbnail of an image file, or of frame `n` of a video. */
function gray(file: string, frame?: number): Buffer {
  const vf = `${frame === undefined ? "" : `select=eq(n\\,${frame}),`}scale=160:90,format=gray`;
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"]);
}
const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;
const mean = (a: Buffer) => a.reduce((s, v) => s + v, 0) / a.length;

function localFile(h: Harness, key: string): string {
  return (h.ctx.storage as unknown as { localPath(k: string): string }).localPath(key);
}
async function assetFile(h: Harness, assetId: string): Promise<string> {
  const { rows } = await h.ctx.db.query<{ storage_key: string }>(`SELECT storage_key FROM evidence_assets WHERE id = $1`, [assetId]);
  return localFile(h, rows[0]!.storage_key);
}
async function itemRow(h: Harness, id: string) {
  return (await h.ctx.db.query(`SELECT * FROM library_items WHERE id = $1`, [id])).rows[0] ?? null;
}
function takeJob(h: Harness, name: string, match: (d: any) => boolean = () => true) {
  const i = h.jobs.findIndex((j) => j.name === name && match(j.data));
  if (i < 0) throw new Error(`no ${name} job queued (have: ${h.jobs.map((j) => j.name).join(", ")})`);
  return h.jobs.splice(i, 1)[0]!.data as any;
}

/* ================================================================================================ */

/**
 * Clipper on a replay: auto clips, frame-accurate screenshots, EDL renders checked with ffprobe,
 * library visibility and the public profile, and what survives deletion. Real Postgres, Redis,
 * ffmpeg and tesseract; no AI provider.
 */
describe("clipper on an uploaded replay", () => {
  let h: Harness;
  let creator: Browser;
  let stranger: Browser;
  let anon: Browser;
  let login = "";
  let strangerLogin = "";
  let sessionId = "";
  let autoItemId = "";
  let shotId = "";
  let renderId = "";
  let projectId = "";

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    h = await startHarness();
    creator = new Browser(h);
    stranger = new Browser(h);
    anon = new Browser(h);
    const me = (await creator.signInLocal("Clip Crew")) as { broadcaster: { login: string } };
    login = me.broadcaster.login;
    strangerLogin = ((await stranger.signInLocal("Someone Else")) as { broadcaster: { login: string } }).broadcaster.login;
    await anon.refreshCsrf();
  });
  afterAll(async () => h?.close());

  it("cuts a vertical auto clip around MISSION PASSED, once", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { autoClips: true } })).status).toBe(200);
    const form = await multipart({ title: "Docks run", rightsConfirmed: "true" }, { field: "file", filename: "docks.mp4", path: SAMPLE, type: "video/mp4" });
    const up = (await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } })).json<{ sessionId: string }>();
    sessionId = up.sessionId;
    await analyzeUpload(h.ctx, takeJob(h, "analyze-upload"));

    const projects = (await creator.get("/api/projects")).json<{ projects: { id: string; title: string; origin: string }[] }>().projects;
    const auto = projects.filter((p) => p.origin === "auto");
    expect(auto.map((p) => p.title)).toEqual(["MISSION PASSED"]);
    const lib = (await creator.get("/api/library")).json<{ items: any[] }>().items;
    const item = lib.find((i) => i.kind === "render");
    expect(item).toMatchObject({ status: "processing", visibility: "private", projectId: auto[0]!.id, title: "MISSION PASSED" });
    autoItemId = item.id;

    const job = takeJob(h, "render-project", (d) => d.itemId === autoItemId);
    await renderProject(h.ctx, job, 1, 4);
    const ready = (await creator.get("/api/library")).json<{ items: any[] }>().items.find((i) => i.id === autoItemId);
    expect(ready).toMatchObject({ status: "ready", auto: true, width: 1080, height: 1920 });
    const file = await assetFile(h, (await itemRow(h, autoItemId)).asset_id);
    const p = probe(file);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    // 8 s before and 6 s after the moment (the defaults), inside the 38 s recording.
    expect(p.durationMs).toBeGreaterThan(13_500);
    expect(p.durationMs).toBeLessThan(14_600);
    expect(p.audio).toBe(true);
    expect(topBoxes(file).indexOf("moov")).toBeLessThan(topBoxes(file).indexOf("mdat"));
    expect(ready.posterUrl).toBeTruthy();
    // The draft is an ordinary editable project: vertical, fit layout, poster text.
    const view = (await creator.get(`/api/projects/${auto[0]!.id}`)).json();
    expect(view.edl).toMatchObject({ aspect: "9:16", layout: "fit", texts: [{ text: "MISSION PASSED", style: "poster" }] });
    expect(view.sources[0].markers.some((m: any) => m.kind === "big" && m.label === "MISSION PASSED")).toBe(true);
  });

  it("takes full-resolution, frame-accurate screenshots at the playhead", async () => {
    const shoot = async (atMs: number) => {
      const r = await creator.request("POST", "/api/library/screenshots", { json: { from: "media", sessionId, atMs } });
      expect(r.status).toBe(200);
      const item = r.json<{ id: string; status: string }>();
      expect(item.status).toBe("processing");
      await takeScreenshot(h.ctx, takeJob(h, "screenshot", (d) => d.itemId === item.id));
      const row = await itemRow(h, item.id);
      expect(row.status).toBe("ready");
      return { id: item.id, row, file: await assetFile(h, row.asset_id) };
    };
    // 17.5 s is frame 525, between keyframes at 16 s and 18 s (GOP 60 at 30 fps): a keyframe seek
    // would return frame 480.
    const s = await shoot(17_500);
    shotId = s.id;
    expect([s.row.width, s.row.height]).toEqual([1280, 720]);
    const p = probe(s.file);
    expect([p.width, p.height]).toEqual([1280, 720]);
    const img = gray(s.file);
    expect(diff(img, gray(SAMPLE, 525))).toBeLessThan(1.5);
    expect(diff(img, gray(SAMPLE, 480))).toBeGreaterThan(3);
    // The synthetic black screen is 12–14 s.
    expect(mean(gray((await shoot(13_000)).file))).toBeLessThan(12);
    expect(mean(gray((await shoot(11_500)).file))).toBeGreaterThan(40);
  });

  it("keeps any evidence frame as a library screenshot", async () => {
    const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=200`)).json<{ observations: any[] }>();
    const o = page.observations.find((x) => x.evidence.some((e: any) => e.kind === "frame"));
    const r = await creator.request("POST", "/api/library/screenshots", { json: { from: "evidence", observationId: o.id } });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ kind: "screenshot", status: "ready", sessionId });
    // Someone else's observation can't be copied into your library.
    expect((await stranger.request("POST", "/api/library/screenshots", { json: { from: "evidence", observationId: o.id } })).status).toBe(404);
  });

  it("renders an edit with cuts, speed, text and fades to the chosen preset", async () => {
    const created = await creator.request("POST", "/api/projects", { json: { sessionId, inMs: 20_000, outMs: 26_000, aspect: "16:9" } });
    expect(created.status).toBe(200);
    projectId = created.json<{ id: string }>().id;
    const edl = {
      version: 1,
      aspect: "16:9",
      layout: "crop",
      segments: [
        { id: "a", sessionId, inMs: 2000, outMs: 5000, speed: 1, reframe: { x: 0.5, y: 0.5, zoom: 1 } },
        { id: "b", sessionId, inMs: 27_000, outMs: 31_000, speed: 2, reframe: { x: 0.5, y: 0.5, zoom: 1.25 } },
      ],
      texts: [{ id: "t", text: "Docks run", startMs: 0, endMs: 2000, position: "bottom", style: "banner" }],
      captions: false,
      fadeInMs: 200,
      fadeOutMs: 300,
      volume: 1,
      coverMs: 4000,
    };
    const saved = await creator.request("PATCH", `/api/projects/${projectId}`, { json: { title: "Docks highlight", edl } });
    expect(saved.status).toBe(200);
    expect(saved.json().edl.segments).toHaveLength(2);
    // Invalid edits are refused, and nobody else can read or render this project.
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: { ...edl, segments: [] } } })).status).toBe(400);
    expect((await stranger.get(`/api/projects/${projectId}`)).status).toBe(404);
    expect((await stranger.request("POST", `/api/projects/${projectId}/render`)).status).toBe(404);
    // Edits can only use your own sessions.
    expect((await stranger.request("POST", "/api/projects", { json: { sessionId, inMs: 0, outMs: 5000 } })).status).toBe(404);
    const strangerSession = (await h.ctx.db.query(`INSERT INTO stream_sessions (broadcaster_id, kind, label) SELECT id, 'replay', 'replay' FROM broadcasters WHERE login = $1 RETURNING id`, [strangerLogin])).rows[0].id;
    const foreign = { ...edl, segments: [{ ...edl.segments[0], sessionId: strangerSession }, edl.segments[1]] };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: foreign } })).status).toBe(404);

    const r = await creator.request("POST", `/api/projects/${projectId}/render`);
    expect(r.status).toBe(200);
    renderId = r.json<{ id: string }>().id;
    const job = takeJob(h, "render-project", (d) => d.itemId === renderId);
    await renderProject(h.ctx, job, 1, 4);
    const row = await itemRow(h, renderId);
    expect(row.status).toBe("ready");
    const p = probe(await assetFile(h, row.asset_id));
    expect([p.width, p.height]).toEqual([1920, 1080]);
    // 3 s at 1× plus 4 s at 2×.
    expect(Math.abs(p.durationMs - 5000)).toBeLessThan(250);
    const prog = (await h.ctx.db.query(`SELECT state, progress FROM job_runs WHERE id = $1`, [job.jobRunId])).rows[0];
    expect(prog).toMatchObject({ state: "succeeded", progress: 1 });
  });

  it("shows nothing until it is shared, and private never leaks", async () => {
    const urls = [`/api/library/${renderId}`, `/api/library/${renderId}/poster`];
    for (const b of [stranger, anon]) for (const u of urls) expect((await b.get(u)).status).toBe(404);
    // The channel is private: no public profile at all, even with a public item.
    expect((await anon.get(`/api/profiles/${login}`)).status).toBe(404);
    expect((await creator.get(`/api/profiles/${login}`)).json().viewer).toEqual({ isOwner: true, channelPublic: false });
    expect((await creator.request("PATCH", `/api/library/${renderId}`, { json: { visibility: "public" } })).status).toBe(200);
    expect((await anon.get(`/api/library/${renderId}`)).status).toBe(404);

    expect((await creator.request("PATCH", "/api/studio/settings", { json: { visibility: "public" } })).status).toBe(200);
    const prof = (await anon.get(`/api/profiles/${login}`)).json();
    expect(prof.clips.map((i: any) => i.id)).toEqual([renderId]);
    expect(JSON.stringify(prof)).not.toContain(autoItemId);
    expect(JSON.stringify(prof)).not.toContain(shotId);
    const pub = (await anon.get(`/api/library/${renderId}`)).json();
    expect(pub.item.canEdit).toBe(false);
    expect(pub.channel.login).toBe(login);
    const media = await anon.get(pub.item.url);
    expect(media.status).toBe(200);
    expect(media.headers["content-type"]).toMatch(/video\/mp4/);
    const poster = await anon.get(`/api/library/${renderId}/poster`);
    expect(poster.status).toBe(200);
    expect(poster.headers["content-type"]).toMatch(/image\/jpeg/);

    // Unlisted: open by direct link, never listed.
    expect((await creator.request("PATCH", `/api/library/${shotId}`, { json: { visibility: "unlisted" } })).status).toBe(200);
    expect((await anon.get(`/api/library/${shotId}`)).status).toBe(200);
    expect(JSON.stringify((await anon.get(`/api/profiles/${login}`)).json())).not.toContain(shotId);
    // Featured items lead the profile.
    await creator.request("PATCH", `/api/library/${renderId}`, { json: { featured: true } });
    expect((await anon.get(`/api/profiles/${login}`)).json().featured.map((i: any) => i.id)).toEqual([renderId]);

    // Only the owner changes or deletes items.
    expect((await stranger.request("PATCH", `/api/library/${renderId}`, { json: { visibility: "private" } })).status).toBe(404);
    expect((await stranger.request("DELETE", `/api/library/${renderId}`)).status).toBe(404);
    expect((await anon.request("PATCH", `/api/library/${renderId}`, { json: { title: "x" } })).status).toBe(401);
    expect((await stranger.get("/api/library")).json().items).toHaveLength(0);

    // Making the channel private hides everything at once.
    await creator.request("PATCH", "/api/studio/settings", { json: { visibility: "private" } });
    expect((await anon.get(`/api/library/${renderId}`)).status).toBe(404);
    expect((await anon.get(`/api/library/${shotId}`)).status).toBe(404);
    expect((await anon.get(`/api/library/${renderId}/poster`)).status).toBe(404);
    expect((await anon.get(`/api/profiles/${login}`)).status).toBe(404);
  });

  it("keeps renders and screenshots when the session is deleted; clip exports go with it", async () => {
    // An old-style clip export lives in the session's storage and belongs to its clip job.
    const c = await creator.request("POST", "/api/clips", { json: { sessionId, kind: "owned_render", centerMs: 27_000, preRollMs: 2000, postRollMs: 2000, idempotencyKey: "it-clipper-0001" } });
    expect(c.status).toBe(200);
    await renderOwnedClip(h.ctx, takeJob(h, "render-clip"));
    const exportItem = (await creator.get("/api/library")).json<{ items: any[] }>().items.find((i) => i.kind === "clip_export");
    expect(exportItem).toBeTruthy();

    const keep = [autoItemId, renderId, shotId];
    const files = await Promise.all(keep.map(async (id) => assetFile(h, (await itemRow(h, id)).asset_id)));
    expect((await creator.request("DELETE", `/api/sessions/${sessionId}`)).status).toBe(200);
    await deleteSession(h.ctx, takeJob(h, "delete-session", (d) => d.sessionId === sessionId));

    for (const id of keep) expect(await itemRow(h, id)).toMatchObject({ session_id: null, status: "ready" });
    for (const f of files) expect(existsSync(f)).toBe(true);
    expect(await itemRow(h, exportItem.id)).toBeNull();
    // Re-rendering an edit whose source is gone is refused clearly instead of queueing garbage.
    const r = await creator.request("POST", `/api/projects/${projectId}/render`);
    expect(r.status).toBe(409);
    expect(r.json().error.message).toMatch(/no longer exists/);
    expect((await creator.get(`/api/projects/${projectId}`)).json().sources).toHaveLength(0);
  });

  it("deletes an item's own files, and the whole library on request", async () => {
    const shot = await itemRow(h, shotId);
    const shotFile = await assetFile(h, shot.asset_id);
    expect((await creator.request("DELETE", `/api/library/${shotId}`)).status).toBe(200);
    expect(await itemRow(h, shotId)).toBeNull();
    expect(existsSync(shotFile)).toBe(false);

    const left = (await h.ctx.db.query(`SELECT asset_id FROM library_items WHERE broadcaster_id = (SELECT broadcaster_id FROM library_items WHERE id = $1)`, [renderId])).rows;
    const leftFiles = await Promise.all(left.filter((r) => r.asset_id).map((r) => assetFile(h, r.asset_id)));
    expect((await creator.request("DELETE", "/api/studio/data", { json: { confirm: "DELETE" } })).status).toBe(200);
    expect((await creator.get("/api/library")).json().items).toHaveLength(0);
    expect((await creator.get("/api/projects")).json().projects).toHaveLength(0);
    for (const f of leftFiles) expect(existsSync(f)).toBe(false);
  });
});

/* ================================================================================================ */

/**
 * Live recording end to end: a real nginx-rtmp publish, the real live supervisor recording
 * copy-only segments across two reader runs, finalization to a faststart MP4, observation times
 * re-based onto the file, a live auto clip, recording privacy and the retention sweep.
 */
describe.skipIf(!hasNginxRtmp)("live recording through nginx-rtmp", () => {
  let h: Harness;
  let creator: Browser;
  let stranger: Browser;
  let nginx: ChildProcess | null = null;
  let supervisor: LiveSupervisor | null = null;
  let publishUrl = "";
  let sourceId = "";
  let sessionId = "";
  let recordingId = "";
  let autoItemId = "";
  let liveShotId = "";
  const publishers: ChildProcess[] = [];

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
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
    await creator.signInLocal("Record Crew");
    await stranger.signInLocal("Watcher");
    supervisor = new LiveSupervisor(h.ctx, "it-clipper-worker");
    supervisor.start();
  });

  afterAll(async () => {
    for (const p of publishers) p.kill("SIGKILL");
    await supervisor?.stopAll();
    nginx?.kill("SIGQUIT");
    await h?.close();
  });

  it("needs recording consent before recording can be switched on", async () => {
    const r = await creator.request("PATCH", "/api/studio/settings", { json: { recordingEnabled: true } });
    expect(r.status).toBe(400);
    expect(r.json().error.message).toMatch(/consent/);
    const ok = await creator.request("PATCH", "/api/studio/settings", { json: { recordingConsent: true, recordingEnabled: true, autoClips: true, autoClipPreRollMs: 4000, autoClipPostRollMs: 3000, recordingRetentionDays: 7 } });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ recordingEnabled: true, autoClips: true, recordingRetentionDays: 7 });
  });

  it("records the stream in segments across reader restarts", async () => {
    const src = (await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "test" } })).json<{ source: { id: string }; publishUrl: string }>();
    sourceId = src.source.id;
    publishUrl = src.publishUrl;
    // The whole 38 s sample, once, in real time.
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-i", SAMPLE, "-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "flv", publishUrl], { stdio: "ignore" });
    publishers.push(p);
    sessionId = await waitFor(async () => (await h.ctx.db.query(`SELECT session_id FROM media_sources WHERE id = $1 AND status = 'publishing'`, [sourceId])).rows[0]?.session_id, 20_000, "publish");
    await waitFor(async () => {
      const s = (await creator.get("/api/studio")).json();
      return s.readiness.find((x: { id: string }) => x.id === "video_source_ready")?.status === "done";
    }, 30_000, "first frames");

    // A screenshot of what is live right now.
    const shot = await creator.request("POST", "/api/library/screenshots", { json: { from: "live", sessionId } });
    expect(shot.status).toBe(200);
    expect(shot.json()).toMatchObject({ kind: "screenshot", status: "ready" });
    liveShotId = shot.json().id;

    // Turning analysis on restarts the reader: a second recording run starts.
    expect((await creator.request("POST", "/api/studio/agent", { json: { enabled: true } })).status).toBe(200);
    const rec = await waitFor(async () => {
      const r = (await h.ctx.db.query(`SELECT id, runs FROM recordings WHERE session_id = $1`, [sessionId])).rows[0];
      return r && r.runs.length >= 2 && r.runs.every((x: any) => x.segments.length > 0) ? r : null;
    }, 40_000, "two recorded runs");
    recordingId = rec.id;
    const segKey = rec.runs[0].segments[0].key as string;
    expect(segKey).toMatch(new RegExp(`/s/${sessionId}/recording/runs/`));
    expect(existsSync(localFile(h, segKey))).toBe(true);

    await new Promise<void>((resolve) => (p.exitCode !== null ? resolve() : p.once("exit", () => resolve())));
    await waitFor(async () => h.jobs.some((j) => j.name === "finalize-recording"), 45_000, "finalize job after the publisher left");
  }, 150_000);

  it("cut a live auto clip from the recorded segments", async () => {
    const auto = (await creator.get("/api/projects")).json<{ projects: any[] }>().projects.filter((x) => x.origin === "auto");
    expect(auto.map((x) => x.title)).toEqual(["MISSION PASSED"]);
    const lib = (await creator.get("/api/library")).json<{ items: any[] }>().items;
    autoItemId = lib.find((i) => i.kind === "render").id;
    // Before finalization the clip is cut from this run's segments (runId timeline).
    const view = (await creator.get(`/api/projects/${auto[0].id}`)).json();
    expect(view.edl.segments[0].runId).toMatch(/^r[a-z0-9]+$/);
    await renderProject(h.ctx, takeJob(h, "render-project", (d) => d.itemId === autoItemId), 1, 4);
    const row = await itemRow(h, autoItemId);
    expect(row.status).toBe("ready");
    const p = probe(await assetFile(h, row.asset_id));
    expect([p.width, p.height]).toEqual([1080, 1920]);
    // 4 s before and 3 s after the moment.
    expect(p.durationMs).toBeGreaterThan(5000);
    expect(p.durationMs).toBeLessThan(7600);
  });

  it("finalizes a faststart MP4 with a poster, playable like a replay", async () => {
    await finalizeRecording(h.ctx, takeJob(h, "finalize-recording"));
    const rec = (await h.ctx.db.query(`SELECT * FROM recordings WHERE id = $1`, [recordingId])).rows[0];
    expect(rec.status).toBe("ready");
    expect(Number(rec.duration_ms)).toBeGreaterThan(20_000);
    expect(Number(rec.duration_ms)).toBeLessThan(39_000);
    expect(new Date(rec.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const src = (await h.ctx.db.query(`SELECT * FROM media_sources WHERE id = $1`, [rec.source_id])).rows[0];
    expect(src).toMatchObject({ kind: "recording", status: "ready", label: "test" });
    const file = await assetFile(h, src.original_asset_id);
    const p = probe(file);
    expect(p.audio).toBe(true);
    expect([p.width, p.height]).toEqual([1280, 720]);
    expect(Math.abs(p.durationMs - Number(rec.duration_ms))).toBeLessThan(300);
    const boxes = topBoxes(file);
    expect(boxes.indexOf("moov")).toBeGreaterThanOrEqual(0);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));

    const item = (await creator.get("/api/library")).json<{ items: any[] }>().items.find((i) => i.kind === "recording");
    expect(item).toMatchObject({ status: "ready", visibility: "private", sessionId, recordingId });
    expect(item.posterUrl).toBeTruthy();
    const summary = (await creator.get(`/api/sessions/${sessionId}`)).json();
    expect(summary.kind).toBe("ingest");
    expect(summary.playback.url).toBeTruthy();
    expect(summary.playback.durationMs).toBe(Number(rec.duration_ms));

    // Live auto-clip drafts now point into the file instead of the run.
    const auto = (await creator.get("/api/projects")).json<{ projects: any[] }>().projects.find((x) => x.origin === "auto");
    const seg = (await creator.get(`/api/projects/${auto.id}`)).json().edl.segments[0];
    expect(seg.runId).toBeNull();
    expect(seg.outMs).toBeLessThanOrEqual(Number(rec.duration_ms));
  });

  it("re-bases what SLOT1 saw onto the recording's timeline", async () => {
    const rec = (await h.ctx.db.query(`SELECT duration_ms FROM recordings WHERE id = $1`, [recordingId])).rows[0];
    const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=200`)).json<{ observations: any[] }>();
    const timed = page.observations.filter((o) => o.mediaStartMs !== null && o.origin === "ocr");
    expect(timed.length).toBeGreaterThan(0);
    for (const o of timed) {
      expect(o.mediaStartMs).toBeGreaterThanOrEqual(0);
      expect(o.mediaStartMs).toBeLessThanOrEqual(Number(rec.duration_ms));
    }
    // A screenshot from the recording at the time SLOT1 read MISSION PASSED shows that scene.
    const passed = timed.find((o) => /MISSION PASSED/i.test(o.rawText ?? ""));
    expect(passed).toBeTruthy();
    const r = await creator.request("POST", "/api/library/screenshots", { json: { from: "media", sessionId, atMs: passed.mediaStartMs + 500 } });
    const id = r.json<{ id: string }>().id;
    await takeScreenshot(h.ctx, takeJob(h, "screenshot", (d) => d.itemId === id));
    const img = gray(await assetFile(h, (await itemRow(h, id)).asset_id));
    const barsScene = gray(SAMPLE, 30 * 30); // 30 s: the MISSION PASSED scene
    const otherScene = gray(SAMPLE, 20 * 30); // 20 s: the scene before it
    expect(diff(img, barsScene)).toBeLessThan(diff(img, otherScene) / 3);

    // A second render of the auto clip, now from the finalized file.
    const auto = (await creator.get("/api/projects")).json<{ projects: any[] }>().projects.find((x) => x.origin === "auto");
    const again = (await creator.request("POST", `/api/projects/${auto.id}/render`)).json<{ id: string }>();
    await renderProject(h.ctx, takeJob(h, "render-project", (d) => d.itemId === again.id), 1, 4);
    expect((await itemRow(h, again.id)).status).toBe("ready");
  });

  it("plays the recording to others only when the creator shares it", async () => {
    expect((await stranger.get(`/api/sessions/${sessionId}`)).status).toBe(404);
    await creator.request("PATCH", "/api/studio/settings", { json: { visibility: "public", publicAnalysis: true } });
    await creator.request("PATCH", `/api/sessions/${sessionId}`, { json: { visibility: "public" } });
    const visible = (await stranger.get(`/api/sessions/${sessionId}`)).json();
    // The analysis is public, the recording isn't yet.
    expect(visible.playback).toBeNull();
    const item = (await creator.get("/api/library")).json<{ items: any[] }>().items.find((i) => i.kind === "recording");
    await creator.request("PATCH", `/api/library/${item.id}`, { json: { visibility: "unlisted" } });
    expect((await stranger.get(`/api/sessions/${sessionId}`)).json().playback.url).toBeTruthy();
    expect((await stranger.get(`/api/library/${item.id}`)).status).toBe(200);
    await creator.request("PATCH", `/api/library/${item.id}`, { json: { visibility: "public" } });
    const login = ((await creator.refreshCsrf()) as { broadcaster: { login: string } }).broadcaster.login;
    expect((await stranger.get(`/api/profiles/${login}`)).json().recordings.map((i: any) => i.id)).toEqual([item.id]);
  });

  it("expires the recording on schedule but keeps clips and screenshots", async () => {
    const item = (await creator.get("/api/library")).json<{ items: any[] }>().items.find((i) => i.kind === "recording");
    const rec = (await h.ctx.db.query(`SELECT source_id FROM recordings WHERE id = $1`, [recordingId])).rows[0];
    const mp4 = await assetFile(h, (await h.ctx.db.query(`SELECT original_asset_id FROM media_sources WHERE id = $1`, [rec.source_id])).rows[0].original_asset_id);
    const clipFile = await assetFile(h, (await itemRow(h, autoItemId)).asset_id);
    const shotFile = await assetFile(h, (await itemRow(h, liveShotId)).asset_id);
    await h.ctx.db.query(`UPDATE recordings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [recordingId]);
    expect(await sweepRecordings(h.ctx)).toBe(1);

    expect((await h.ctx.db.query(`SELECT status FROM recordings WHERE id = $1`, [recordingId])).rows[0].status).toBe("expired");
    expect(await itemRow(h, item.id)).toBeNull();
    expect(existsSync(mp4)).toBe(false);
    expect((await creator.get(`/api/sessions/${sessionId}`)).json().playback).toBeNull();
    // What was made from it stays, with its files; the session and its log stay too.
    expect((await itemRow(h, autoItemId)).status).toBe("ready");
    expect(existsSync(clipFile)).toBe(true);
    expect(existsSync(shotFile)).toBe(true);
    expect((await creator.get(`/api/sessions/${sessionId}/observations?limit=5`)).json().observations.length).toBeGreaterThan(0);

    // Deleting the session removes its recording rows and media source too.
    expect((await creator.request("DELETE", `/api/sessions/${sessionId}`)).status).toBe(200);
    await deleteSession(h.ctx, takeJob(h, "delete-session", (d) => d.sessionId === sessionId));
    expect((await h.ctx.db.query(`SELECT 1 FROM recordings WHERE id = $1`, [recordingId])).rowCount).toBe(0);
    expect((await h.ctx.db.query(`SELECT 1 FROM media_sources WHERE id = $1`, [rec.source_id])).rowCount).toBe(0);
    expect((await itemRow(h, autoItemId)).session_id).toBeNull();
    expect(existsSync(clipFile)).toBe(true);
  });
});
