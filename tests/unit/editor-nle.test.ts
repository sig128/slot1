import { describe, expect, it } from "vitest";
import { buildEdlRender } from "@slot1/analysis";
import {
  addMarker,
  addSequence,
  addTrack,
  closeGaps,
  copyRefs,
  deleteRefs,
  docEdl,
  docSequences,
  duplicateRefs,
  Edl,
  EDL_LIMITS,
  EDL_MAX_MS,
  edlDurationMs,
  extractRange,
  insertSourceClip,
  isTrackLocked,
  liftRange,
  listTracks,
  MAIN_SEQUENCE_ID,
  moveSequence,
  moveTrack,
  NO_EXTRA_SEQUENCES,
  nudgeRefs,
  pasteClipboard,
  ProjectPatch,
  ProjectSequences,
  razorAll,
  readSequences,
  refSpan,
  refsInRange,
  removeMarker,
  removeSequence,
  removeTrack,
  renameSequence,
  renameTrack,
  RenderOptions,
  rippleTrimRef,
  segmentStartsMs,
  sequenceEdl,
  sequenceName,
  setDocEdl,
  slideSegment,
  slipSegment,
  StoredRenderOptions,
  ThumbnailInput,
  toggleTrack,
  trackRefs,
  updateMarker,
  type EdlInput,
  type ProjectDoc,
} from "@slot1/contracts";

const S = "6f1d6f3e-8a7b-4c39-9d63-1b2a3c4d5e6f";
const S2 = "0b9c1a2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const seg = (id: string, inMs: number, outMs: number, extra: Record<string, unknown> = {}) => ({ id, sessionId: S, inMs, outMs, ...extra });
const edlOf = (over: Partial<EdlInput> = {}): Edl => Edl.parse({ version: 1, aspect: "9:16", segments: [seg("a", 1000, 6000), seg("b", 20_000, 24_000)], ...over });
const text = (id: string, startMs: number, endMs: number) => ({ type: "text" as const, id, startMs, endMs, text: id.toUpperCase() });
const valid = (e: Edl) => Edl.safeParse(e).success;

describe("older edits still parse and render the same", () => {
  it("fills the new fields with values that mean 'not used'", () => {
    const old = Edl.parse({ version: 1, aspect: "16:9", segments: [seg("a", 0, 4000)], overlays: [{ id: "o", items: [text("t", 0, 1000)] }], effects: [{ id: "f", kind: "flash", startMs: 0, endMs: 300 }] });
    expect(old.markers).toEqual([]);
    expect(old.overlays[0]!.kind).toBeUndefined();
    expect(old.effects[0]!.enabled).toBeUndefined();
    expect(listTracks(old).find((t) => t.key === "ov:o")!.label).toBe("V2");
  });

  it("raised the limits, and still enforces them", () => {
    expect(EDL_MAX_MS).toBe(30 * 60_000);
    const many = Array.from({ length: EDL_LIMITS.segments }, (_, i) => seg(`s${i}`, i * 2000, i * 2000 + 1000));
    expect(Edl.safeParse({ version: 1, aspect: "9:16", segments: many }).success).toBe(true);
    expect(Edl.safeParse({ version: 1, aspect: "9:16", segments: [...many, seg("x", 0, 1000)] }).success).toBe(false);
    expect(Edl.safeParse({ version: 1, aspect: "9:16", segments: [seg("a", 0, 20 * 60_000)] }).success).toBe(true);
    const long = Edl.safeParse({ version: 1, aspect: "9:16", segments: [seg("a", 0, 25 * 60_000), seg("b", 0, 10 * 60_000)] });
    expect(long.success).toBe(false);
    if (!long.success) expect(long.error.issues[0]!.message).toBe("An edit can be at most 30 minutes long");
  });

  it("leaves turned-off effects out of the render", () => {
    const on = edlOf({ effects: [{ id: "f", kind: "shake", startMs: 500, endMs: 1500, amount: 0.5 }] });
    const off = edlOf({ effects: [{ id: "f", kind: "shake", startMs: 500, endMs: 1500, amount: 0.5, enabled: false }] });
    const media = [{ path: "/media/rec.mp4", offsetMs: 0, width: 1920, height: 1080, hasAudio: true }, { path: "/media/rec.mp4", offsetMs: 0, width: 1920, height: 1080, hasAudio: true }];
    const args = (e: Edl) => buildEdlRender({ edl: e, media, output: "/tmp/o.mp4", workDir: "/tmp", fonts: { poster: null, caption: null } }).args.join(" ");
    expect(args(on)).toMatch(/crop=/);
    expect(args(off)).toBe(args(edlOf()));
  });
});

