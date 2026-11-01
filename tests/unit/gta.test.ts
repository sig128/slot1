import { describe, expect, it } from "vitest";
import { GtaPredictionGate, legibleLines, parseTesseractTsv, weakLabelsFromMeasurements, weakLabelsFromOcr, type FramePrediction } from "@slot1/analysis";
import {
  decideActivation,
  GTA_BOX_OBSERVATION,
  GTA_BOXES,
  GTA_EVENT_OBSERVATION,
  GTA_EVENTS,
  GTA_SCENES,
  GTA_TEMPORAL_EVENTS,
  splitForSession,
  SubmitLabelsInput,
  type ModelEvaluation,
} from "@slot1/contracts";
import { jpegSize } from "@slot1/services";

describe("GTA taxonomy", () => {
  it("has unique classes and a publishing rule for every event and box", () => {
    for (const list of [GTA_SCENES, GTA_EVENTS, GTA_BOXES]) expect(new Set(list).size).toBe(list.length);
    expect(GTA_SCENES).toHaveLength(8); // keys 1–8 in the labeling tool
    expect(Object.keys(GTA_EVENT_OBSERVATION).sort()).toEqual([...GTA_EVENTS].sort());
    expect(Object.keys(GTA_BOX_OBSERVATION).sort()).toEqual([...GTA_BOXES].sort());
    for (const e of GTA_TEMPORAL_EVENTS) expect(GTA_EVENT_OBSERVATION[e].interpretation).toBe("inferred");
  });

  it("validates submitted labels", () => {
    expect(SubmitLabelsInput.safeParse({ scene: "driving", events: ["police_chase"], boxes: [{ class: "minimap", x: 0.02, y: 0.7, w: 0.2, h: 0.25 }] }).success).toBe(true);
    expect(SubmitLabelsInput.safeParse({ events: [] }).success).toBe(false); // a scene or skip is required
    expect(SubmitLabelsInput.safeParse({ skip: true }).success).toBe(true);
    expect(SubmitLabelsInput.safeParse({ scene: "driving", boxes: [{ class: "minimap", x: 0.9, y: 0.9, w: 0.3, h: 0.3 }] }).success).toBe(false); // outside the frame
    expect(SubmitLabelsInput.safeParse({ scene: "flying_saucer" }).success).toBe(false);
  });
});

describe("weak labels from on-screen text", () => {
  const line = (text: string, type = "visible_text", bbox?: [number, number, number, number]) =>
    ({ text, confidence: 90, regionId: "r", type, ...(bbox ? { bbox } : {}) }) as Parameters<typeof weakLabelsFromOcr>[0][number];

  it("maps result screens, money, subtitles and chase objectives to proposals", () => {
    const labels = weakLabelsFromOcr([
      line("MISSION PASSED", "result_screen", [0.3, 0.4, 0.4, 0.08]),
      line("$12,450", "hud_reading", [0.82, 0.05, 0.12, 0.04]),
      line("Lamar: You drive like my grandma", "subtitle", [0.2, 0.85, 0.6, 0.05]),
      line("Lose the cops.", "objective_text"),
      line("WASTED", "result_screen"),
    ]);
    const summary = labels.map((l) => `${l.kind}:${l.class}`);
    expect(summary).toEqual(["event:mission_passed", "box:big_message", "box:money_hud", "box:subtitle", "event:police_chase", "event:wasted"]);
    for (const l of labels) {
      expect(l.source).toBe("auto_ocr");
      expect(l.confidence).toBeGreaterThan(0);
      if (l.box) {
        expect(l.box.x).toBeGreaterThanOrEqual(0);
        expect(l.box.x + l.box.w).toBeLessThanOrEqual(1);
        expect(l.box.y + l.box.h).toBeLessThanOrEqual(1);
      }
    }
    // Padding makes the box a little larger than the glyphs.
    const big = labels.find((l) => l.class === "big_message")!;
    expect(big.box!.w).toBeGreaterThan(0.4);
  });

  it("never invents boxes without positions, and labels measured black frames", () => {
    expect(weakLabelsFromOcr([line("$12,450")])).toEqual([]);
    expect(weakLabelsFromMeasurements({ black: true })).toMatchObject([{ kind: "scene", class: "loading_or_black", source: "auto_measure" }]);
    expect(weakLabelsFromMeasurements({ black: false })).toEqual([]);
  });

  it("keeps OCR word positions as a line box", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "1\t1\t0\t0\t0\t0\t0\t0\t1000\t200\t-1\t",
      "5\t1\t1\t1\t1\t1\t100\t50\t200\t40\t93\tMISSION",
      "5\t1\t1\t1\t1\t2\t320\t52\t180\t38\t91\tPASSED",
    ].join("\n");
    const [l] = legibleLines(parseTesseractTsv(tsv), 60);
    expect(l!.text).toBe("MISSION PASSED");
    expect(l!.box![0]).toBeCloseTo(0.1);
    expect(l!.box![1]).toBeCloseTo(0.25);
    expect(l!.box![2]).toBeCloseTo(0.4);
    expect(l!.box![3]).toBeCloseTo(0.2);
  });
});

