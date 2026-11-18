import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProfile, ObservationPipeline, type OcrEngine, type OcrLine, type PipelineSink } from "@slot1/analysis";

/**
 * Featured channels' preview pictures: OCR still reads everything (for "What the AI sees" and the
 * training labels), but loose whole-frame words (menus, overlays, chat boxes) stay out of the log.
 */

const LINES: OcrLine[] = [
  { text: "FACIAL HAIR STYLE", confidence: 93, regionId: "full", type: "visible_text" },
  { text: "Not applied", confidence: 90, regionId: "full", type: "visible_text" },
  { text: "Meet Lucia at the marina", confidence: 91, regionId: "bottom_center", type: "objective_text" },
];

const ocr: OcrEngine = { name: "fake-ocr", readFrame: async () => LINES };

function memorySink() {
  const logged: string[] = [];
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
    problem: async () => undefined,
  };
  return { sink, logged };
}

describe("OCR readings kept out of the log", () => {
  let work: string;
  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "slot1-ocr-keep-out-"));
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const run = async (keepOut?: ReadonlySet<string>) => {
    const { sink, logged } = memorySink();
    const insights: number[] = [];
    const pipeline = new ObservationPipeline({
      ocr,
      ocrVersion: "5",
      ocrKeepOut: keepOut,
      vision: null,
      profile: getProfile("gta5"),
      sourceLabel: "live",
      visionBatchSize: 1,
      coverageMsPerFrame: 5000,
      workDir: path.join(work, String(Math.random()).slice(2)),
      sink,
      insight: async (i) => void insights.push(i.ocr.lines.length),
    });
    // OCR readings publish once seen on two frames in a row.
    for (const ptsMs of [1000, 2000, 3000]) {
      await pipeline.handleFrame({ ptsMs, receivedAt: new Date(), capturedAt: null, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1280, height: 720, reason: "live" });
    }
    return { logged, insights };
  };

  it("logs every reading by default", async () => {
    const { logged } = await run();
    expect(logged.some((d) => d.includes("FACIAL HAIR STYLE"))).toBe(true);
    expect(logged.some((d) => d.includes("Meet Lucia at the marina"))).toBe(true);
  });

  it("leaves loose on-screen words out, keeps objectives, and still shows every line to the AI view", async () => {
    const { logged, insights } = await run(new Set(["visible_text"]));
    expect(logged.some((d) => d.includes("FACIAL HAIR STYLE") || d.includes("Not applied"))).toBe(false);
    expect(logged.some((d) => d.includes("Meet Lucia at the marina"))).toBe(true);
    expect(insights).toEqual([3, 3, 3]);
  });
});
