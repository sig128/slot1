import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPRITE_TILE, type EdlInput } from "@slot1/contracts";
import { sessionSpriteSheetKey } from "@slot1/services";
import { buildSprites, renderProject } from "../../apps/worker/src/jobs/library";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { Browser, multipart, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const LONG = 600_000;

function probe(file: string) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file]).toString());
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  return { durationMs: Math.round(Number(j.format.duration) * 1000), width: v?.width as number | undefined, height: v?.height as number | undefined, video: v?.codec_name as string | undefined };
}
const localFile = (h: Harness, key: string) => (h.ctx.storage as unknown as { localPath(k: string): string }).localPath(key);
async function assetFile(h: Harness, assetId: string): Promise<string> {
  const { rows } = await h.ctx.db.query<{ storage_key: string }>(`SELECT storage_key FROM evidence_assets WHERE id = $1`, [assetId]);
  return localFile(h, rows[0]!.storage_key);
}
const itemRow = async (h: Harness, id: string) => (await h.ctx.db.query(`SELECT * FROM library_items WHERE id = $1`, [id])).rows[0] ?? null;
function takeJob(h: Harness, name: string, match: (d: any) => boolean = () => true) {
  const i = h.jobs.findIndex((j) => j.name === name && match(j.data));
  if (i < 0) throw new Error(`no ${name} job queued (have: ${h.jobs.map((j) => j.name).join(", ")})`);
  return h.jobs.splice(i, 1)[0]!.data as any;
}

/**
 * The Studio editor's project model on real Postgres, Redis and ffmpeg: several timelines per
 * project (saved, checked, rendered one by one or in a batch), the media bin's list of stored
 * videos, and filmstrip sprite sheets for the timeline.
 */
