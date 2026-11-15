import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { frameDiff, MotionMeter, MotionRule, motionCandidate, visionDecision } from "@slot1/analysis";

// sharp is a dependency of the analysis package, not of the tests.
type Sharp = (o: { create: { width: number; height: number; channels: 3; background: { r: number; g: number; b: number } } }) => { jpeg(): { toBuffer(): Promise<Buffer> } };
const sharp = createRequire(new URL("../../packages/analysis/package.json", import.meta.url))("sharp") as Sharp;

const gate = { heartbeatMs: 10_000, minGapMs: 3_000 };
const still = { diff: 0.02, spike: false, cut: false };

describe("motion", () => {
  it("measures the mean change between two frames", () => {
    expect(frameDiff(new Uint8Array([0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0]))).toBe(0);
    expect(frameDiff(new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 255, 255, 255]))).toBe(1);
    expect(frameDiff(new Uint8Array([0, 0]), new Uint8Array([255, 0]))).toBeCloseTo(0.5);
  });

  it("flags sudden action against the stream's own normal, and whole-picture changes as cuts", () => {
    const r = new MotionRule();
    // The first reading only sets the normal.
    expect(r.next(0.03)).toEqual({ diff: 0.03, spike: false, cut: false });
    for (let i = 0; i < 10; i++) expect(r.next(0.03).spike).toBe(false);
    expect(r.next(0.15)).toMatchObject({ spike: true, cut: false });
    expect(r.next(0.5)).toMatchObject({ spike: false, cut: true });
  });

  it("doesn't call a busy chase sudden action: the normal rises with it", () => {
    const r = new MotionRule();
    r.next(0.12);
    let spikes = 0;
    for (let i = 0; i < 20; i++) if (r.next(0.12 + (i % 2) * 0.02).spike) spikes++;
    expect(spikes).toBe(0);
  });

  it("reads real JPEG frames", async () => {
    const solid = (v: number) => sharp({ create: { width: 320, height: 180, channels: 3, background: { r: v, g: v, b: v } } }).jpeg().toBuffer();
    const m = new MotionMeter();
    expect(await m.measure(await solid(10))).toEqual({ diff: 0, spike: false, cut: false });
    const same = await m.measure(await solid(10));
    expect(same.diff).toBeLessThan(0.01);
    const flash = await m.measure(await solid(250));
    expect(flash.cut).toBe(true);
  });

  it("describes only what was measured", () => {
    const at = new Date("2026-11-15T18:00:00Z");
    const c = motionCandidate({ diff: 0.18, spike: true, cut: false }, { ptsMs: 4000, assetId: "a1", receivedAt: at, capturedAt: null }, at.toISOString());
    expect(c).toMatchObject({ type: "movement", interpretation: "inferred", origin: "video", mediaStartMs: 4000, model: { provider: "slot1-motion" } });
    expect(c.description).toBe("Sudden action on screen: the picture changed 18% in a second");
    expect(c.evidence).toEqual([{ assetId: "a1", kind: "frame", mediaPtsMs: 4000 }]);
  });
});

describe("when the vision model looks", () => {
  it("batches every frame without a gate or a motion reading, as before", () => {
    expect(visionDecision(null, { change: still, bigText: false, sceneChanged: false, sinceLastMs: 0 })).toBe("batch");
    expect(visionDecision(gate, { change: null, bigText: false, sceneChanged: false, sinceLastMs: 0 })).toBe("batch");
  });

  it("skips quiet frames until the heartbeat", () => {
    expect(visionDecision(gate, { change: still, bigText: false, sceneChanged: false, sinceLastMs: 1_000 })).toBe("skip");
    expect(visionDecision(gate, { change: still, bigText: false, sceneChanged: false, sinceLastMs: 9_999 })).toBe("skip");
    expect(visionDecision(gate, { change: still, bigText: false, sceneChanged: false, sinceLastMs: 10_000 })).toBe("batch");
    expect(visionDecision(gate, { change: still, bigText: false, sceneChanged: false, sinceLastMs: Infinity })).toBe("batch");
  });

  it("looks at once when something happens, at most once every few seconds", () => {
    for (const f of [
      { change: { diff: 0.2, spike: true, cut: false }, bigText: false, sceneChanged: false },
      { change: { diff: 0.6, spike: false, cut: true }, bigText: false, sceneChanged: false },
      { change: still, bigText: true, sceneChanged: false },
      { change: still, bigText: false, sceneChanged: true },
    ]) {
      expect(visionDecision(gate, { ...f, sinceLastMs: 3_000 })).toBe("now");
      expect(visionDecision(gate, { ...f, sinceLastMs: 2_000 })).toBe("skip");
    }
  });
});
