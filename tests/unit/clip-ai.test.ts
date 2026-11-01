import { describe, expect, it } from "vitest";
import {
  cutRangesFromEdl,
  describeEdlChanges,
  Edl,
  EDIT_REQUEST_BASE_CHARS,
  edlDurationMs,
  edlLibraryRefs,
  estimateEditTokens,
  ModelEditProposal,
  ModelPosts,
  momentsEdl,
  OBSERVATION_SCHEMA_VERSION,
  scoreStars,
  stripUnknownAssets,
  tokenCostUsd,
  type Observation,
} from "@slot1/contracts";
import { audioPeaks, findBoringParts, momentsInEdl, parseRmsLines, providerSchema, rankMoments, rmsArgs, soundCues, tidyPost } from "@slot1/services";

const SESSION = "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f";
let n = 0;

/** An observation as the analyzer stores it: real evidence, a media time, unreviewed. */
function obs(over: Partial<Observation> & Pick<Observation, "type" | "mediaStartMs">): Observation {
  n++;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    broadcasterId: "b1",
    sessionId: SESSION,
    sourceId: "src1",
    mediaEndMs: null,
    capturedAt: null,
    receivedAt: "2026-10-01T10:00:00.000Z",
    analyzedAt: null,
    publishedAt: null,
    description: "Something on screen",
    origin: "ocr",
    interpretation: "directly_visible",
    evidence: [{ assetId: `frame-${n}`, kind: "frame", mediaPtsMs: over.mediaStartMs }],
    rawText: null,
    model: null,
    modelConfidence: null,
    reviewStatus: "unreviewed",
    relatedEntities: [],
    ...over,
  };
}

const seg = (id: string, inMs: number, outMs: number, extra: Record<string, unknown> = {}) => ({ id, sessionId: SESSION, inMs, outMs, ...extra });
const edlOf = (x: Record<string, unknown>) => Edl.parse({ version: 1, aspect: "9:16", ...x });

/** One RMS value per second: a quiet bed with optional loud seconds and silent seconds. */
function levels(seconds: number, loud: number[] = [], silent: number[] = []): number[] {
  return Array.from({ length: seconds }, (_, i) => (loud.includes(i) ? -6 : silent.includes(i) ? -120 : -38 + ((i * 7) % 3) * 0.5));
}

describe("audio levels", () => {
  it("parses one RMS value per second from ffmpeg's astats output, silence as -120 dB", () => {
    const out = ["frame:0    pts:0       pts_time:0", "lavfi.astats.Overall.RMS_level=-21.08", "frame:1    pts:8000    pts_time:1", "lavfi.astats.Overall.RMS_level=-inf", "lavfi.astats.Overall.RMS_level=-3.5"].join("\n");
    expect(parseRmsLines(out)).toEqual([-21.1, -120, -3.5]);
    expect(parseRmsLines("nothing here")).toEqual([]);
  });

  it("reads local files with only the file protocol and remote ones over https", () => {
    expect(rmsArgs("/media/a.mp4", false)).toContain("file");
    expect(rmsArgs("https://s3.example/a.mp4", true).join(" ")).toContain("https");
    expect(rmsArgs("/media/a.mp4", false).join(" ")).toContain("astats=metadata=1:reset=1");
  });

  it("finds seconds well above the session's typical level, ignoring silence", () => {
    const peaks = audioPeaks(levels(60, [20, 21], [40, 41, 42, 43, 44]));
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.atMs).toBe(20_500);
    expect(peaks[0]!.excessDb).toBeGreaterThan(30);
    // A steady level has no spikes; too few voiced seconds means no ranking from audio.
    expect(audioPeaks(Array(60).fill(-20))).toEqual([]);
    expect(audioPeaks([-10, -120, -120])).toEqual([]);
  });
});