describe("tracks", () => {
  it("lists tracks top to bottom with editor labels", () => {
    let e = edlOf();
    e = addTrack(e, "video")!.edl;
    e = addTrack(e, "text")!.edl;
    e = addTrack(e, "audio", "music")!.edl;
    const t = listTracks(e);
    expect(t.map((x) => x.label)).toEqual(["CC", "T1", "V2", "FX", "V1", "A1", "A2"]);
    expect(t.find((x) => x.label === "A2")!.name).toBe("Music 1");
    expect(valid(e)).toBe(true);
  });

  it("adds, renames, reorders, switches and removes tracks", () => {
    const a = addTrack(edlOf(), "video")!;
    const b = addTrack(a.edl, "video")!;
    let e = renameTrack(b.edl, a.key, "Facecam");
    expect(e.overlays[0]!.name).toBe("Facecam");
    // Up as drawn means later in the overlay list (drawn on top).
    e = moveTrack(e, a.key, -1);
    expect(e.overlays.at(-1)!.name).toBe("Facecam");
    e = toggleTrack(e, a.key, "locked");
    expect(isTrackLocked(e, a.key)).toBe(true);
    e = toggleTrack(e, "a1", "muted");
    expect(e.sourceAudio.muted).toBe(true);
    e = toggleTrack(e, "v1", "locked");
    expect(e.mainTrack.locked).toBe(true);
    expect(isTrackLocked(e, "a1")).toBe(true);
    e = removeTrack(e, a.key);
    expect(e.overlays.map((o) => o.name)).toEqual(["Video 2"]);
    expect(removeTrack(e, "v1")).toBe(e);
  });

  it("stops at the track limits", () => {
    let e = edlOf();
    for (let i = 0; i < EDL_LIMITS.overlayTracks; i++) e = addTrack(e, i % 2 ? "text" : "video")!.edl;
    expect(addTrack(e, "video")).toBeNull();
    expect(valid(e)).toBe(true);
  });
});

describe("razor, lift and extract", () => {
  const withItems = () =>
    edlOf({
      overlays: [{ id: "o", items: [text("t", 1000, 7000)] }],
      audioTracks: [{ id: "m", clips: [{ id: "c", source: { kind: "library", assetId: "music-night-drive" }, startMs: 0, durationMs: 8000 }] }],
    });

  it("cuts every unlocked track at one time", () => {
    const r = razorAll(withItems(), 3000);
    expect(r.cuts).toBe(3);
    expect(r.edl.segments).toHaveLength(3);
    expect(r.edl.overlays[0]!.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [1000, 3000],
      [3000, 7000],
    ]);
    expect(r.edl.audioTracks[0]!.clips.map((c) => c.durationMs)).toEqual([3000, 5000]);
    expect(valid(r.edl)).toBe(true);
    const locked = razorAll(toggleTrack(withItems(), "ov:o", "locked"), 3000);
    expect(locked.cuts).toBe(2);
  });

  it("lifts a range off the free tracks and leaves V1 alone", () => {
    const e = liftRange(withItems(), 2000, 4000);
    expect(e.segments).toEqual(withItems().segments);
    expect(e.overlays[0]!.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [1000, 2000],
      [4000, 7000],
    ]);
    expect(e.audioTracks[0]!.clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [0, 2000],
      [4000, 4000],
    ]);
    expect(valid(e)).toBe(true);
  });

  it("extracts a range from everything and closes the gap", () => {
    const before = withItems();
    const e = extractRange(before, 2000, 4000)!;
    expect(edlDurationMs(e)).toBe(edlDurationMs(before) - 2000);
    expect(e.segments.map((s) => [s.inMs, s.outMs])).toEqual([
      [1000, 3000],
      [5000, 6000],
      [20_000, 24_000],
    ]);
    // The text over the range shrinks by the extracted time.
    expect(e.overlays[0]!.items[0]!.endMs).toBe(5000);
    expect(valid(e)).toBe(true);
    expect(extractRange(toggleTrack(before, "v1", "locked"), 2000, 4000)).toBeNull();
    expect(extractRange(before, 0, edlDurationMs(before))).toBeNull();
  });
});

