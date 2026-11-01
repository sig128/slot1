import { describe, expect, it } from "vitest";
import { commentaryAllowed, deriveLiveState, enforceFindingRules, FusionWindow, HighlightScorer, legibleLines, parseTesseractTsv, staleAfterMs, type Candidate } from "@slot1/analysis";
import type { VisionFinding } from "@slot1/contracts";

const base = { expectedIntervalMs: 5000, measuredCadenceMs: null, measuredDelayMs: null };
const live = {
  ...base, now: 100_000, stoppedByCreator: false, pausedByCreator: false, publisherConnected: true,
  lastFrameAt: 98_000, lastAnalyzedAt: 97_000, error: null, visionConfigured: true, ocrAvailable: true,
};

describe("live analysis state", () => {
  it("derives staleness from the source cadence and delay, within bounds", () => {
    expect(staleAfterMs({ ...base })).toBe(15_000);
    expect(staleAfterMs({ expectedIntervalMs: 1000, measuredCadenceMs: null, measuredDelayMs: null })).toBe(10_000);
    expect(staleAfterMs({ expectedIntervalMs: 5000, measuredCadenceMs: 20_000, measuredDelayMs: 4000 })).toBe(64_000);
    expect(staleAfterMs({ expectedIntervalMs: 600_000, measuredCadenceMs: null, measuredDelayMs: null })).toBe(300_000);
  });

  it("is live_vision only while frames arrive and are analyzed", () => {
    expect(deriveLiveState(live).state).toBe("live_vision");
    expect(deriveLiveState({ ...live, lastFrameAt: null }).state).toBe("ready");
    expect(deriveLiveState({ ...live, now: 98_000 + 16_000 }).state).toBe("stale");
    expect(deriveLiveState({ ...live, lastAnalyzedAt: null }).state).toBe("delayed");
    expect(deriveLiveState({ ...live, visionConfigured: false, ocrAvailable: false }).state).toBe("delayed");
    expect(deriveLiveState({ ...live, pausedByCreator: true }).state).toBe("stopped");
    expect(deriveLiveState({ ...live, error: "decoder failed" })).toEqual({ state: "error", reason: "decoder failed" });
    expect(deriveLiveState({ ...live, visionConfigured: false }).reason).toMatch(/on-screen text only/);
  });

  it("allows commentary only when every condition holds", () => {
    const ok = { mode: "rare" as const, muted: false, botEnabled: true, killed: false, globalKill: false, analysisState: "live_vision" as const, lastCommentaryAt: null, now: 1e9 };
    expect(commentaryAllowed(ok).allowed).toBe(true);
    expect(commentaryAllowed({ ...ok, analysisState: "stale" }).allowed).toBe(false);
    expect(commentaryAllowed({ ...ok, muted: true }).allowed).toBe(false);
    expect(commentaryAllowed({ ...ok, mode: "off" }).allowed).toBe(false);
    expect(commentaryAllowed({ ...ok, globalKill: true }).allowed).toBe(false);
    expect(commentaryAllowed({ ...ok, lastCommentaryAt: 1e9 - 60_000 }).allowed).toBe(false);
  });
});

function cand(over: Partial<Candidate>): Candidate {
  return {
    type: "mission_title", description: "Mission title: Go to the docks", origin: "ocr", interpretation: "directly_visible",
    mediaStartMs: 0, mediaEndMs: 1000, evidence: [{ assetId: `f${over.mediaStartMs ?? 0}`, kind: "frame", mediaPtsMs: over.mediaStartMs ?? 0 }],
    rawText: "Go to the docks", model: null, modelConfidence: null, relatedEntities: [], receivedAt: new Date().toISOString(),
    analyzedAt: new Date().toISOString(), capturedAt: null, minReadings: 1, ...over,
  };
}

