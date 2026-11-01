import { describe, expect, it } from "vitest";
import { buildEdlRender, cropFor, findRenderFonts, type EdlSegmentMedia } from "@slot1/analysis";
import { bigMoment, Edl, edlDurationMs, edlOutputTime, LibraryItemPatch, ScreenshotInput } from "@slot1/contracts";
import { runOffsets } from "../../apps/worker/src/jobs/library";
import { editTime, parseEditTime } from "../../apps/web/lib/clipper";

const SESSION = "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f";
const OTHER = "0b9c1a2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

function seg(id: string, inMs: number, outMs: number, extra: Record<string, unknown> = {}) {
  return { id, sessionId: SESSION, inMs, outMs, ...extra };
}

const media = (over: Partial<EdlSegmentMedia> = {}): EdlSegmentMedia => ({ path: "/media/rec.mp4", offsetMs: 0, width: 1920, height: 1080, hasAudio: true, ...over });
const fonts = { poster: "/fonts/PassionOne-Black.ttf", caption: "/fonts/DejaVuSans-Bold.ttf" };

describe("edit decision lists", () => {
  it("fills defaults and accepts a valid vertical edit", () => {
    const e = Edl.parse({ version: 1, aspect: "9:16", segments: [seg("a", 1000, 6000)] });
    expect(e.layout).toBe("crop");
    expect(e.segments[0]).toMatchObject({ speed: 1, runId: null, reframe: { x: 0.5, y: 0.5, zoom: 1 } });
    expect(e).toMatchObject({ texts: [], captions: false, fadeInMs: 0, fadeOutMs: 0, volume: 1, coverMs: null });
  });

  it("rejects edits that can't be rendered", () => {
    const bad = (x: Record<string, unknown>) => Edl.safeParse({ version: 1, aspect: "9:16", segments: [seg("a", 0, 5000)], ...x }).success;
    expect(bad({})).toBe(true);
    expect(bad({ segments: [] })).toBe(false);
    expect(bad({ segments: [seg("a", 0, 200)] })).toBe(false); // shorter than 0.3 s
    expect(bad({ segments: [seg("a", 0, 6 * 60_000)] })).toBe(false); // longer than 5 min
    expect(bad({ segments: [seg("a", 0, 240_000), seg("b", 0, 240_000), seg("c", 0, 240_000)] })).toBe(false); // edit over 10 min
    expect(bad({ segments: [seg("a", 0, 5000), seg("a", 6000, 9000)] })).toBe(false); // duplicate ids
    expect(bad({ segments: [seg("a", 0, 5000, { speed: 3 })] })).toBe(false);
    expect(bad({ segments: [seg("a", 0, 5000, { reframe: { x: 0.5, y: 0.5, zoom: 5 } })] })).toBe(false);
    expect(bad({ segments: [seg("a", 0, 5000, { sessionId: "not-a-uuid" })] })).toBe(false);
    expect(bad({ aspect: "4:3" })).toBe(false);
    expect(bad({ texts: [{ id: "t", text: "LATE", startMs: 6000, endMs: 7000 }] })).toBe(false); // starts after the end
    expect(bad({ texts: [{ id: "t", text: "", startMs: 0, endMs: 1000 }] })).toBe(false);
    expect(bad({ texts: [{ id: "t", text: "X", startMs: 2000, endMs: 1000 }] })).toBe(false);
    expect(bad({ fadeInMs: 3000, fadeOutMs: 3000 })).toBe(false); // fades longer than the edit
    expect(bad({ coverMs: 9000 })).toBe(false);
    expect(bad({ volume: 3 })).toBe(false);
    // Unknown fields from a client are not smuggled into the stored edit.
    expect(Edl.parse({ version: 1, aspect: "1:1", segments: [seg("a", 0, 5000)], ffmpeg: "-i /etc/passwd" })).not.toHaveProperty("ffmpeg");
  });

  it("measures output time through cuts and speed changes", () => {
    const e = { segments: [{ inMs: 1000, outMs: 5000, speed: 1 }, { inMs: 10_000, outMs: 14_000, speed: 2 }, { inMs: 20_000, outMs: 21_000, speed: 0.5 }] };
    expect(edlDurationMs(e)).toBe(4000 + 2000 + 2000);
    expect(edlOutputTime(e, 0, 3000)).toBe(2000);
    expect(edlOutputTime(e, 1, 12_000)).toBe(5000);
    expect(edlOutputTime(e, 2, 20_500)).toBe(7000);
    // Times outside a segment clamp to its edges.
    expect(edlOutputTime(e, 1, 0)).toBe(4000);
    expect(edlOutputTime(e, 1, 99_000)).toBe(6000);
  });

  it("validates screenshot and library inputs strictly", () => {
    expect(ScreenshotInput.safeParse({ from: "media", sessionId: SESSION, atMs: 13_000 }).success).toBe(true);
    expect(ScreenshotInput.safeParse({ from: "media", sessionId: SESSION, atMs: -1 }).success).toBe(false);
    expect(ScreenshotInput.safeParse({ from: "disk", path: "/etc/passwd" }).success).toBe(false);
    expect(LibraryItemPatch.safeParse({ visibility: "public" }).success).toBe(true);
    expect(LibraryItemPatch.safeParse({ visibility: "everyone" }).success).toBe(false);
    expect(LibraryItemPatch.safeParse({ broadcasterId: OTHER }).success).toBe(false);
  });

  it("recognizes only big result messages SLOT1 read on screen", () => {
    expect(bigMoment({ rawText: "MISSION PASSED  +$12,450", type: "objective_text", description: "" })).toEqual({ text: "MISSION PASSED", tone: "good" });
    expect(bigMoment({ rawText: "wasted", type: "visible_text", description: "" })).toEqual({ text: "WASTED", tone: "bad" });
    expect(bigMoment({ rawText: null, type: "result_screen", description: "Busted by the police" })).toEqual({ text: "BUSTED", tone: "bad" });
    expect(bigMoment({ rawText: null, type: "visible_text", description: "MISSION PASSED" })).toBeNull();
    expect(bigMoment({ rawText: "Mission objective: reach the docks", type: "objective_text", description: "" })).toBeNull();
  });
});