describe("gaps, ripple, slip and slide", () => {
  it("closes the gaps on a free track", () => {
    const e = closeGaps(edlOf({ overlays: [{ id: "o", items: [text("a", 1000, 2000), text("b", 4000, 5000)] }] }), "ov:o");
    expect(e.overlays[0]!.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [0, 1000],
      [1000, 2000],
    ]);
  });

  it("ripple-trims: later items on the track move by the trimmed time", () => {
    const e0 = edlOf({ overlays: [{ id: "o", items: [text("a", 1000, 3000), text("b", 4000, 5000)] }] });
    const e = rippleTrimRef(e0, { kind: "overlay", trackId: "o", id: "a" }, "end", 2500);
    expect(e.overlays[0]!.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [1000, 2500],
      [3500, 4500],
    ]);
    const h = rippleTrimRef(e0, { kind: "overlay", trackId: "o", id: "a" }, "start", 1500);
    expect(h.overlays[0]!.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [1000, 2500],
      [3500, 4500],
    ]);
  });

  it("slips a clip's source without moving it", () => {
    const e = slipSegment(edlOf(), "b", 1000, 60_000);
    expect(e.segments[1]).toMatchObject({ inMs: 21_000, outMs: 25_000 });
    expect(edlDurationMs(e)).toBe(edlDurationMs(edlOf()));
    expect(slipSegment(edlOf(), "a", -5000).segments[0]).toMatchObject({ inMs: 0, outMs: 5000 });
  });

  it("slides a clip between its neighbours", () => {
    const e0 = edlOf({ segments: [seg("a", 0, 4000), seg("b", 10_000, 12_000), seg("c", 20_000, 24_000)] });
    const e = slideSegment(e0, "b", 1000);
    expect(e.segments.map((s) => [s.inMs, s.outMs])).toEqual([
      [0, 5000],
      [10_000, 12_000],
      [21_000, 24_000],
    ]);
    expect(segmentStartsMs(e)[1]).toBe(5000);
    expect(edlDurationMs(e)).toBe(edlDurationMs(e0));
    expect(slideSegment(e0, "a", 500)).toBe(e0);
  });
});

