import { describe, expect, it } from "vitest";
import { buildEdlAudioRender, buildEdlRender, buildThumbnailRender, edlMediaNeeds, refKey, type EdlSegmentMedia, type ResolvedRef } from "@slot1/analysis";
import {
  addOverlayItem,
  applyEdlTemplate,
  deleteRefs,
  Edl,
  edlDurationMs,
  edlEdges,
  edlLocate,
  edlOutputTime,
  instantReplay,
  interpolateKeys,
  moveRef,
  moveSegment,
  presetProblem,
  RenderOptions,
  rippleDeleteSegments,
  rollEdit,
  segmentOutputMs,
  segmentStartsMs,
  snapTime,
  splitAt,
  splitSegmentAt,
  ThumbnailInput,
  toProviderJsonSchema,
  trimRef,
  trimSegment,
  type EdlInput,
} from "@slot1/contracts";

const S = "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f";
const S2 = "0b9c1a2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const UP = "11111111-2222-4333-8444-555555555555";
const media = (over: Partial<EdlSegmentMedia> = {}): EdlSegmentMedia => ({ path: "/media/rec.mp4", offsetMs: 0, width: 1920, height: 1080, hasAudio: true, ...over });
const fonts = { poster: "/fonts/PassionOne.ttf", caption: "/fonts/DejaVuSans-Bold.ttf" };
const seg = (id: string, inMs: number, outMs: number, extra: Record<string, unknown> = {}) => ({ id, sessionId: S, inMs, outMs, ...extra });
const edlOf = (over: Partial<EdlInput> = {}): Edl => Edl.parse({ version: 1, aspect: "9:16", segments: [seg("a", 1000, 6000), seg("b", 20_000, 24_000)], ...over });
const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;
const plan = (edl: Edl, extra: Partial<Parameters<typeof buildEdlRender>[0]> = {}) =>
  buildEdlRender({ edl, media: edl.segments.map(() => media()), output: "/out/r.mp4", workDir: "/work", fonts, fontsDir: "/fonts", ...extra });