describe("best moments", () => {
  it("ranks a result screen with a loud moment and a mission title first, with reasons that cite times", () => {
    const observations = [
      obs({ type: "mission_title", mediaStartMs: 12_000, rawText: "The Docks", description: "Mission title The Docks" }),
      obs({ type: "result_screen", mediaStartMs: 30_000, mediaEndMs: 34_000, rawText: "MISSION PASSED", description: "MISSION PASSED on screen" }),
      obs({ type: "place_name", mediaStartMs: 90_000, rawText: "Vespucci Beach", description: "Place name Vespucci Beach" }),
      // Never ranked: platform facts, rejected readings and coverage measurements.
      obs({ type: "result_screen", mediaStartMs: 120_000, rawText: "WASTED", description: "WASTED", reviewStatus: "rejected" }),
      obs({ type: "media_facts", mediaStartMs: 0, description: "Media facts" }),
    ];
    const ranked = rankMoments({ sessionId: SESSION, durationMs: 180_000, observations, rmsDb: levels(180, [27]), clipRequests: [] });
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    const top = ranked[0]!;
    expect(top).toMatchObject({ big: "MISSION PASSED", tone: "good", title: "MISSION PASSED", peakMs: 30_000, sessionId: SESSION });
    expect(top.reasons.map((r) => r.signal)).toEqual(expect.arrayContaining(["result", "audio_peak"]));
    expect(top.reasons.find((r) => r.signal === "result")!.label).toBe("MISSION PASSED read on screen at 00:30");
    expect(top.reasons.find((r) => r.signal === "audio_peak")!.label).toMatch(/^Audio spike \+\d+ dB at 00:27$/);
    // The window starts before the action that leads to the result and ends after it.
    expect(top.startMs).toBeLessThanOrEqual(20_000);
    expect(top.endMs).toBeGreaterThanOrEqual(34_000);
    expect(top.endMs - top.startMs).toBeLessThanOrEqual(60_000);
    expect(top.stars).toBe(scoreStars(top.score));
    expect(top.score).toBeGreaterThan(ranked[1]!.score);
    expect(top.frameAssetId).toMatch(/^frame-/);
    expect(ranked.some((m) => m.big === "WASTED")).toBe(false);
    // Scores are SLOT1's own 0–100 ranking scale.
    for (const m of ranked) expect(m.score).toBeGreaterThanOrEqual(0);
    for (const m of ranked) expect(m.score).toBeLessThanOrEqual(100);
  });

  it("counts clip requests and bursts of scene cuts, and never overlaps two moments", () => {
    const cuts = [100_000, 104_000, 108_000, 111_000].map((t) => obs({ type: "scene_transition", mediaStartMs: t, origin: "video", description: "Scene cut" }));
    const ranked = rankMoments({ sessionId: SESSION, durationMs: 300_000, observations: cuts, rmsDb: null, clipRequests: [{ atMs: 200_000, source: "chat" }] });
    const burst = ranked.find((m) => m.reasons.some((r) => r.signal === "cut_burst"))!;
    expect(burst.reasons[0]!.label).toBe("4 scene cuts in 11 s from 01:40");
    const req = ranked.find((m) => m.reasons.some((r) => r.signal === "clip_request"))!;
    expect(req.reasons[0]!.label).toContain("!slot1 clip");
    expect(req.startMs).toBe(180_000); // 20 s before the request: the action came first
    for (const a of ranked)
      for (const b of ranked) if (a !== b) expect(Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)).toBeLessThanOrEqual(0.5 * Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
  });

  it("returns nothing when nothing was detected", () => {
    expect(rankMoments({ sessionId: SESSION, durationMs: 60_000, observations: [], rmsDb: null, clipRequests: [] })).toEqual([]);
  });

  it("turns picked moments into a valid edit: one clip with a mission title, or a reel in time order", () => {
    const picks = [
      { startMs: 40_000, endMs: 52_000, title: "Crash", peakMs: null, tone: "neutral" as const, big: null },
      { startMs: 20_000, endMs: 34_000, title: "MISSION PASSED", peakMs: 30_000, tone: "good" as const, big: "MISSION PASSED" },
    ];
    const single = momentsEdl(SESSION, [picks[1]!], { aspect: "9:16", mode: "single" });
    expect(single.layout).toBe("fit");
    expect(single.overlays[0]!.items[0]).toMatchObject({ type: "text", style: "mission", text: "MISSION PASSED" });
    expect(single.effects).toEqual([expect.objectContaining({ kind: "passed", startMs: 10_000, text: "MISSION PASSED" })]);

    const reel = momentsEdl(SESSION, picks, { aspect: "16:9", mode: "reel" });
    expect(reel.segments.map((s) => s.inMs)).toEqual([20_000, 40_000]);
    expect(reel.segments[1]!.transitionIn).toEqual({ kind: "whip", durationMs: 250 });
    expect(reel.layout).toBe("crop");
    expect(reel.normalize).toBe(true);
    expect(reel.overlays[0]!.items.map((it) => (it.type === "text" ? it.style : null))).toEqual(["title-card", "title-card"]);
    expect(Edl.safeParse(reel).success).toBe(true);
  });
});