describe("reframing", () => {
  it("takes the largest crop of the target aspect, centred and clamped", () => {
    const vertical = { width: 1080, height: 1920 };
    expect(cropFor({ width: 1920, height: 1080 }, vertical, { x: 0.5, y: 0.5, zoom: 1 })).toEqual({ w: 606, h: 1080, x: 656, y: 0 });
    expect(cropFor({ width: 1920, height: 1080 }, vertical, { x: 0, y: 0.5, zoom: 1 })).toEqual({ w: 606, h: 1080, x: 0, y: 0 });
    expect(cropFor({ width: 1920, height: 1080 }, vertical, { x: 1, y: 0.5, zoom: 1 })).toEqual({ w: 606, h: 1080, x: 1314, y: 0 });
    const zoomed = cropFor({ width: 1920, height: 1080 }, vertical, { x: 0.5, y: 0.25, zoom: 2 });
    expect(zoomed).toEqual({ w: 302, h: 540, x: 808, y: 0 });
    // Widescreen into square: limited by height.
    expect(cropFor({ width: 1280, height: 720 }, { width: 1080, height: 1080 }, { x: 0.5, y: 0.5, zoom: 1 })).toEqual({ w: 720, h: 720, x: 280, y: 0 });
    // Every crop stays inside the source with even dimensions (yuv420p).
    for (const x of [0, 0.13, 0.5, 0.87, 1]) {
      for (const zoom of [1, 1.7, 4]) {
        const c = cropFor({ width: 1920, height: 1080 }, vertical, { x, y: 0.4, zoom });
        expect(c.x + c.w).toBeLessThanOrEqual(1920);
        expect(c.y + c.h).toBeLessThanOrEqual(1080);
        expect(c.w % 2 + c.h % 2 + c.x % 2 + c.y % 2).toBe(0);
      }
    }
  });
});