describe("EDL back-compat and validation", () => {
  it("parses an edit saved before tracks existed and fills every new field with a default", () => {
    const old = { version: 1, aspect: "16:9", layout: "crop", segments: [{ id: "s1", sessionId: S, inMs: 0, outMs: 5000, speed: 2, reframe: { x: 0.5, y: 0.5, zoom: 1 } }], texts: [{ id: "t", text: "HI", startMs: 0, endMs: 1000 }], captions: true, fadeInMs: 0, fadeOutMs: 300, volume: 1, coverMs: null };
    const e = Edl.parse(old);
    expect(e.segments[0]).toMatchObject({ speed: 2, rampTo: null, keys: [], volume: 1, transitionIn: { kind: "cut", durationMs: 0 } });
    expect(e).toMatchObject({ overlays: [], audioTracks: [], effects: [], normalize: false, mainTrack: { locked: false } });
    expect(e.grade).toEqual({ preset: "none", brightness: 0, contrast: 1, saturation: 1, vignette: 0, grain: 0 });
    expect(e.captionTrack).toEqual({ style: "karaoke", position: "bottom", hidden: false, cues: [] });
    expect(e.sourceAudio).toEqual({ muted: false, solo: false, denoise: false, voiceBoost: false, envelope: [] });
    expect(e.split.cam).toEqual({ x: 0.73, y: 0.02, w: 0.26, h: 0.3 });
    // Re-parsing the parsed edit is stable (what the API stores is what renders).
    expect(Edl.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("renders an older edit with the original single-track command (no new filters)", () => {
    const e = Edl.parse({ version: 1, aspect: "9:16", segments: [seg("a", 4000, 9000), seg("b", 30_000, 34_000, { speed: 2 })], texts: [{ id: "t", text: "WOW", startMs: 0, endMs: 2000 }], fadeOutMs: 400 });
    const g = graphOf(plan(e).args);
    expect(g).toContain("concat=n=2:v=1:a=1[vcat][acat]");
    expect(g).toContain("drawtext=textfile=");
    for (const f of ["ass=", "xfade", "amix", "loudnorm", "sidechaincompress", "vstack", "colorbalance"]) expect(g).not.toContain(f);
    expect(plan(e).args).not.toContain("-maxrate");
  });

  it("rejects what can't render, with readable messages", () => {
    const bad = (over: Partial<EdlInput>) => Edl.safeParse({ version: 1, aspect: "9:16", segments: [seg("a", 0, 3000), seg("b", 5000, 8000)], ...over });
    const msg = (over: Partial<EdlInput>) => {
      const r = bad(over);
      return r.success ? null : r.error.issues[0]!.message;
    };
    expect(msg({ segments: [seg("a", 0, 3000, { speed: 5 })] })).toBeTruthy();
    expect(msg({ segments: [seg("a", 0, 3000, { rampTo: 0.1 })] })).toBeTruthy();
    expect(msg({ segments: [seg("a", 0, 3000), seg("b", 5000, 8000, { transitionIn: { kind: "flash", durationMs: 50 } })] })).toBe("A transition needs at least 0.1 s");
    expect(msg({ segments: [seg("a", 0, 1500), seg("b", 5000, 6500, { transitionIn: { kind: "crossfade", durationMs: 2000 } })] })).toBe("A transition is longer than the segments it joins");
    expect(msg({ segments: [seg("a", 1000, 3000, { keys: [{ atMs: 500, x: 0.5, y: 0.5, zoom: 1 }] })] })).toBe("Keyframes must sit inside their segment");
    expect(msg({ overlays: [{ id: "o", items: [{ type: "text", id: "x", startMs: 9000, endMs: 9500, text: "late" }] }] })).toBe("An overlay starts after the edit ends");
    expect(msg({ overlays: [{ id: "o", items: [{ type: "text", id: "x", startMs: 0, endMs: 900, text: "a" }, { type: "text", id: "x", startMs: 0, endMs: 900, text: "b" }] }] })).toBe("Overlay ids must be unique");
    expect(msg({ audioTracks: [{ id: "m", clips: [{ id: "c", source: { kind: "upload", assetId: UP }, startMs: 0, durationMs: 1000, fadeInMs: 800, fadeOutMs: 800 }] }] })).toBe("Audio fades are longer than the clip");
    expect(msg({ audioTracks: [{ id: "m", clips: [{ id: "c", source: { kind: "library", assetId: "../etc/passwd" }, startMs: 0, durationMs: 1000 }] }] })).toBeTruthy();
    expect(msg({ audioTracks: [{ id: "m", clips: [{ id: "c", source: { kind: "upload", assetId: "not-a-uuid" }, startMs: 0, durationMs: 1000 }] }] })).toBeTruthy();
    expect(msg({ effects: [{ id: "e", kind: "wasted", startMs: 7000, endMs: 6000 }] })).toBe("An effect must end after it starts");
    expect(msg({ captionTrack: { cues: [{ id: "c", startMs: 99_000, endMs: 99_500, text: "late" }] } })).toBe("A caption starts after the edit ends");
    expect(msg({ overlays: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}` })) })).toBeTruthy();
    expect(bad({}).success).toBe(true);
  });

  it("checks render options and thumbnail input strictly", () => {
    expect(RenderOptions.parse({})).toEqual({ presets: ["original"], format: "mp4", height: 1080, fps: 30, quality: "high" });
    expect(RenderOptions.safeParse({ presets: ["tiktok"], crf: 1 }).success).toBe(false);
    expect(RenderOptions.safeParse({ presets: ["myspace"] }).success).toBe(false);
    expect(RenderOptions.safeParse({ height: 480 }).success).toBe(false);
    expect(ThumbnailInput.safeParse({ atMs: 0, text: "" }).success).toBe(false);
    expect(presetProblem("shorts", "mp4", 200_000)).toBe("YouTube Shorts takes at most 180 s; this edit is 200 s");
    expect(presetProblem("tiktok", "gif", 31_000)).toMatch(/GIFs can be at most 30 seconds/);
    expect(presetProblem("youtube", "mp4", 9 * 60_000)).toBeNull();
  });

  it("describes itself as JSON Schema (no transforms)", () => {
    const schema = toProviderJsonSchema(Edl) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.overlays?.description).toMatch(/Overlay tracks/);
    expect(schema.properties.audioTracks?.description).toMatch(/Audio tracks/);
    // The ducking caveat travels with the schema (AI tools read it too).
    expect(JSON.stringify(schema)).toContain("ducks it too");
  });

  it("measures time through ramps and transitions", () => {
    const e = edlOf({ segments: [seg("a", 0, 4000), seg("b", 10_000, 13_000, { rampTo: 0.5, transitionIn: { kind: "flash", durationMs: 400 } }), seg("c", 20_000, 22_000, { transitionIn: { kind: "dip", durationMs: 300 } })] });
    const b = e.segments[1]!;
    expect(segmentOutputMs(b)).toBeGreaterThan(3000 / 1);
    expect(segmentOutputMs(b)).toBeLessThan(3000 / 0.5);
    const starts = segmentStartsMs(e);
    expect(starts[1]).toBe(4000 - 400);
    expect(Math.round(starts[2]!)).toBe(Math.round(starts[1]! + segmentOutputMs(b) - 300));
    expect(edlDurationMs(e)).toBe(Math.round(4000 + segmentOutputMs(b) + 2000 - 400 - 300));
    for (const t of [0, 1234, 4100, 6000, edlDurationMs(e) - 10]) {
      const { index, sourceMs } = edlLocate(e, t);
      expect(Math.abs(edlOutputTime(e, index, sourceMs) - t)).toBeLessThanOrEqual(2);
    }
    expect(interpolateKeys([{ atMs: 0, v: 0 }, { atMs: 1000, v: 10 }], 250, (k) => k.v)).toBe(2.5);
  });
});

describe("editing operations", () => {
  const rich = () =>
    edlOf({
      segments: [seg("a", 0, 4000), seg("b", 10_000, 14_000), seg("c", 30_000, 33_000)],
      overlays: [{ id: "o", items: [{ type: "text", id: "t1", startMs: 1000, endMs: 2000, text: "A" }, { type: "text", id: "t2", startMs: 9000, endMs: 10_000, text: "C" }] }],
      audioTracks: [{ id: "m", kind: "music", clips: [{ id: "c1", source: { kind: "upload", assetId: UP }, startMs: 9000, durationMs: 1500 }] }],
      effects: [{ id: "e1", kind: "punch", startMs: 5000, endMs: 5600 }],
      captionTrack: { cues: [{ id: "k1", startMs: 9200, endMs: 10_500, text: "hey" }] },
    });

  it("splits a segment at the playhead without changing the length", () => {
    const e = edlOf({ segments: [seg("a", 0, 6000, { keys: [{ atMs: 0, x: 0.2, y: 0.5, zoom: 1 }, { atMs: 6000, x: 0.8, y: 0.5, zoom: 2 }] })] });
    const r = splitSegmentAt(e, 3000)!;
    expect(r.edl.segments.map((s) => [s.inMs, s.outMs])).toEqual([
      [0, 3000],
      [3000, 6000],
    ]);
    expect(edlDurationMs(r.edl)).toBe(6000);
    expect(r.edl.segments[0]!.keys.at(-1)).toMatchObject({ atMs: 3000, x: 0.5, zoom: 1.5 });
    expect(r.edl.segments[1]!.keys[0]).toMatchObject({ atMs: 3000, x: 0.5, zoom: 1.5 });
    expect(Edl.safeParse(r.edl).success).toBe(true);
    expect(splitSegmentAt(e, 100)).toBeNull();
  });

  it("ripple deletes a segment and pulls everything after it earlier", () => {
    const r = rippleDeleteSegments(rich(), ["b"])!;
    expect(r.segments.map((s) => s.id)).toEqual(["a", "c"]);
    expect(edlDurationMs(r)).toBe(7000);
    const items = r.overlays[0]!.items;
    expect(items.find((x) => x.id === "t1")).toMatchObject({ startMs: 1000, endMs: 2000 });
    // t2 sat over segment c (8000..11000 before): now 4000 earlier.
    expect(items.find((x) => x.id === "t2")).toMatchObject({ startMs: 5000, endMs: 6000 });
    // The punch was entirely over segment b: gone. The caption over c moved with it.
    expect(r.effects).toEqual([]);
    expect(r.captionTrack.cues[0]).toMatchObject({ startMs: 5200, endMs: 6500 });
    expect(r.audioTracks[0]!.clips[0]).toMatchObject({ startMs: 5000, durationMs: 1500 });
    expect(Edl.safeParse(r).success).toBe(true);
    expect(rippleDeleteSegments(rich(), ["a", "b", "c"])).toBeNull();
  });

  it("keeps items on their footage when a segment is trimmed", () => {
    const e = rich();
    // Trim 1 s off the head of segment b: c (and t2 over it) move 1 s earlier.
    const r = trimSegment(e, "b", "in", 11_000);
    expect(r.segments[1]).toMatchObject({ inMs: 11_000, outMs: 14_000 });
    expect(r.overlays[0]!.items.find((x) => x.id === "t2")).toMatchObject({ startMs: 8000, endMs: 9000 });
    // The punch at 5000..5600 sat on b's footage at 11000..11600: still on it, now at 4000.
    expect(r.effects[0]).toMatchObject({ startMs: 4000, endMs: 4600 });
    expect(trimSegment(e, "b", "out", 10_100).segments[1]!.outMs).toBe(10_300);
  });

  it("rolls a cut without moving anything after it", () => {
    const e = rich();
    const r = rollEdit(e, 0, 500);
    expect(r.segments[0]!.outMs).toBe(4500);
    expect(r.segments[1]!.inMs).toBe(10_500);
    expect(edlDurationMs(r)).toBe(edlDurationMs(e));
    expect(r.overlays).toEqual(e.overlays);
    // Limited by the next segment's minimum length.
    expect(rollEdit(e, 0, 99_999).segments[1]!.outMs - rollEdit(e, 0, 99_999).segments[1]!.inMs).toBe(300);
  });

  it("moves a segment with the items over it", () => {
    const r = moveSegment(rich(), "c", 0);
    expect(r.segments.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(r.overlays[0]!.items.find((x) => x.id === "t2")).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(r.overlays[0]!.items.find((x) => x.id === "t1")).toMatchObject({ startMs: 4000, endMs: 5000 });
  });

  it("deletes items with or without closing the gap on their track", () => {
    const e = rich();
    const ref = { kind: "overlay" as const, trackId: "o", id: "t1" };
    expect(deleteRefs(e, [ref]).overlays[0]!.items.map((x) => [x.id, x.startMs])).toEqual([["t2", 9000]]);
    expect(deleteRefs(e, [ref], true).overlays[0]!.items.map((x) => [x.id, x.startMs])).toEqual([["t2", 8000]]);
    // Other tracks don't move.
    expect(deleteRefs(e, [ref], true).effects[0]!.startMs).toBe(5000);
  });

  it("moves and trims items with keyframes, offsets and limits", () => {
    const e = addOverlayItem(rich(), { type: "image", id: "s", startMs: 2000, endMs: 3000, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, keys: [{ atMs: 2000, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }], source: { kind: "library", assetId: "sticker/star" }, widthPct: 0.3 }, "o");
    const moved = moveRef(e, { kind: "overlay", trackId: "o", id: "s" }, 4000);
    expect(moved.overlays[0]!.items.find((x) => x.id === "s")).toMatchObject({ startMs: 4000, endMs: 5000, keys: [{ atMs: 4000 }] });
    const head = trimRef(e, { kind: "audio", trackId: "m", id: "c1" }, "start", 9500);
    expect(head.audioTracks[0]!.clips[0]).toMatchObject({ startMs: 9500, offsetMs: 500, durationMs: 1000 });
    const tail = trimRef(e, { kind: "audio", trackId: "m", id: "c1" }, "end", 10_800, { maxDurationMs: 1200 });
    expect(tail.audioTracks[0]!.clips[0]!.durationMs).toBe(1200);
    expect(splitAt(e, 9500, { kind: "audio", trackId: "m", id: "c1" })!.edl.audioTracks[0]!.clips.map((c) => [c.startMs, c.offsetMs, c.durationMs])).toEqual([
      [9000, 0, 500],
      [9500, 500, 1000],
    ]);
  });

  it("snaps to the nearest edge within tolerance", () => {
    const edges = edlEdges(rich());
    expect(edges).toEqual(expect.arrayContaining([0, 1000, 2000, 4000, 8000, 9000, 11_000]));
    expect(snapTime(1980, edges, 50)).toEqual({ ms: 2000, snapped: true, target: 2000 });
    expect(snapTime(2500, edges, 50).snapped).toBe(false);
  });

  it("adds an instant replay at half speed with a flash and a REPLAY tag", () => {
    const r = instantReplay(rich(), 3000)!;
    const replay = r.edl.segments.find((s) => s.speed === 0.5)!;
    expect(replay).toMatchObject({ inMs: 500, outMs: 3000, transitionIn: { kind: "flash", durationMs: 250 } });
    expect(r.edl.overlays.flatMap((t) => t.items).some((x) => x.type === "text" && x.text === "REPLAY")).toBe(true);
    expect(Edl.safeParse(r.edl).success).toBe(true);
  });

  it("applies templates from real data only, and says when data is missing", () => {
    const ctx = { title: "Docks job", cameraBox: { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, durations: { [S]: 60_000 }, markers: [{ sessionId: S, ms: 2000, label: "MISSION PASSED", kind: "big" as const }, { sessionId: S, ms: 31_000, label: "WASTED", kind: "big" as const }] };
    const tiktok = applyEdlTemplate("tiktok-highlight", rich(), ctx);
    expect(tiktok.edl).toMatchObject({ aspect: "9:16", layout: "split", normalize: true, split: { cam: ctx.cameraBox } });
    expect(tiktok.edl.effects.filter((f) => f.kind === "punch")).toHaveLength(3);
    expect(Edl.safeParse(tiktok.edl).success).toBe(true);
    const best = applyEdlTemplate("best-of", rich(), ctx);
    expect(best.edl.segments.map((s) => [s.inMs, s.outMs])).toEqual([
      [0, 4000],
      [27_000, 33_000],
    ]);
    expect(best.edl.segments[1]!.transitionIn.kind).toBe("flash");
    expect(Edl.safeParse(best.edl).success).toBe(true);
    const wasted = applyEdlTemplate("wasted-moment", rich(), ctx);
    expect(wasted.edl.segments.find((s) => s.rampTo === 0.4)).toBeTruthy();
    expect(wasted.edl.effects.map((f) => f.kind)).toEqual(["shake", "wasted"]);
    expect(Edl.safeParse(wasted.edl).success).toBe(true);
    const none = applyEdlTemplate("wasted-moment", rich(), { ...ctx, markers: [] });
    expect(none.changed).toBe(false);
    expect(none.note).toMatch(/hasn't marked a WASTED/);
    expect(applyEdlTemplate("best-of", rich(), { ...ctx, markers: [] }).changed).toBe(false);
  });
});

describe("ffmpeg filtergraph for every feature", () => {
  it("stacks facecam over gameplay with a divider in the split layout", () => {
    const e = edlOf({ layout: "split", split: { cam: { x: 0.7, y: 0.05, w: 0.25, h: 0.3 }, camShare: 0.4, camOnTop: true } });
    const p = plan(e);
    const g = graphOf(p.args);
    expect(g).toContain("split=2[cam0][game0]");
    expect(g).toContain(`[cam0]crop=${Math.round(1920 * 0.25)}:${Math.round(1080 * 0.3)}:${Math.round(1920 * 0.7)}:${Math.round(1080 * 0.05)}`);
    expect(g).toContain("[camS0][gameS0]vstack=inputs=2");
    expect(g).toMatch(/drawbox=x=0:y=\d+:w=1080:h=3:color=0xFFC94D:t=fill/);
    expect(p).toMatchObject({ width: 1080, height: 1920 });
  });

  it("animates the crop for keyframed pan and zoom", () => {
    const e = edlOf({ segments: [seg("a", 1000, 5000, { keys: [{ atMs: 1000, x: 0.3, y: 0.5, zoom: 1 }, { atMs: 5000, x: 0.7, y: 0.5, zoom: 2 }] })] });
    const g = graphOf(plan(e).args);
    expect(g).toContain(":eval=frame");
    expect(g).toMatch(/crop=\d+:\d+:x='clip\(/);
    expect(g).toContain("if(lt(t,4),1+(1)*(t-0)/4,2)");
  });

  it("ramps speed in steps on picture and sound", () => {
    const e = edlOf({ segments: [seg("a", 0, 3000, { rampTo: 0.5 })] });
    const g = graphOf(plan(e).args);
    expect(g).toContain("split=8[r0_0]");
    expect(g).toContain("setpts=(PTS-STARTPTS)/0.969");
    expect(g).toContain("atempo=0.531");
    expect(g).toContain("concat=n=8:v=1:a=0");
  });

  it("joins segments with xfade and acrossfade for transitions", () => {
    const kinds = { crossfade: "fade", flash: "fadewhite", dip: "fadeblack", whip: "smoothleft", glitch: "pixelize" } as const;
    for (const [kind, name] of Object.entries(kinds)) {
      const e = edlOf({ segments: [seg("a", 0, 3000), seg("b", 5000, 8000, { transitionIn: { kind, durationMs: 400 } })] });
      const g = graphOf(plan(e).args);
      expect(g).toContain(`xfade=transition=${name}:duration=0.400:offset=2.600`);
      expect(g).toContain("acrossfade=d=0.400");
      expect(plan(e).durationMs).toBe(5600);
    }
  });

  it("grades the picture with original presets", () => {
    expect(graphOf(plan(edlOf({ grade: { preset: "vice-night" } })).args)).toContain("colorbalance=rs=0.08");
    expect(graphOf(plan(edlOf({ grade: { preset: "noir" } })).args)).toContain("hue=s=0,eq=contrast=1.35");
    const g = graphOf(plan(edlOf({ grade: { preset: "golden-hour", brightness: 0.1, vignette: 0.5, grain: 0.5 } })).args);
    expect(g).toContain("eq=brightness=0.1:contrast=1:saturation=1");
    expect(g).toContain("vignette=angle=0.625");
    expect(g).toContain("noise=alls=8:allf=t");
  });

  it("freezes, greys and bannners WASTED in one linear chain; other effects in their windows", () => {
    const e = edlOf({
      effects: [
        { id: "w", kind: "wasted", startMs: 7000, endMs: 9000 },
        { id: "p", kind: "punch", startMs: 1000, endMs: 1600, amount: 0.5 },
        { id: "s", kind: "shake", startMs: 2000, endMs: 2500 },
        { id: "f", kind: "flash", startMs: 3000, endMs: 3300 },
        { id: "g", kind: "glitch", startMs: 4000, endMs: 4400 },
        { id: "m", kind: "passed", startMs: 5000, endMs: 6500, text: "HEIST DONE" },
      ],
    });
    const p = plan(e);
    const g = graphOf(p.args);
    expect(g).not.toContain("freezeframes");
    expect(g).toContain("loop=loop=59:size=1:start=211,select='lt(n,270)+gte(n,329)',setpts=N/(30*TB)");
    expect(g).toContain("hue=s=0:enable='between(t,7,9)'");
    expect(g).toMatch(/\[pb\d+\]crop=\d+:\d+:\d+:\d+,scale=1080:1920/);
    expect(g).toContain("sin(2*PI*t*11)");
    expect(g).toContain("eq=brightness='0.6*max(0,1-(t-3)/0.3)'");
    expect(g).toMatch(/rgbashift=rh=-\d+:bh=\d+:enable='between\(t,4,4.4\)'/);
    const ass = p.textFiles.map((f) => f.content).join("\n");
    expect(ass).toContain("WASTED");
    expect(ass).toContain("HEIST DONE");
  });

  it("draws overlay tracks: animated text, keyframed images and picture-in-picture", () => {
    const e = edlOf({
      overlays: [
        {
          id: "o",
          items: [
            { type: "text", id: "t1", startMs: 0, endMs: 2000, text: "THE DOCKS", subtext: "Mission 4", style: "title-card", animation: "pop" },
            { type: "text", id: "t2", startMs: 2000, endMs: 4000, text: "typing", style: "caption", animation: "typewriter" },
            { type: "image", id: "i1", startMs: 1000, endMs: 3000, source: { kind: "library", assetId: "sticker/star" }, keys: [{ atMs: 1000, x: 0.2, y: 0.5, scale: 1, rotation: -10, opacity: 0.3 }, { atMs: 3000, x: 0.8, y: 0.5, scale: 1.5, rotation: 10, opacity: 1 }] },
            { type: "pip", id: "p1", startMs: 4000, endMs: 6000, sessionId: S2, sourceInMs: 12_000, box: { x: 0.7, y: 0, w: 0.3, h: 0.3 } },
          ],
        },
      ],
    });
    const refs: Record<string, ResolvedRef> = { [refKey({ kind: "library", assetId: "sticker/star" })]: { path: "/lib/star.png", kind: "image" } };
    const p = plan(e, { refs, pips: { p1: media({ path: "/media/other.mp4" }) } });
    const a = p.args;
    expect(a).toEqual(expect.arrayContaining(["-loop", "1", "-i", "/lib/star.png"]));
    // The picture-in-picture source is its own accurately seeked input.
    expect(a.slice(a.indexOf("/media/other.mp4") - 5, a.indexOf("/media/other.mp4") + 1)).toEqual(["-ss", "12.000", "-t", "2", "-i", "/media/other.mp4"]);
    const g = graphOf(a);
    expect(g).toMatch(/rotate=a='.*':c=none/);
    expect(g).toContain("geq=");
    expect(g).toContain("enable='between(t,4,6)'");
    expect(g).toMatch(/crop=\d+:\d+:\d+:0,pad=iw\+10:ih\+10/);
    const ass = p.textFiles.map((f) => f.content).join("\n");
    expect(ass).toContain("THE DOCKS");
    expect(ass).toContain("Mission 4");
    expect(ass).toMatch(/\\t\(0,170,\\fscx\d+/);
    // Typewriter: one event per growing prefix.
    expect(ass).toContain("}t\n");
    expect(ass).toContain("}typing\n");
    expect(ass).not.toMatch(/Pricedown/i);
  });

  it("fails clearly for an unknown library item", () => {
    const e = edlOf({ overlays: [{ id: "o", items: [{ type: "image", id: "i", startMs: 0, endMs: 1000, source: { kind: "library", assetId: "sticker/missing" } }] }] });
    expect(() => plan(e)).toThrow("Unknown Studio library item: sticker/missing");
    expect(edlMediaNeeds(e).refs).toEqual([{ kind: "library", assetId: "sticker/missing" }]);
  });

  it("burns in word-highlight captions", () => {
    const e = edlOf({ captionTrack: { style: "karaoke", cues: [{ id: "c", startMs: 500, endMs: 2500, text: "no way we made it" }] } });
    const p = plan(e);
    const ass = p.textFiles.map((f) => f.content).join("\n");
    expect(ass).toMatch(/cap-karaoke,.*\{\\k\d+\}\{\\k\d+\}no/);
    expect(graphOf(p.args)).toMatch(/ass='\/work\/[^']+\.ass':fontsdir='\/fonts'/);
  });

  it("mixes audio tracks with fades, envelopes, ducking and loudness", () => {
    const e = edlOf({
      sourceAudio: { denoise: true, voiceBoost: true },
      normalize: true,
      audioTracks: [
        { id: "m", kind: "music", duck: true, volume: 0.8, clips: [{ id: "c1", source: { kind: "upload", assetId: UP }, startMs: 0, durationMs: 9000, loop: true, fadeOutMs: 800 }] },
        { id: "x", kind: "sfx", clips: [{ id: "c2", source: { kind: "library", assetId: "sfx/whoosh" }, startMs: 2700, durationMs: 800, envelope: [{ atMs: 2700, volume: 0.2 }, { atMs: 3000, volume: 1 }] }] },
      ],
    });
    const refs: Record<string, ResolvedRef> = { [refKey({ kind: "upload", assetId: UP })]: { path: "/up/bed.m4a", kind: "audio" }, [refKey({ kind: "library", assetId: "sfx/whoosh" })]: { path: "/lib/whoosh.ogg", kind: "audio" } };
    const p = plan(e, { refs });
    const a = p.args;
    // A looping bed is bounded so ffmpeg never reads forever.
    expect(a.slice(a.indexOf("/up/bed.m4a") - 5, a.indexOf("/up/bed.m4a") + 1)).toEqual(["-stream_loop", "-1", "-t", "9.000", "-i", "/up/bed.m4a"]);
    const g = graphOf(a);
    expect(g).toContain("afftdn=nf=-28");
    expect(g).toContain("equalizer=f=2800");
    expect(g).toContain("[srcsc0]highpass=f=300,lowpass=f=3400[srcsc]");
    expect(g).toContain("sidechaincompress=threshold=0.04:ratio=6");
    expect(g).toContain("adelay=2700:all=1");
    expect(g).toContain("volume='if(lt(t,2.7),0.2,");
    expect(g).toContain("afade=t=out:st=8.200:d=0.800");
    expect(g).toMatch(/amix=inputs=3:normalize=0:duration=first,apad,atrim=duration=9\.000/);
    expect(g).toContain("loudnorm=I=-14:TP=-1.5:LRA=11");
    expect(g).toContain("alimiter=limit=0.97");
  });

  it("honours export presets, GIF and audio-only output", () => {
    const e = edlOf({ aspect: "16:9", normalize: true });
    const yt = plan(e, { options: { aspect: "9:16", height: 720, fps: 60, quality: "small", maxrateKbps: 8000 } });
    expect(yt).toMatchObject({ width: 720, height: 1280, container: "mp4" });
    expect(yt.args).toEqual(expect.arrayContaining(["-crf", "27", "-maxrate", "8000k", "-r", "60"]));
    const gif = plan(e, { output: "/out/r.gif", options: { format: "gif" } });
    expect(gif.container).toBe("gif");
    expect(graphOf(gif.args)).toContain("palettegen=max_colors=128");
    expect(gif.args).not.toContain("-c:a");
    const audio = plan(e, { output: "/out/r.m4a", options: { format: "audio" } });
    expect(audio.container).toBe("m4a");
    expect(audio.args).toEqual(expect.arrayContaining(["-map", "[aout]", "-c:a", "aac"]));
    expect(audio.args).not.toContain("[vout]");
    const speech = buildEdlAudioRender({ edl: e, media: e.segments.map(() => media()), output: "/out/a.mp3", workDir: "/work" });
    expect(speech.args.slice(-9)).toEqual(["-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", "-t", "9.000", "/out/a.mp3"].slice(-9));
  });

  it("makes a 1280×720 thumbnail with styled text", () => {
    const t = buildThumbnailRender({ frame: "/w/frame.jpg", output: "/w/t.png", workDir: "/w", fontsDir: "/fonts", text: "HEIST", subtext: "part 2", style: "mission", position: "bottom", grade: Edl.parse({ version: 1, aspect: "9:16", segments: [seg("a", 0, 1000)], grade: { preset: "neon" } }).grade });
    const vf = t.args[t.args.indexOf("-vf") + 1]!;
    expect(vf).toContain("scale=1280:720:force_original_aspect_ratio=increase");
    expect(vf).toContain("crop=1280:720");
    expect(vf).toContain("eq=saturation=1.5");
    expect(vf).toContain("ass='/w/thumbnail.ass':fontsdir='/fonts'");
    expect(t.textFiles[0]!.content).toContain("HEIST");
    expect(t.args).toEqual(expect.arrayContaining(["-frames:v", "1", "/w/t.png"]));
  });
});
