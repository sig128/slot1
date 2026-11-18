import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProfile, ObservationPipeline, type FrameInsight, type ObjectFinder, type PipelineSink } from "@slot1/analysis";
import type { DetectedObject } from "@slot1/contracts";
import { objectProposals } from "@slot1/services";

/**
 * The object finder is part of SLOT1's analysis: it runs on every analyzed frame, whether or not
 * anyone is watching, and its people and vehicles become training proposals. It never writes to
 * the log.
 */

const NAME = "YOLOX-Nano (COCO)";
const FOUND: DetectedObject[] = [
  { label: "person", score: 0.91, box: [0.6, 0.3, 0.1, 0.4] },
  { label: "car", score: 0.8, box: [0.1, 0.5, 0.3, 0.2] },
  { label: "truck", score: 0.6, box: [0.12, 0.5, 0.3, 0.2] }, // the same vehicle, read as a truck
  { label: "bus", score: 0.55, box: [0.9, 0.1, 0.2, 0.2] }, // runs off the right edge
  { label: "dog", score: 0.9, box: [0.2, 0.2, 0.1, 0.1] },
  { label: "person", score: 0.2, box: [0.3, 0.3, 0.1, 0.1] },
];

describe("object finder proposals", () => {
  it("proposes people and vehicles once each, inside the frame, and leaves animals and unsure finds out", () => {
    const p = objectProposals({ name: NAME, items: FOUND });
    expect(p.map((l) => `${l.source}:${l.kind}:${l.class}`)).toEqual(["model:box:person", "model:box:vehicle", "model:box:vehicle"]);
    expect(p.every((l) => l.status === undefined && l.modelId === undefined)).toBe(true);
    expect(p[0]).toMatchObject({ confidence: 0.91, evidenceText: `${NAME}: person`, box: { x: 0.6, y: 0.3, w: 0.1, h: 0.4 } });
    expect(p[1]!.evidenceText).toBe(`${NAME}: car`);
    const bus = p[2]!;
    expect(bus.evidenceText).toBe(`${NAME}: bus`);
    expect(bus.box!.x + bus.box!.w).toBeLessThanOrEqual(1);
    expect(bus.box!.w).toBeCloseTo(0.1, 6);
  });

  it("doesn't propose a box SLOT1's own GTA model already proposed", () => {
    const fromModel = { kind: "box" as const, class: "person", box: { x: 0.61, y: 0.3, w: 0.1, h: 0.4 }, source: "model" as const, confidence: 0.7, modelId: "m" };
    const p = objectProposals({ name: NAME, items: FOUND }, [fromModel]);
    expect(p.map((l) => l.class)).toEqual(["vehicle", "vehicle"]);
  });
});

describe("object finder in the analysis pipeline", () => {
  let work: string;
  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "slot1-objects-"));
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const run = async (finder: ObjectFinder) => {
    const logged: string[] = [];
    const problems: string[] = [];
    const training: unknown[] = [];
    const insights: FrameInsight[] = [];
    let n = 0;
    const sink: PipelineSink = {
      storeFrame: async () => ({ assetId: `frame-${++n}` }),
      persist: async (action) => {
        if (action.kind === "insert") logged.push(action.candidate.description);
        return `obs-${logged.length}`;
      },
      frameAnalyzed: async () => undefined,
      allowVisionCall: async () => ({ allowed: false, reason: "off" }),
      visionUsage: async () => undefined,
      problem: async (where, message) => void problems.push(`${where}: ${message}`),
      trainingFrame: async (input) => void training.push(input.objects),
    };
    const pipeline = new ObservationPipeline({
      ocr: null,
      ocrVersion: "5",
      vision: null,
      objects: finder,
      profile: getProfile("gta5"),
      sourceLabel: "live",
      visionBatchSize: 1,
      coverageMsPerFrame: 5000,
      workDir: path.join(work, String(Math.random()).slice(2)),
      sink,
      insight: async (i) => void insights.push(i),
    });
    for (const ptsMs of [1000, 2000]) {
      await pipeline.handleFrame({ ptsMs, receivedAt: new Date(), capturedAt: null, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1280, height: 720, reason: "live" });
    }
    return { logged, problems, training, insights };
  };

  it("runs on every frame and hands what it found to training and the AI view, not the log", async () => {
    let calls = 0;
    const { logged, problems, training, insights } = await run({
      name: NAME,
      find: async () => {
        calls += 1;
        return { objects: FOUND.slice(0, 2), durationMs: 12 };
      },
    });
    expect(calls).toBe(2);
    expect(problems).toEqual([]);
    expect(training).toEqual([
      { name: NAME, items: FOUND.slice(0, 2) },
      { name: NAME, items: FOUND.slice(0, 2) },
    ]);
    expect(insights.map((i) => i.objects)).toEqual([
      { enabled: true, name: NAME, items: FOUND.slice(0, 2), durationMs: 12, error: null },
      { enabled: true, name: NAME, items: FOUND.slice(0, 2), durationMs: 12, error: null },
    ]);
    expect(logged.some((d) => /person|car/i.test(d))).toBe(false);
  });

  it("says so when it fails on a frame, proposes nothing from it, and the rest of the analysis carries on", async () => {
    const { problems, training, insights } = await run({
      name: NAME,
      find: async () => {
        throw new Error("model crashed");
      },
    });
    expect(problems.filter((p) => p.startsWith("objects:"))).toHaveLength(2);
    expect(training).toEqual([null, null]);
    expect(insights).toHaveLength(2);
    expect(insights[0]!.objects).toMatchObject({ enabled: true, items: [], error: "model crashed" });
  });
});