describe("fusion", () => {
  it("extends one observation for repeated readings of the same text", () => {
    const f = new FusionWindow(20_000);
    const first = f.push(cand({ mediaStartMs: 0, mediaEndMs: 1000 }));
    expect(first.kind).toBe("insert");
    f.markInserted(first.key, "obs-1");
    const again = f.push(cand({ mediaStartMs: 5000, mediaEndMs: 6000, rawText: "Go to the dock5" }));
    expect(again).toMatchObject({ kind: "extend", id: "obs-1", mediaEndMs: 6000 });
    if (again.kind === "extend") expect(again.evidence.map((e) => e.assetId)).toEqual(["f0", "f5000"]);
  });

  it("holds noisy single readings until a second frame confirms them", () => {
    const f = new FusionWindow(20_000);
    expect(f.push(cand({ minReadings: 2, mediaStartMs: 0 })).kind).toBe("hold");
    const confirmed = f.push(cand({ minReadings: 2, mediaStartMs: 5000, mediaEndMs: 6000 }));
    expect(confirmed.kind).toBe("insert");
    if (confirmed.kind === "insert") expect(confirmed.candidate).toMatchObject({ mediaStartMs: 0, mediaEndMs: 6000 });
  });

  it("never merges discrete events such as scene cuts", () => {
    const f = new FusionWindow(20_000);
    const a = f.push(cand({ type: "scene_transition", description: "Scene change", rawText: null, fusable: false, mediaStartMs: 12_000, mediaEndMs: 12_000 }));
    f.markInserted(a.key, "cut-1");
    const b = f.push(cand({ type: "scene_transition", description: "Scene change", rawText: null, fusable: false, mediaStartMs: 26_000, mediaEndMs: 26_000 }));
    expect(b.kind).toBe("insert");
  });

  it("suggests a highlight only when weighted evidence clusters, then cools down", () => {
    const h = new HighlightScorer(20_000, 4, 60_000);
    const ev = (type: "possible_collision" | "siren" | "combat", t: number) => ({ id: `${type}${t}`, type, mediaStartMs: t, evidence: [], description: type });
    expect(h.add(ev("siren", 0))).toBeNull();
    expect(h.add(ev("possible_collision", 5000))).toMatchObject({ score: 4 });
    expect(h.add(ev("combat", 10_000))).toBeNull();
    expect(h.add(ev("possible_collision", 15_000))).toBeNull();
  });
});

const finding = (over: Partial<VisionFinding>): VisionFinding => ({
  type: "vehicle", frameIndexes: [0], description: "A red sports car is visible!", interpretation: "directly_visible",
  visibleText: null, confidence: 0.7, entities: [], ...over,
});

describe("vision output rules", () => {
  it("drops findings that cite no real frame, and one-frame claims about motion", () => {
    const { kept, rejected } = enforceFindingRules(
      [
        finding({}),
        finding({ frameIndexes: [7] }),
        finding({ frameIndexes: [] }),
        finding({ type: "possible_collision", frameIndexes: [1] }),
        finding({ type: "possible_collision", frameIndexes: [0, 1], interpretation: "directly_visible" }),
        finding({ type: "mission_title", visibleText: null }),
        finding({ type: "mission_title", visibleText: "THE DOCKS" }),
      ],
      2,
    );
    expect(rejected).toBe(4);
    expect(kept.map((k) => k.type)).toEqual(["vehicle", "possible_collision", "mission_title"]);
    expect(kept[0]!.description).toBe("A red sports car is visible.");
    expect(kept[1]!.interpretation).toBe("inferred");
  });
});

describe("OCR line filtering", () => {
  it("keeps confident lines and strips edge punctuation", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t91\tMISSION",
      "5\t1\t1\t1\t1\t2\t70\t10\t50\t20\t89\tPASSED|",
      "5\t1\t2\t1\t1\t1\t10\t50\t50\t20\t21\tq~@",
    ].join("\n");
    const lines = legibleLines(parseTesseractTsv(tsv), 60);
    expect(lines.map((l) => l.text)).toEqual(["MISSION PASSED"]);
  });
});
