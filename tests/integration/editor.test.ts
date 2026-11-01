import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Edl, edlDurationMs, type EdlInput } from "@slot1/contracts";
import { buildWaveform, renderProject, renderThumbnail } from "../../apps/worker/src/jobs/library";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { Browser, multipart, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const LONG = 600_000;

function probe(file: string) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file]).toString());
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = j.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  return { durationMs: Math.round(Number(j.format.duration) * 1000), width: v?.width as number | undefined, height: v?.height as number | undefined, video: v?.codec_name as string | undefined, audio: a?.codec_name as string | undefined };
}
/** RGB bytes of a small region of the frame at `t` seconds. */
function region(file: string, t: number, crop: string, size = "64:16"): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `format=rgb24,crop=${crop},scale=${size}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}
const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;
/** Mean colourfulness: how far pixels are from grey. */
const chroma = (rgb: Buffer) => {
  let s = 0;
  for (let i = 0; i < rgb.length; i += 3) s += Math.max(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) - Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
  return s / (rgb.length / 3);
};
/** Mean loudness (dB) of a stretch of an audio file. */
function meanDb(file: string, from: number, dur: number): number {
  const err = execFileSync("bash", ["-c", `ffmpeg -hide_banner -ss ${from} -t ${dur} -i '${file}' -af volumedetect -f null - 2>&1 | grep mean_volume`]).toString();
  return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(err)?.[1] ?? "NaN");
}
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
async function renderItem(h: Harness, itemId: string) {
  const t0 = Date.now();
  await renderProject(h.ctx, takeJob(h, "render-project", (d) => d.itemId === itemId), 1, 1);
  const row = await itemRow(h, itemId);
  if (row.status !== "ready") throw new Error(`render ${row.status}: ${row.error}`);
  return { row, file: await assetFile(h, row.asset_id), ms: Date.now() - t0 };
}

/**
 * The pro editor on real Postgres, Redis and ffmpeg: uploaded music with a rights check, a
 * vertical facecam split with transitions, WASTED, captions and ducked music, batch exports for
 * several platforms, GIF and audio-only files, thumbnails and timeline waveforms. Every file is
 * checked with ffprobe and by looking at its pixels and levels.
 */
describe("pro clip editor", () => {
  let h: Harness;
  let creator: Browser;
  let stranger: Browser;
  let sessionId = "";
  let projectId = "";
  let musicId = "";
  let imageId = "";
  const tmp = mkdtempSync(path.join(tmpdir(), "slot1-editor-it-"));
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    // A music bed (a steady 330 Hz tone) and a logo, made here so nothing third-party is used.
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=6", "-c:a", "aac", "-b:a", "96k", "-y", path.join(tmp, "bed.m4a")]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0xffc94d:s=200x120", "-frames:v", "1", "-y", path.join(tmp, "logo.png")]);
    writeFileSync(path.join(tmp, "notes.txt"), "not media");
    h = await startHarness();
    creator = new Browser(h);
    stranger = new Browser(h);
    await creator.signInLocal("Editor Crew");
    await stranger.signInLocal("Not The Owner");
    const form = await multipart({ title: "Docks run", rightsConfirmed: "true" }, { field: "file", filename: "docks.mp4", path: SAMPLE, type: "video/mp4" });
    sessionId = (await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } })).json<{ sessionId: string }>().sessionId;
    await analyzeUpload(h.ctx, takeJob(h, "analyze-upload"));
    h.jobs.length = 0;
    const created = await creator.request("POST", "/api/projects", { json: { sessionId, inMs: 1000, outMs: 6000 } });
    projectId = created.json<{ id: string }>().id;
  }, LONG);
  afterAll(async () => {
    console.log("editor render timings (ms)", timings);
    await h?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const upload = async (b: Browser, fields: Record<string, string>, file: string, type: string) => {
    const form = await multipart(fields, { field: "file", filename: path.basename(file), path: file, type });
    return b.request("POST", "/api/editor/media", { body: form.body, headers: { "content-type": form.contentType } });
  };

  it("uploads music and images only with a rights confirmation, and keeps them private", async () => {
    expect((await upload(creator, {}, path.join(tmp, "bed.m4a"), "audio/mp4")).status).toBe(400);
    expect((await upload(creator, { rightsConfirmed: "true" }, path.join(tmp, "notes.txt"), "text/plain")).status).toBe(400);
    const music = await upload(creator, { rightsConfirmed: "true", name: "Night drive bed", projectId }, path.join(tmp, "bed.m4a"), "audio/mp4");
    expect(music.status).toBe(200);
    expect(music.json()).toMatchObject({ kind: "audio", name: "Night drive bed" });
    expect(Math.abs(music.json().durationMs - 6000)).toBeLessThan(100);
    musicId = music.json().id;
    const logo = await upload(creator, { rightsConfirmed: "true" }, path.join(tmp, "logo.png"), "image/png");
    expect(logo.json()).toMatchObject({ kind: "image", width: 200, height: 120, name: "logo" });
    imageId = logo.json().id;
    expect((await creator.get("/api/editor/media")).json().media.map((m: { id: string }) => m.id).sort()).toEqual([musicId, imageId].sort());
    expect((await stranger.get("/api/editor/media")).json().media).toEqual([]);
    expect((await stranger.request("DELETE", `/api/editor/media/${musicId}`)).status).toBe(404);
  });

  it("refuses edits that point at other people's files or unknown library items", async () => {
    const base = (await creator.get(`/api/projects/${projectId}`)).json().edl;
    const foreign = await upload(stranger, { rightsConfirmed: "true" }, path.join(tmp, "bed.m4a"), "audio/mp4");
    const withForeign = { ...base, audioTracks: [{ id: "m", clips: [{ id: "c", source: { kind: "upload", assetId: foreign.json().id }, startMs: 0, durationMs: 1000 }] }] };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: withForeign } })).status).toBe(400);
    const withUnknown = { ...base, overlays: [{ id: "o", items: [{ type: "image", id: "i", startMs: 0, endMs: 1000, source: { kind: "library", assetId: "sticker/not-in-this-library" } }] }] };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: withUnknown } })).status).toBe(200);
    const r = await creator.request("POST", `/api/projects/${projectId}/render`);
    expect(r.status).toBe(409);
    expect(r.json().error.message).toContain("sticker/not-in-this-library");
  });

  it("renders a vertical facecam split with transitions, WASTED, captions and ducked music", async () => {
    const edl: EdlInput = {
      version: 1,
      aspect: "9:16",
      layout: "split",
      split: { cam: { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, camShare: 0.38, camOnTop: true },
      segments: [
        { id: "a", sessionId, inMs: 1000, outMs: 4000 },
        { id: "b", sessionId, inMs: 14_000, outMs: 17_000, transitionIn: { kind: "crossfade", durationMs: 500 } },
        { id: "c", sessionId, inMs: 27_000, outMs: 32_000, transitionIn: { kind: "flash", durationMs: 300 } },
      ],
      overlays: [{ id: "o", items: [{ type: "text", id: "t", startMs: 0, endMs: 2000, text: "THE DOCKS", subtext: "Mission 4", style: "title-card", animation: "pop", y: 0.5 }, { type: "image", id: "l", startMs: 2000, endMs: 4000, source: { kind: "upload", assetId: imageId }, widthPct: 0.2, x: 0.85, y: 0.45 }] }],
      effects: [{ id: "w", kind: "wasted", startMs: 7700, endMs: 10_200 }],
      captionTrack: { style: "line", position: "bottom", cues: [{ id: "k", startMs: 8800, endMs: 9800, text: "THAT DID NOT GO TO PLAN" }] },
      audioTracks: [{ id: "m", name: "Music", kind: "music", duck: true, volume: 0.7, clips: [{ id: "c1", source: { kind: "upload", assetId: musicId }, startMs: 0, durationMs: 10_200, loop: true, fadeOutMs: 600 }] }],
      normalize: true,
    };
    const parsed = Edl.parse(edl);
    const total = edlDurationMs(parsed);
    expect(total).toBe(3000 + 3000 + 5000 - 500 - 300);
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { title: "Docks split", edl } })).status).toBe(200);
    const r = await creator.request("POST", `/api/projects/${projectId}/render`);
    expect(r.status).toBe(200);
    const { row, file, ms } = await renderItem(h, r.json().id);
    timings.split1080 = ms;
    const p = probe(file);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(Math.abs(p.durationMs - total)).toBeLessThan(120);
    expect(p.audio).toBe("aac");
    expect(row.preset).toBeNull();
    // The gold divider sits between the camera panel (38 %) and the gameplay.
    const y = 2 * Math.floor((1920 * 0.38) / 2);
    const line = region(file, 1.0, `1080:1:0:${y}`, "8:1");
    for (let i = 0; i < line.length; i += 3) expect([line[i]! > 180, line[i + 1]! > 140, line[i + 2]! < 120]).toEqual([true, true, true]);
    // WASTED: the picture freezes and loses its colour; before it, colour.
    // (Below the WASTED banner and above the captions.)
    const at = (t: number) => region(file, t, "1080:440:0:1060");
    expect(diff(at(8.1), at(8.6))).toBeLessThan(2);
    expect(chroma(at(8.3))).toBeLessThan(6);
    expect(chroma(at(5.0))).toBeGreaterThan(30);
    // Captions burn in over the frozen picture: the caption area changes only while the cue is on.
    const cap = (t: number) => region(file, t, "1080:160:0:1420");
    expect(diff(cap(8.3), cap(8.6))).toBeLessThan(2);
    expect(diff(cap(8.6), cap(9.3))).toBeGreaterThan(8);
    // Loudness normalized to about −14 LUFS.
    const lufs = execFileSync("bash", ["-c", `ffmpeg -hide_banner -i '${file}' -af ebur128 -f null - 2>&1 | grep -A1 'Integrated loudness' | tail -1`]).toString();
    const integrated = Number(/I:\s*(-?[\d.]+) LUFS/.exec(lufs)?.[1]);
    expect(integrated).toBeGreaterThan(-17);
    expect(integrated).toBeLessThan(-11);
  }, LONG);

  it("ducks the music while the game audio has sound in the voice band", async () => {
    // Music alone (soloed) over two segments: the first muted (no sidechain), the second with the
    // recording's tone. Audio-only export, so this is quick.
    const edl: EdlInput = {
      version: 1,
      aspect: "9:16",
      segments: [
        { id: "q", sessionId, inMs: 1000, outMs: 4000, volume: 0 },
        { id: "l", sessionId, inMs: 5000, outMs: 8000, volume: 1 },
      ],
      audioTracks: [{ id: "m", kind: "music", duck: true, solo: true, clips: [{ id: "c1", source: { kind: "upload", assetId: musicId }, startMs: 0, durationMs: 6000, loop: true }] }],
    };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl } })).status).toBe(200);
    const res = await creator.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["original"], format: "audio" } });
    expect(res.status).toBe(200);
    const { file, ms } = await renderItem(h, res.json().items[0].id);
    timings.audioOnly = ms;
    expect(probe(file)).toMatchObject({ audio: "aac", video: undefined });
    const quiet = meanDb(file, 1.0, 1.5);
    const ducked = meanDb(file, 4.0, 1.5);
    expect(quiet - ducked).toBeGreaterThan(3);
  }, LONG);

  it("exports several platform versions, a GIF, and refuses lengths a platform won't take", async () => {
    const edl: EdlInput = { version: 1, aspect: "9:16", layout: "fit", segments: [{ id: "a", sessionId, inMs: 20_000, outMs: 26_000 }], effects: [{ id: "p", kind: "passed", startMs: 1000, endMs: 3000 }] };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { title: "Docks", edl } })).status).toBe(200);
    const res = await creator.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["tiktok", "shorts", "youtube"], height: 720, quality: "small" } });
    expect(res.status).toBe(200);
    const items = res.json().items as { id: string; preset: string; title: string }[];
    expect(items.map((i) => [i.preset, i.title])).toEqual([
      ["tiktok", "Docks · TikTok"],
      ["shorts", "Docks · YouTube Shorts"],
      ["youtube", "Docks · YouTube"],
    ]);
    const sizes: Record<string, number[]> = {};
    for (const it of items) {
      const { file, ms } = await renderItem(h, it.id);
      timings[`batch-${it.preset}`] = ms;
      const p = probe(file);
      sizes[it.preset] = [p.width!, p.height!];
      expect(Math.abs(p.durationMs - 6000)).toBeLessThan(120);
    }
    expect(sizes).toEqual({ tiktok: [720, 1280], shorts: [720, 1280], youtube: [1280, 720] });
    const gif = await creator.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["original"], format: "gif" } });
    const g = await renderItem(h, gif.json().items[0].id);
    timings.gif = g.ms;
    expect(probe(g.file)).toMatchObject({ video: "gif", width: 480, audio: undefined });
    expect(g.row).toMatchObject({ format: "gif" });
    // 4 × 37 s is longer than X takes.
    const long = { version: 1, aspect: "16:9", segments: [0, 1, 2, 3].map((i) => ({ id: `s${i}`, sessionId, inMs: 0, outMs: 37_000 })) };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl: long } })).status).toBe(200);
    const x = await creator.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["x"] } });
    expect(x.status).toBe(409);
    expect(x.json().error.message).toBe("X takes at most 140 s; this edit is 148 s");
    expect((await stranger.request("POST", `/api/projects/${projectId}/exports`, { json: { presets: ["tiktok"] } })).status).toBe(404);
  }, LONG);

  it("makes a 1280×720 thumbnail into the library", async () => {
    const edl: EdlInput = { version: 1, aspect: "9:16", segments: [{ id: "a", sessionId, inMs: 20_000, outMs: 26_000 }], grade: { preset: "golden-hour" } };
    expect((await creator.request("PATCH", `/api/projects/${projectId}`, { json: { edl } })).status).toBe(200);
    const res = await creator.request("POST", `/api/projects/${projectId}/thumbnail`, { json: { atMs: 2500, text: "DOCKS DONE", subtext: "part 2", style: "mission" } });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ kind: "thumbnail", status: "processing", format: "png" });
    await renderThumbnail(h.ctx, takeJob(h, "project-thumbnail"));
    const row = await itemRow(h, res.json().id);
    expect(row.status).toBe("ready");
    expect(probe(await assetFile(h, row.asset_id))).toMatchObject({ video: "png", width: 1280, height: 720 });
    const lib = (await creator.get("/api/library?kind=thumbnail")).json().items;
    expect(lib).toHaveLength(1);
    expect(lib[0].posterUrl).toBeTruthy();
    expect((await creator.request("POST", `/api/projects/${projectId}/thumbnail`, { json: { atMs: 60_000, text: "late" } })).status).toBe(400);
  }, LONG);

  it("builds the timeline waveform once and serves it", async () => {
    const first = (await creator.get(`/api/editor/waveform/${sessionId}`)).json();
    expect(first.status).toBe("pending");
    await buildWaveform(h.ctx, takeJob(h, "session-waveform"));
    const w = (await creator.get(`/api/editor/waveform/${sessionId}`)).json();
    expect(w.status).toBe("ready");
    expect(w.peaks.length).toBeGreaterThan(100);
    expect(Math.max(...w.peaks)).toBe(1);
    // The tone stops at 20 s: the waveform shows it.
    const at = (s: number) => w.peaks[Math.floor((s * 1000 * w.peaks.length) / w.durationMs)];
    expect(at(10)).toBeGreaterThan(0.5);
    expect(at(30)).toBeLessThan(0.05);
    expect((await stranger.get(`/api/editor/waveform/${sessionId}`)).status).toBe(404);
  }, LONG);

  it("says exactly what's missing when captions can't be generated", async () => {
    const r = await creator.request("POST", `/api/projects/${projectId}/captions`);
    expect(r.status).toBe(409);
    expect(r.json().error.message).toContain("TRANSCRIPTION_PROVIDER");
    expect(r.json().error.requirement).toContain("TRANSCRIPTION_MODEL");
    expect((await creator.get(`/api/projects/${projectId}/captions`)).json()).toEqual({ status: "none", error: null, cues: [], sequenceId: "main" });
  });

  it("deletes uploaded files for good", async () => {
    const key = (await h.ctx.db.query(`SELECT storage_key FROM project_media WHERE id = $1`, [imageId])).rows[0].storage_key;
    expect(existsSync(localFile(h, key))).toBe(true);
    expect((await creator.request("DELETE", `/api/editor/media/${imageId}`)).status).toBe(200);
    expect(existsSync(localFile(h, key))).toBe(false);
    expect((await creator.get("/api/editor/media")).json().media.map((m: { id: string }) => m.id)).toEqual([musicId]);
  });
});