describe("Studio editor: timelines, media bin and filmstrips", () => {
  let h: Harness;
  let creator: Browser;
  let stranger: Browser;
  let sessionId = "";
  let strangerSession = "";
  let projectId = "";

  const vertical = (): EdlInput => ({ version: 1, aspect: "9:16", segments: [{ id: "a", sessionId, inMs: 2000, outMs: 6000 }], markers: [{ id: "m1", atMs: 1000, label: "the jump", color: "gold" }] });
  // The widescreen cut plays V1's sound from a detached audio clip.
  const wide = (): EdlInput => ({
    version: 1,
    aspect: "16:9",
    segments: [{ id: "a", sessionId, inMs: 2000, outMs: 5000, volume: 0 }],
    effects: [{ id: "f", kind: "shake", startMs: 500, endMs: 1500, enabled: false }],
    audioTracks: [{ id: "d", name: "Detached audio", kind: "voice", clips: [{ id: "c", source: { kind: "session", sessionId }, startMs: 0, offsetMs: 2000, durationMs: 3000, link: "a" }] }],
  });

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    h = await startHarness();
    creator = new Browser(h);
    stranger = new Browser(h);
    await creator.signInLocal("Timeline Crew");
    await stranger.signInLocal("Someone Else");
    const up = async (b: Browser, title: string) => {
      const form = await multipart({ title, rightsConfirmed: "true" }, { field: "file", filename: "docks.mp4", path: SAMPLE, type: "video/mp4" });
      const id = (await b.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } })).json<{ sessionId: string }>().sessionId;
      await analyzeUpload(h.ctx, takeJob(h, "analyze-upload"));
      return id;
    };
    sessionId = await up(creator, "Docks run");
    strangerSession = await up(stranger, "Not yours");
    h.jobs.length = 0;
    projectId = (await creator.request("POST", "/api/projects", { json: { sessionId, inMs: 1000, outMs: 6000 } })).json<{ id: string }>().id;
  }, LONG);
  afterAll(async () => {
    await h?.close();
  });

  it("lists the creator's stored videos for the media bin, and only theirs", async () => {
    const mine = (await creator.get("/api/editor/sources")).json().sources;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ sessionId, title: "Docks run", kind: "upload", markers: [] });
    expect(mine[0].playbackUrl).toBeTruthy();
    expect(mine[0].durationMs).toBeGreaterThan(30_000);
    const theirs = (await stranger.get("/api/editor/sources")).json().sources;
    expect(theirs.map((s: { sessionId: string }) => s.sessionId)).toEqual([strangerSession]);
  });

  it("starts as one timeline, then saves several and checks each belongs to the creator", async () => {
    const first = (await creator.get(`/api/projects/${projectId}`)).json();
    expect(first.sequences).toEqual({ mainName: "Main", extra: [] });
    const res = await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: vertical(), sequences: { mainName: "Vertical", extra: [{ id: "wide", name: "Widescreen", edl: wide() }] } } });
    expect(res.status).toBe(200);
    const v = res.json();
    expect(v.sequences.mainName).toBe("Vertical");
    expect(v.sequences.extra).toHaveLength(1);
    expect(v.sequences.extra[0]).toMatchObject({ id: "wide", name: "Widescreen", edl: { aspect: "16:9" } });
    expect(v.edl.markers).toEqual([{ id: "m1", atMs: 1000, durationMs: 0, label: "the jump", color: "gold" }]);
    expect(v.sources.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionId]);
    // Someone else's video in a second timeline, a duplicate id, or the reserved id: refused.
    const theirs = { ...wide(), segments: [{ id: "a", sessionId: strangerSession, inMs: 0, outMs: 3000 }] };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { sequences: { extra: [{ id: "x", name: "Sneaky", edl: theirs }] } } })).status).toBe(404);
    const theirSound = { ...wide(), audioTracks: [{ id: "d", clips: [{ id: "c", source: { kind: "session", sessionId: strangerSession }, startMs: 0, durationMs: 1000 }] }] };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: theirSound } })).status).toBe(404);
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { sequences: { extra: [{ id: "w", name: "A", edl: wide() }, { id: "w", name: "B", edl: wide() }] } } })).status).toBe(400);
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { sequences: { extra: [{ id: "main", name: "A", edl: wide() }] } } })).status).toBe(400);
    // A save of the title alone keeps the timelines.
    await creator.request("PATCH", `/api/projects/${projectId}`, { json: { title: "Docks, two shapes" } });
    expect((await creator.get(`/api/projects/${projectId}`)).json().sequences.extra[0].id).toBe("wide");
    expect((await stranger.get(`/api/projects/${projectId}`)).status).toBe(404);
  });

  it("renders the timeline asked for, in its own shape", async () => {
    const item = (await creator.request("POST", `/api/projects/${projectId}/render`, { json: { sequences: ["wide"] } })).json();
    expect(item.title).toBe("Docks, two shapes · Widescreen");
    const row0 = await itemRow(h, item.id);
    expect(row0.render_options).toMatchObject({ sequenceId: "wide" });
    await renderProject(h.ctx, takeJob(h, "render-project", (d) => d.itemId === item.id), 1, 1);
    const row = await itemRow(h, item.id);
    expect(row.status, row.error).toBe("ready");
    const p = probe(await assetFile(h, row.asset_id));
    expect(p).toMatchObject({ video: "h264", width: 1920, height: 1080 });
    expect(Math.abs(p.durationMs - 3000)).toBeLessThan(250);
    // The detached sound plays (the V1 clip itself is silent).
    const level = execFileSync("bash", ["-c", `ffmpeg -hide_banner -i '${await assetFile(h, row.asset_id)}' -af volumedetect -f null - 2>&1 | grep mean_volume`]).toString();
    expect(Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(level)?.[1])).toBeGreaterThan(-40);
    expect((await creator.request("POST", `/api/projects/${projectId}/render`, { json: { sequences: ["gone"] } })).status).toBe(404);
    expect((await creator.request("POST", `/api/projects/${projectId}/render`, { json: { sequences: ["main", "wide"] } })).status).toBe(400);
  }, LONG);

  it("batch-exports several timelines for several platforms", async () => {
    const res = await creator.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["original", "shorts"], sequences: ["main", "wide"] } });
    expect(res.status).toBe(200);
    const items = res.json().items as { id: string; title: string }[];
    expect(items.map((i) => i.title).sort()).toEqual(["Docks, two shapes · Vertical", "Docks, two shapes · Vertical · YouTube Shorts", "Docks, two shapes · Widescreen", "Docks, two shapes · Widescreen · YouTube Shorts"]);
    const opts = await Promise.all(items.map(async (i) => (await itemRow(h, i.id)).render_options));
    expect(opts.filter((o) => o?.sequenceId === "wide")).toHaveLength(2);
    expect(opts.filter((o) => o && !("sequenceId" in o))).toHaveLength(2);
    // Over the batch limit: refused before anything is queued.
    const many = await creator.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["original", "shorts", "reels"], sequences: ["main", "wide"] } });
    expect(many.status).toBe(409);
    // A render whose timeline was deleted fails with a clear reason.
    await creator.request("PATCH", `/api/projects/${projectId}`, { json: { sequences: { mainName: "Vertical", extra: [] } } });
    const queued = items.find((i) => i.title === "Docks, two shapes · Widescreen")!;
    await expect(renderProject(h.ctx, takeJob(h, "render-project", (d) => d.itemId === queued.id), 1, 1)).rejects.toThrow(/deleted/);
    const failed = await itemRow(h, queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("deleted");
    h.jobs.length = 0;
    await h.ctx.db.query(`UPDATE library_items SET status = 'failed' WHERE status = 'processing'`);
  }, LONG);

  it("makes thumbnails and captions for the timeline being edited", async () => {
    await creator.request("PATCH", `/api/projects/${projectId}`, { json: { sequences: { mainName: "Vertical", extra: [{ id: "wide", name: "Widescreen", edl: wide() }] } } });
    const t = await creator.request("POST", `/api/projects/${projectId}/thumbnail`, { json: { atMs: 2500, text: "WIDE", sequenceId: "wide" } });
    expect(t.status).toBe(200);
    expect(takeJob(h, "project-thumbnail").input.sequenceId).toBe("wide");
    // 3 s long: 3.5 s is past its end, though not past the main timeline's.
    expect((await creator.request("POST", `/api/projects/${projectId}/thumbnail`, { json: { atMs: 3500, text: "LATE", sequenceId: "wide" } })).status).toBe(400);
    expect((await creator.request("POST", `/api/projects/${projectId}/thumbnail`, { json: { atMs: 0, text: "X", sequenceId: "nope" } })).status).toBe(404);
    expect((await creator.get(`/api/projects/${projectId}/captions`)).json()).toEqual({ status: "none", error: null, cues: [], sequenceId: "main" });
  });

  it("builds filmstrip sprite sheets once per zoom tier and serves them to the owner", async () => {
    const first = (await creator.get(`/api/editor/sprites/${sessionId}?tier=0`)).json();
    expect(first).toMatchObject({ status: "pending", tier: 0, intervalMs: 2000, tileWidth: SPRITE_TILE.width, tileHeight: SPRITE_TILE.height });
    const job = takeJob(h, "session-sprites");
    expect(job).toEqual({ sessionId, tier: 0 });
    await buildSprites(h.ctx, job);
    const v = (await creator.get(`/api/editor/sprites/${sessionId}?tier=0`)).json();
    expect(v.status).toBe("ready");
    expect(v.durationMs).toBeGreaterThan(30_000);
    const frames = v.sheets.reduce((n: number, s: { frames: number }) => n + s.frames, 0);
    expect(frames).toBeGreaterThanOrEqual(Math.floor(v.durationMs / 2000));
    expect(v.sheets[0].url).toBeTruthy();
    // The first sheet is a 10 × 10 grid of 128 × 72 frames.
    const broadcasterId = (await h.ctx.db.query(`SELECT broadcaster_id FROM stream_sessions WHERE id = $1`, [sessionId])).rows[0].broadcaster_id;
    expect(probe(localFile(h, sessionSpriteSheetKey(broadcasterId, sessionId, 0, 0)))).toMatchObject({ width: SPRITE_TILE.width * SPRITE_TILE.cols, height: SPRITE_TILE.height * SPRITE_TILE.rows });
    // Cached: no second job.
    expect((await creator.get(`/api/editor/sprites/${sessionId}?tier=0`)).json().status).toBe("ready");
    expect(h.jobs.filter((j) => j.name === "session-sprites")).toHaveLength(0);
    expect((await stranger.get(`/api/editor/sprites/${sessionId}?tier=0`)).status).toBe(404);
    expect((await creator.get(`/api/editor/sprites/${sessionId}?tier=7`)).status).toBe(400);
  }, LONG);
});