describe("ffmpeg filtergraph for an edit", () => {
  const edl = Edl.parse({
    version: 1,
    aspect: "9:16",
    segments: [seg("a", 4000, 9000), seg("b", 30_000, 34_000, { speed: 2, reframe: { x: 0.25, y: 0.5, zoom: 1.5 } })],
    texts: [{ id: "t1", text: "MISSION PASSED", startMs: 0, endMs: 3000, position: "top", style: "poster" }],
    fadeInMs: 300,
    fadeOutMs: 500,
    volume: 1.5,
  });

  it("seeks each segment accurately and assembles one output of the preset size", () => {
    const plan = buildEdlRender({ edl, media: [media(), media()], output: "/out/r.mp4", workDir: "/work", fonts });
    expect(plan).toMatchObject({ width: 1080, height: 1920, durationMs: 5000 + 2000 });
    const a = plan.args;
    // -ss before each -i: per-input seek, decoded from the previous keyframe (frame accurate).
    const inputs = a.flatMap((v, i) => (v === "-i" ? [i] : []));
    expect(inputs).toHaveLength(2);
    expect(a.slice(inputs[0]! - 4, inputs[0]!)).toEqual(["-ss", "4.000", "-t", "5.000"]);
    expect(a.slice(inputs[1]! - 4, inputs[1]!)).toEqual(["-ss", "30.000", "-t", "4.000"]);
    expect(a[a.indexOf("-protocol_whitelist") + 1]).toBe("file");
    const graph = a[a.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("concat=n=2:v=1:a=1[vcat][acat]");
    // Segment b: 2× speed on video and audio, reframed crop scaled to 1080×1920.
    const c = cropFor({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { x: 0.25, y: 0.5, zoom: 1.5 });
    expect(graph).toContain(`[1:v]setpts=PTS-STARTPTS,setpts=PTS/2,crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1080:1920`);
    expect(graph).toContain("atempo=2");
    expect(graph).toContain("trim=duration=2.000[v1]");
    // Text, fades and volume.
    expect(graph).toMatch(/drawtext=textfile='\/work\/text-0\.txt':expansion=none:fontfile='\/fonts\/PassionOne-Black\.ttf'/);
    expect(graph).toContain("enable='between(t,0.000,3.000)'");
    expect(graph).toContain("fade=t=in:st=0:d=0.300");
    expect(graph).toContain("fade=t=out:st=6.500:d=0.500");
    expect(graph).toContain("[acat]volume=1.5,afade=t=in:st=0:d=0.300,afade=t=out:st=6.500:d=0.500[aout]");
    expect(plan.textFiles).toEqual([{ path: "/work/text-0.txt", content: "MISSION PASSED" }]);
    expect(a.slice(a.indexOf("-c:v"), a.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
    expect(a).toEqual(expect.arrayContaining(["-movflags", "+faststart", "-pix_fmt", "yuv420p", "-progress", "pipe:1"]));
    expect(a[a.indexOf("-t", inputs[1]! + 1) + 1]).toBe("7.000");
    expect(a.at(-1)).toBe("/out/r.mp4");
  });

  it("keeps the whole frame over a blurred backdrop in fit layout, and fills silence", () => {
    const fit = Edl.parse({ ...edl, layout: "fit", texts: [] });
    const plan = buildEdlRender({ edl: fit, media: [media({ hasAudio: false }), media({ offsetMs: 28_000, path: "https://s3.example/rec.mp4?sig=1" })], output: "/o.mp4", workDir: "/w", fonts });
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("boxblur=24:2");
    expect(graph).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(graph).not.toContain("crop=606");
    expect(graph).toContain("aevalsrc=0|0:c=stereo:s=48000:d=5.000");
    // A window that starts later in the file is seeked relative to its own start; remote media
    // gets the network protocols it needs and nothing more.
    const second = plan.args.lastIndexOf("-i");
    expect(plan.args.slice(second - 6, second + 2)).toEqual(["-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-ss", "2.000", "-t", "4.000", "-i", "https://s3.example/rec.mp4?sig=1"]);
  });

  it("burns in only the transcript lines inside a segment, on the output timeline", () => {
    const cap = Edl.parse({ ...edl, texts: [], captions: true });
    const plan = buildEdlRender({
      edl: cap,
      media: [media(), media()],
      output: "/o.mp4",
      workDir: "/w",
      fonts,
      captions: [
        { segmentIndex: 0, startMs: 5000, endMs: 6000, text: "go go go" },
        { segmentIndex: 1, startMs: 32_000, endMs: 33_000, text: "we made it" },
        { segmentIndex: 0, startMs: 20_000, endMs: 21_000, text: "outside" },
      ],
    });
    expect(plan.textFiles.map((f) => f.content)).toEqual(["go go go", "we made it"]);
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("enable='between(t,1.000,2.000)'");
    expect(graph).toContain("enable='between(t,6.000,6.500)'");
  });

  it("chains atempo for half speed, switches encoders and refuses unresolved segments", () => {
    const slow = Edl.parse({ version: 1, aspect: "16:9", segments: [seg("a", 0, 2000, { speed: 0.5 })] });
    const plan = buildEdlRender({ edl: slow, media: [media()], output: "/o.mp4", workDir: "/w", fonts, encoder: "h264_nvenc" });
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("atempo=0.5");
    expect(graph).toContain("scale=1920:1080");
    expect(plan.durationMs).toBe(4000);
    expect(plan.args.slice(plan.args.indexOf("-c:v"), plan.args.indexOf("-c:v") + 2)).toEqual(["-c:v", "h264_nvenc"]);
    expect(() => buildEdlRender({ edl, media: [media()], output: "/o.mp4", workDir: "/w", fonts })).toThrow(/resolved media/);
  });

  it("ships OFL fonts for burned-in text and never Pricedown", () => {
    const f = findRenderFonts();
    expect(f.poster).toBeTruthy();
    expect(`${f.poster} ${f.caption}`).not.toMatch(/pricedown/i);
  });
});

describe("recording runs", () => {
  it("lays runs end to end in wall-clock order and maps run time onto the file", () => {
    const runs = [
      { runId: "rb", wallStart: "2026-11-01T10:10:00Z", wallEnd: "2026-11-01T10:11:00Z", segments: [{ key: "b1", startMs: 500, endMs: 6500, bytes: 1 }, { key: "b2", startMs: 6500, endMs: 9500, bytes: 1 }] },
      { runId: "ra", wallStart: "2026-11-01T10:00:00Z", wallEnd: "2026-11-01T10:05:00Z", segments: [{ key: "a1", startMs: 0, endMs: 6000, bytes: 1 }, { key: "a2", startMs: 6000, endMs: 12_000, bytes: 1 }] },
      { runId: "rc", wallStart: "2026-11-01T10:20:00Z", wallEnd: null, segments: [] },
    ];
    const o = runOffsets(runs);
    expect(o.map((x) => [x.runId, x.offsetMs, x.firstMs, x.durationMs])).toEqual([
      ["ra", 0, 0, 12_000],
      ["rb", 12_000, 500, 9000],
    ]);
  });
});

describe("editor time fields", () => {
  it("round-trips precise times", () => {
    expect(editTime(83_400)).toBe("1:23.4");
    expect(editTime(3_723_000)).toBe("1:02:03.0");
    expect(parseEditTime("1:23.4")).toBe(83_400);
    expect(parseEditTime("83.4")).toBe(83_400);
    expect(parseEditTime("1:02:03")).toBe(3_723_000);
    expect(parseEditTime("abc")).toBeNull();
    expect(parseEditTime("1:2:3:4")).toBeNull();
  });
});