describe("boring parts", () => {
  const edl = edlOf({ segments: [seg("a", 0, 60_000), seg("b", 100_000, 104_000)] });

  it("finds black screens, loading screens and silence inside the edit's parts", () => {
    const observations = [
      obs({ type: "black_screen", mediaStartMs: 5_000, mediaEndMs: 7_500, origin: "video", description: "Black screen" }),
      obs({ type: "visible_text", mediaStartMs: 20_000, rawText: "LOADING", description: "LOADING" }),
      obs({ type: "objective_text", mediaStartMs: 30_000, rawText: "Go to the docks", description: "Objective" }),
      obs({ type: "objective_text", mediaStartMs: 50_000, rawText: "Lose the cops", description: "Objective" }),
    ];
    const rmsDb = levels(120, [], [40, 41, 42, 43]);
    const parts = findBoringParts(edl, new Map([[SESSION, { observations, rmsDb }]]));
    const kinds = parts.map((p) => [p.kind, p.startMs, p.endMs]);
    expect(kinds).toContainEqual(["black", 5_000, 7_500]);
    expect(kinds).toContainEqual(["loading", 19_000, 22_000]);
    expect(kinds).toContainEqual(["silence", 40_000, 44_000]);
    for (const p of parts) {
      expect(p.segmentId).toBe("a");
      expect(p.id).toBe(`a:${p.startMs}-${p.endMs}`);
    }
    expect(parts.find((p) => p.kind === "black")!.label).toBe("Black screen for 3 s");
  });

  it("never offers to cut a whole part, and needs measured audio for silence", () => {
    const observations = [obs({ type: "black_screen", mediaStartMs: 100_000, mediaEndMs: 104_000, origin: "video", description: "Black screen" })];
    expect(findBoringParts(edl, new Map([[SESSION, { observations, rmsDb: null }]])).filter((p) => p.segmentId === "b")).toEqual([]);
    expect(findBoringParts(edl, new Map([[SESSION, { observations: [], rmsDb: null }]])).some((p) => p.kind === "silence")).toBe(false);
  });

  it("calls a long stretch with no events and quieter audio boring", () => {
    const long = edlOf({ segments: [seg("a", 0, 90_000)] });
    const observations = [obs({ type: "objective_text", mediaStartMs: 2_000, rawText: "Go", description: "Objective" }), obs({ type: "objective_text", mediaStartMs: 80_000, rawText: "Go", description: "Objective" })];
    const rmsDb = Array.from({ length: 90 }, (_, i) => (i > 20 && i < 70 ? -52 : -30));
    const quiet = findBoringParts(long, new Map([[SESSION, { observations, rmsDb }]])).filter((p) => p.kind === "quiet" || p.kind === "silence");
    expect(quiet.length).toBeGreaterThan(0);
  });
});