describe("copy, paste, duplicate, nudge and select", () => {
  it("pastes free items at the playhead on the same track", () => {
    const e0 = edlOf({ overlays: [{ id: "o", items: [text("a", 1000, 2000)] }] });
    const clip = copyRefs(e0, [{ kind: "overlay", trackId: "o", id: "a" }])!;
    const r = pasteClipboard(e0, clip, 5000)!;
    expect(r.edl.overlays[0]!.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [1000, 2000],
      [5000, 6000],
    ]);
    expect(r.refs).toHaveLength(1);
    expect(valid(r.edl)).toBe(true);
  });

  it("inserts pasted V1 clips at the edit point under the time", () => {
    const e0 = edlOf();
    const clip = copyRefs(e0, [{ kind: "segment", id: "b" }])!;
    const r = pasteClipboard(e0, clip, 2000)!;
    expect(r.edl.segments.map((s) => [s.inMs, s.outMs])).toEqual([
      [1000, 3000],
      [20_000, 24_000],
      [3000, 6000],
      [20_000, 24_000],
    ]);
    expect(valid(r.edl)).toBe(true);
  });

  it("duplicates right after the selection and nudges free items", () => {
    const e0 = edlOf({ overlays: [{ id: "o", items: [text("a", 1000, 2000)] }] });
    const d = duplicateRefs(e0, [{ kind: "overlay", trackId: "o", id: "a" }])!;
    expect(d.edl.overlays[0]!.items.map((i) => i.startMs)).toEqual([1000, 2000]);
    const n = nudgeRefs(e0, [{ kind: "overlay", trackId: "o", id: "a" }, { kind: "segment", id: "a" }], 100);
    expect(n.overlays[0]!.items[0]!.startMs).toBe(1100);
    expect(n.segments).toEqual(e0.segments);
  });

  it("selects across tracks with a time range", () => {
    const e0 = edlOf({ overlays: [{ id: "o", items: [text("a", 1000, 2000), text("b", 6000, 7000)] }] });
    const refs = refsInRange(e0, 1500, 4500, ["ov:o", "v1"]);
    expect(refs).toEqual([
      { kind: "overlay", trackId: "o", id: "a" },
      { kind: "segment", id: "a" },
    ]);
    expect(trackRefs(e0, "ov:o")).toHaveLength(2);
  });
});

describe("source clips and markers", () => {
  it("inserts a part of another video on V1, or full frame on a video track", () => {
    const r = insertSourceClip(edlOf(), { sessionId: S2, inMs: 5000, outMs: 8000 }, 5000)!;
    expect(r.edl.segments.map((s) => s.sessionId)).toEqual([S, S2, S]);
    expect(edlDurationMs(r.edl)).toBe(edlDurationMs(edlOf()) + 3000);
    expect(valid(r.edl)).toBe(true);
    const t = addTrack(edlOf(), "video")!;
    const o = insertSourceClip(t.edl, { sessionId: S2, inMs: 0, outMs: 2000 }, 1000, t.key)!;
    expect(o.edl.overlays[0]!.items[0]).toMatchObject({ type: "pip", sessionId: S2, startMs: 1000, endMs: 3000, widthPct: 1, border: false });
    expect(valid(o.edl)).toBe(true);
    expect(insertSourceClip(toggleTrack(edlOf(), "v1", "locked"), { sessionId: S2, inMs: 0, outMs: 2000 }, 0)).toBeNull();
  });

  it("keeps markers through edits and never renders them", () => {
    const m = addMarker(edlOf(), 7000, "drop here")!;
    expect(addMarker(m.edl, 7005)).toBeNull();
    let e = updateMarker(m.edl, m.id, { color: "gold", label: "the drop" });
    expect(e.markers[0]).toMatchObject({ atMs: 7000, color: "gold", label: "the drop" });
    // Deleting the first clip moves the marker with the footage after it.
    e = deleteRefs(e, [{ kind: "segment", id: "a" }]);
    expect(e.markers[0]!.atMs).toBe(2000);
    expect(valid(e)).toBe(true);
    expect(removeMarker(e, m.id).markers).toEqual([]);
    expect(refSpan(e, { kind: "segment", id: "b" })).toEqual({ startMs: 0, endMs: 4000 });
  });
});