describe("dataset splits", () => {
  it("assigns whole sessions, deterministically, in roughly 75/10/15 proportions", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const counts = { train: 0, val: 0, test: 0 };
    for (const id of ids) {
      const s = splitForSession("seed", id);
      expect(splitForSession("seed", id)).toBe(s);
      counts[s] += 1;
    }
    expect(counts.test / ids.length).toBeGreaterThan(0.11);
    expect(counts.test / ids.length).toBeLessThan(0.19);
    expect(counts.val / ids.length).toBeGreaterThan(0.07);
    expect(counts.val / ids.length).toBeLessThan(0.13);
  });
});

describe("model activation rule", () => {
  const ev = (hash: string, value: number, testFrames = 50): ModelEvaluation => ({
    datasetVersionId: "d",
    testSplitHash: hash.repeat(64).slice(0, 64),
    primaryMetric: "macro_f1",
    value,
    testFrames,
    evaluatedAt: "2026-11-01T00:00:00Z",
  });

  it("allows the first model with a real test evaluation", () => {
    expect(decideActivation([ev("a", 0.4)], null).allowed).toBe(true);
    expect(decideActivation([ev("a", 0.9, 0)], null).allowed).toBe(false);
    expect(decideActivation([], null).allowed).toBe(false);
  });

  it("compares only on the same test split and never accepts a worse model", () => {
    expect(decideActivation([ev("b", 0.95)], [ev("a", 0.5)])).toMatchObject({ allowed: false, comparedOn: null });
    expect(decideActivation([ev("a", 0.49)], [ev("a", 0.5)]).allowed).toBe(false);
    expect(decideActivation([ev("a", 0.5)], [ev("a", 0.5)]).allowed).toBe(true);
    expect(decideActivation([ev("b", 0.1), ev("a", 0.7)], [ev("a", 0.6)])).toMatchObject({ allowed: true, candidateValue: 0.7, activeValue: 0.6 });
  });
});

describe("publishing model predictions", () => {
  const ref = (pts: number) => ({ ptsMs: pts, assetId: `f${pts}`, receivedAt: new Date(1_000_000 + pts), capturedAt: null });
  const pred = (over: Partial<FramePrediction>): FramePrediction => ({ scene: null, events: [], boxes: [], provider: "slot1-gta", version: "gta-scene@1", ...over });

  it("publishes only confident scenes, never 'other'", () => {
    const g = new GtaPredictionGate({ scene: 0.6, event: 0.6, box: 0.5 });
    expect(g.candidates(pred({ scene: { class: "driving", score: 0.9, modelId: "m" } }), ref(0), "now")).toMatchObject([
      { type: "environment", description: "Scene: Driving", origin: "video", interpretation: "directly_visible", modelConfidence: 0.9, model: { provider: "slot1-gta" } },
    ]);
    expect(g.candidates(pred({ scene: { class: "driving", score: 0.55, modelId: "m" } }), ref(5000), "now")).toEqual([]);
    expect(g.candidates(pred({ scene: { class: "other", score: 0.99, modelId: "m" } }), ref(10000), "now")).toEqual([]);
  });

  it("needs two consecutive frames for events over time, and labels them inferred", () => {
    const g = new GtaPredictionGate({ scene: 0.6, event: 0.6, box: 0.5 });
    const chase = pred({ events: [{ class: "police_chase", score: 0.8, modelId: "m" }] });
    expect(g.candidates(chase, ref(0), "now")).toEqual([]);
    const second = g.candidates(chase, ref(5000), "now");
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: "movement", interpretation: "inferred", mediaStartMs: 0, mediaEndMs: 5000 });
    expect(second[0]!.evidence.map((e) => e.assetId)).toEqual(["f0", "f5000"]);
    // A visible result screen needs only its own frame.
    expect(g.candidates(pred({ events: [{ class: "wasted", score: 0.9, modelId: "m" }] }), ref(10000), "now")).toMatchObject([{ type: "result_screen", interpretation: "directly_visible" }]);
  });

  it("publishes viewer-relevant boxes only", () => {
    const g = new GtaPredictionGate({ scene: 0.6, event: 0.6, box: 0.5 });
    const out = g.candidates(
      pred({
        boxes: [
          { class: "wanted_stars", score: 0.8, box: { x: 0.8, y: 0.05, w: 0.15, h: 0.05 }, modelId: "d" },
          { class: "minimap", score: 0.99, box: { x: 0.02, y: 0.7, w: 0.2, h: 0.25 }, modelId: "d" },
          { class: "vehicle", score: 0.3, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, modelId: "d" },
        ],
      }),
      ref(0),
      "now",
    );
    expect(out.map((c) => c.description)).toEqual(["Wanted stars on screen"]);
  });
});

describe("JPEG header size", () => {
  it("reads width and height from the SOF marker", () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array.from("JFIF\0", (c) => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(jpegSize(Buffer.from([0xff, 0xd8, ...app0, ...sof]))).toEqual({ width: 1280, height: 720 });
    expect(jpegSize(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});