describe("cutting parts out of an edit", () => {
  const base = edlOf({
    segments: [seg("a", 0, 20_000, { speed: 1 }), seg("b", 50_000, 60_000, { transitionIn: { kind: "crossfade", durationMs: 500 } })],
    overlays: [
      {
        id: "t1",
        name: "Titles",
        items: [
          { type: "text", id: "early", startMs: 1_000, endMs: 3_000, text: "Go" },
          { type: "text", id: "inside", startMs: 6_000, endMs: 8_000, text: "gone with the cut" },
          { type: "text", id: "late", startMs: 15_000, endMs: 18_000, text: "Later", keys: [{ atMs: 16_000, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }] },
        ],
      },
    ],
    audioTracks: [{ id: "sfx", name: "Sounds", kind: "sfx", clips: [{ id: "boom", source: { kind: "library", assetId: "sfx/boom" }, startMs: 15_000, durationMs: 1_000 }] }],
    effects: [{ id: "fx1", kind: "passed", startMs: 16_000, endMs: 18_000, text: "MISSION PASSED" }],
    captionTrack: { cues: [{ id: "c1", startMs: 15_500, endMs: 17_000, text: "nice", words: [{ startMs: 15_500, endMs: 16_000, text: "nice" }] }] },
    coverMs: 16_000,
  });

  it("removes the range, splits the part and moves everything placed after it", () => {
    const r = cutRangesFromEdl(base, [{ segmentId: "a", startMs: 5_000, endMs: 10_000 }]);
    expect(r.error).toBeNull();
    const e = r.edl!;
    expect(r.removedMs).toBe(5_000);
    expect(edlDurationMs(e)).toBe(edlDurationMs(base) - 5_000);
    expect(e.segments.map((s) => [s.id, s.inMs, s.outMs])).toEqual([
      ["a", 0, 5_000],
      ["a-2", 10_000, 20_000],
      ["b", 50_000, 60_000],
    ]);
    expect(e.segments[1]!.transitionIn.kind).toBe("cut");
    expect(e.segments[2]!.transitionIn).toEqual({ kind: "crossfade", durationMs: 500 });
    const items = e.overlays[0]!.items;
    expect(items.map((it) => it.id)).toEqual(["early", "late"]);
    expect(items[1]).toMatchObject({ startMs: 10_000, endMs: 13_000 });
    expect(items[1]!.keys[0]!.atMs).toBe(11_000);
    expect(e.audioTracks[0]!.clips[0]!.startMs).toBe(10_000);
    expect(e.effects[0]).toMatchObject({ startMs: 11_000, endMs: 13_000 });
    expect(e.captionTrack.cues[0]).toMatchObject({ startMs: 10_500, endMs: 12_000 });
    expect(e.captionTrack.cues[0]!.words[0]).toMatchObject({ startMs: 10_500, endMs: 11_000 });
    expect(e.coverMs).toBe(11_000);
  });

  it("keeps speed ramps continuous across the cut and drops slivers under 0.3 s", () => {
    const ramp = edlOf({ segments: [seg("a", 0, 10_000, { speed: 1, rampTo: 3 })] });
    const r = cutRangesFromEdl(ramp, [{ segmentId: "a", startMs: 4_000, endMs: 9_800 }]);
    expect(r.edl!.segments).toHaveLength(1); // the 0.2 s tail went with the cut
    expect(r.edl!.segments[0]).toMatchObject({ inMs: 0, outMs: 4_000, speed: 1, rampTo: 1.8 });
  });

  it("refuses to cut everything", () => {
    const r = cutRangesFromEdl(edlOf({ segments: [seg("a", 0, 5_000)] }), [{ segmentId: "a", startMs: 0, endMs: 5_000 }]);
    expect(r).toMatchObject({ edl: null, error: "That would cut the whole edit" });
  });
});