describe("sequences", () => {
  const doc = (): ProjectDoc => ({ main: edlOf(), sequences: NO_EXTRA_SEQUENCES });

  it("adds a widescreen version, renames, reorders and deletes timelines", () => {
    const a = addSequence(doc(), MAIN_SEQUENCE_ID, { aspect: "16:9" })!;
    expect(a.doc.sequences.extra[0]).toMatchObject({ name: "Main 16:9" });
    expect(docEdl(a.doc, a.id).aspect).toBe("16:9");
    expect(docEdl(a.doc, a.id).segments).toEqual(edlOf().segments);
    const b = addSequence(a.doc, a.id)!;
    expect(b.doc.sequences.extra[1]!.name).toBe("Main 16:9 copy");
    let d = renameSequence(b.doc, MAIN_SEQUENCE_ID, "Vertical");
    expect(docSequences(d).map((s) => s.name)).toEqual(["Vertical", "Main 16:9", "Main 16:9 copy"]);
    d = moveSequence(d, b.id, -1);
    expect(docSequences(d).map((s) => s.id)).toEqual([MAIN_SEQUENCE_ID, b.id, a.id]);
    d = setDocEdl(d, a.id, { ...docEdl(d, a.id), volume: 0.5 });
    expect(docEdl(d, a.id).volume).toBe(0.5);
    expect(d.main.volume).toBe(1);
    expect(removeSequence(d, MAIN_SEQUENCE_ID)).toBe(d);
    expect(docSequences(removeSequence(d, a.id))).toHaveLength(2);
    expect(ProjectSequences.safeParse(d.sequences).success).toBe(true);
  });

  it("a split layout becomes crop in a widescreen copy, and there are at most 8 timelines", () => {
    const split: ProjectDoc = { main: edlOf({ layout: "split" }), sequences: NO_EXTRA_SEQUENCES };
    const a = addSequence(split, MAIN_SEQUENCE_ID, { aspect: "16:9" })!;
    expect(docEdl(a.doc, a.id).layout).toBe("crop");
    let d: ProjectDoc = split;
    for (let i = 0; i < 7; i++) d = addSequence(d, MAIN_SEQUENCE_ID)!.doc;
    expect(addSequence(d, MAIN_SEQUENCE_ID)).toBeNull();
  });

  it("validates stored sequences and reads older rows", () => {
    expect(readSequences({})).toEqual({ mainName: "Main", extra: [] });
    expect(readSequences(null)).toEqual({ mainName: "Main", extra: [] });
    const good = { id: "q1", name: "Wide", edl: edlOf({ aspect: "16:9" }) };
    const r = readSequences({ mainName: "Tall", extra: [good, { id: "q2", name: "Broken", edl: { version: 1 } }, good] });
    expect(r.mainName).toBe("Tall");
    expect(r.extra.map((s) => s.id)).toEqual(["q1"]);
    expect(ProjectSequences.safeParse({ extra: [{ ...good, id: "main" }] }).success).toBe(false);
    expect(ProjectSequences.safeParse({ extra: [good, good] }).success).toBe(false);
    expect(sequenceEdl(edlOf(), r, "q1")!.aspect).toBe("16:9");
    expect(sequenceEdl(edlOf(), r, undefined)).toEqual(edlOf());
    expect(sequenceEdl(edlOf(), r, "nope")).toBeNull();
    expect(sequenceName(r, "main")).toBe("Tall");
    expect(ProjectPatch.safeParse({ sequences: { extra: [good] } }).success).toBe(true);
  });

  it("render and thumbnail options name the timeline; stored options stay compatible", () => {
    expect(RenderOptions.parse({})).toEqual({ presets: ["original"], format: "mp4", height: 1080, fps: 30, quality: "high" });
    expect(RenderOptions.parse({ sequences: ["main", "q1"] }).sequences).toEqual(["main", "q1"]);
    expect(RenderOptions.safeParse({ sequences: [] }).success).toBe(false);
    expect(StoredRenderOptions.parse({ format: "mp4", height: 720, fps: 30, quality: "high" })).toEqual({ format: "mp4", height: 720, fps: 30, quality: "high" });
    expect(StoredRenderOptions.parse({ sequenceId: "q1" }).sequenceId).toBe("q1");
    expect(ThumbnailInput.parse({ atMs: 0, text: "GO", sequenceId: "q1" }).sequenceId).toBe("q1");
  });
});