describe("what an AI proposal may contain", () => {
  const before = edlOf({ segments: [seg("a", 0, 10_000)], audioTracks: [{ id: "up", name: "Voice", kind: "voice", clips: [{ id: "v1", source: { kind: "upload", assetId: "6f1d6f3e-8a7b-4c39-9d63-000000000001" }, startMs: 0, durationMs: 2_000 }] }] });

  it("strips library items that don't exist and uploads the edit didn't already use", () => {
    const proposal = edlOf({
      segments: [seg("a", 0, 10_000)],
      overlays: [{ id: "o", name: "Stickers", items: [{ type: "image", id: "s1", startMs: 0, endMs: 1_000, source: { kind: "library", assetId: "stickers/made-up" } }] }],
      audioTracks: [
        {
          id: "up",
          name: "Voice",
          kind: "voice",
          clips: [
            { id: "v1", source: { kind: "upload", assetId: "6f1d6f3e-8a7b-4c39-9d63-000000000001" }, startMs: 0, durationMs: 2_000 },
            { id: "v2", source: { kind: "upload", assetId: "6f1d6f3e-8a7b-4c39-9d63-000000000002" }, startMs: 3_000, durationMs: 2_000 },
            { id: "s2", source: { kind: "library", assetId: "sfx/whoosh-1" }, startMs: 4_000, durationMs: 500 },
          ],
        },
      ],
    });
    const { edl, removed } = stripUnknownAssets(proposal, new Set(["sfx/whoosh-1"]), new Set(["6f1d6f3e-8a7b-4c39-9d63-000000000001"]));
    expect(edlLibraryRefs(edl).map((r) => r.assetId)).toEqual(["sfx/whoosh-1"]);
    expect(edl.audioTracks[0]!.clips.map((c) => c.id)).toEqual(["v1", "s2"]);
    expect(removed).toEqual(["library item “stickers/made-up”", "an uploaded file the edit didn't use"]);
    expect(before.audioTracks[0]!.clips).toHaveLength(1);
  });

  it("describes every change in plain words, with library names", () => {
    const after = edlOf({
      aspect: "16:9",
      segments: [seg("a", 0, 8_000, { speed: 2 }), seg("n", 20_000, 25_000, { transitionIn: { kind: "whip", durationMs: 250 } })],
      audioTracks: [{ id: "ai", name: "AI sounds", kind: "sfx", clips: [{ id: "x", source: { kind: "library", assetId: "sfx/whoosh-1" }, startMs: 4_000, durationMs: 500 }] }],
      effects: [{ id: "f", kind: "wasted", startMs: 6_000, endMs: 8_000, text: "WASTED" }],
      grade: { preset: "vice-night" },
      fadeOutMs: 400,
    });
    const lines = describeEdlChanges(before, after, (id) => (id === "sfx/whoosh-1" ? "Whoosh 1" : null));
    expect(lines).toEqual(
      expect.arrayContaining([
        "Length 0:10.0 → 0:08.8",
        "Format vertical → widescreen (1920×1080)",
        "Part 1 now 0:00.0–0:08.0 (was 0:00.0–0:10.0)",
        "Part 1 plays at 2×",
        "Adds part 2: 0:20.0–0:25.0",
        "Adds the audio track “AI sounds”",
        "Adds sound “Whoosh 1” at 0:04.0",
        "Removes an uploaded sound",
        "Removes the audio track “Voice”",
        "Adds WASTED at 0:06.0",
        "Colour look: vice night",
        "Fade out 0:00.0 → 0:00.4",
      ]),
    );
    expect(describeEdlChanges(before, before)).toEqual([]);
  });

  it("asks providers for a strict schema without defaults, oneOf or const", () => {
    const s = JSON.stringify(providerSchema(ModelEditProposal));
    expect(s).not.toMatch(/"default":|"oneOf":|"const":/);
    const posts = providerSchema(ModelPosts) as { additionalProperties?: boolean; required?: string[] };
    expect(posts.additionalProperties).toBe(false);
    expect(posts.required).toEqual(["posts"]);
  });

  it("keeps the edit request estimate close to what's actually sent", () => {
    const schemaChars = JSON.stringify(providerSchema(ModelEditProposal)).length;
    // Instructions are about 1,900 characters on top of the schema.
    expect(EDIT_REQUEST_BASE_CHARS).toBeGreaterThan(schemaChars + 1_000);
    expect(EDIT_REQUEST_BASE_CHARS).toBeLessThan(schemaChars + 6_000);
    const e = estimateEditTokens(before, "make it faster", 120);
    expect(e.inputTokens).toBeGreaterThan(5_000);
    expect(e.outputTokens).toBeLessThanOrEqual(6_000);
    expect(tokenCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, { input: 3, output: 15 })).toBe(3);
  });
});

describe("posts and sounds", () => {
  it("cleans posts to each platform's limits", () => {
    const x = tidyPost({ platform: "x", title: "t", caption: "a ".repeat(400), hashtags: ["GTA V", "#slot1", "#gta5", "#extra"] });
    expect(x.hashtags).toEqual(["#GTAV", "#slot1"]);
    expect(`${x.caption}\n\n${x.hashtags.join(" ")}`.length).toBeLessThanOrEqual(280);
    expect(x.caption.endsWith("…")).toBe(true);
    const ig = tidyPost({ platform: "instagram", title: "Hook", caption: "Docks run", hashtags: Array.from({ length: 12 }, (_, i) => `tag${i}`) });
    expect(ig.hashtags).toHaveLength(8);
    expect(tidyPost({ platform: "youtube", title: "x".repeat(150), caption: "ok", hashtags: ["bad tag!"] })).toMatchObject({ title: expect.stringMatching(/^x{99}…$/), hashtags: [] });
  });

  it("puts sound cues on cuts, result screens and titles, spaced apart", () => {
    const edl = edlOf({
      segments: [seg("a", 0, 10_000), seg("b", 20_000, 30_000)],
      overlays: [{ id: "t", name: "Titles", items: [{ type: "text", id: "t1", startMs: 0, endMs: 2_000, text: "Docks" }] }],
    });
    const passed = obs({ type: "result_screen", mediaStartMs: 25_000, rawText: "MISSION PASSED", description: "MISSION PASSED" });
    const moments = momentsInEdl(edl, new Map([[SESSION, { observations: [passed], rmsDb: null }]]));
    expect(moments.map((m) => m.outMs)).toEqual([15_000]);
    const cues = soundCues(edl, moments);
    expect(cues.map((c) => [c.atMs, c.reason])).toEqual([
      [0, "Title “Docks”"],
      [9_850, "Cut into part 2"],
      [15_000, "MISSION PASSED on screen"],
    ]);
    expect(cues[2]!.want).toContain("success");
  });
});
