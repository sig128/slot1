import { describe, expect, it } from "vitest";
import { cameraMaskFilters, getProfile, LiveIngestAdapter } from "@slot1/analysis";
import {
  CAMERA_MASK_PRESETS,
  CameraMask,
  CameraMaskBox,
  cameraMaskTuples,
  DEMO_CAMERA_MASK,
  DEMO_CAMERA_TILE,
  normalizeCameraMask,
  SetCameraMaskInput,
} from "@slot1/contracts";

const identity = { sourceId: "s1", broadcasterId: "b1", sessionId: "x1", kind: "live_ingest" as const, label: "live" as const };
const tools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", timeoutMs: 60_000 };
const baseOpts = { readUrl: "rtmp://127.0.0.1/live/abcd?reader=pw", intervalMs: 2000, maxEdge: 1280, queueSize: 4, rollingBuffer: null, ioTimeoutSec: 15 };

describe("camera mask: what creators may save", () => {
  it("accepts up to three boxes inside the picture, at least 3% on a side", () => {
    expect(CameraMaskBox.safeParse({ x: 0.7, y: 0.65, w: 0.3, h: 0.35 }).success).toBe(true);
    expect(CameraMaskBox.safeParse({ x: 0.8, y: 0, w: 0.3, h: 0.2 }).success).toBe(false); // past the right edge
    expect(CameraMaskBox.safeParse({ x: 0, y: 0, w: 0.01, h: 0.2 }).success).toBe(false); // a sliver
    expect(CameraMaskBox.safeParse({ x: -0.1, y: 0, w: 0.2, h: 0.2 }).success).toBe(false);
    const four = Array.from({ length: 4 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 }));
    expect(CameraMask.safeParse(four).success).toBe(false);
    expect(SetCameraMaskInput.safeParse({ boxes: four.slice(0, 3) }).success).toBe(true);
    expect(SetCameraMaskInput.safeParse({ boxes: [] }).success).toBe(true);
  });

  it("normalizes to four decimals and keeps every box inside the picture", () => {
    expect(normalizeCameraMask([{ x: 0.123456, y: 0.98, w: 0.2, h: 0.1 }])).toEqual([{ x: 0.1235, y: 0.9, w: 0.2, h: 0.1 }]);
    expect(normalizeCameraMask([{ x: 0.5, y: 0.5, w: 0.001, h: 2 }])).toEqual([{ x: 0.5, y: 0, w: 0.03, h: 1 }]);
    expect(cameraMaskTuples([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }])).toEqual([[0.1, 0.2, 0.3, 0.4]]);
  });

  it("offers four valid corner presets", () => {
    for (const box of Object.values(CAMERA_MASK_PRESETS)) expect(CameraMaskBox.safeParse(box).success).toBe(true);
  });
});

describe("camera mask: where the worker applies it", () => {
  it("builds one black drawbox per box, padded against slivers", () => {
    expect(cameraMaskFilters(undefined)).toEqual([]);
    expect(cameraMaskFilters([])).toEqual([]);
    expect(cameraMaskFilters([{ x: 0.7, y: 0.65, w: 0.3, h: 0.35 }])).toEqual([
      "drawbox=x=floor(iw*0.7000)-2:y=floor(ih*0.6500)-2:w=ceil(iw*0.3000)+4:h=ceil(ih*0.3500)+4:color=black:t=fill",
    ]);
  });

  it("masks the analysis frames inside ffmpeg, after scaling and before they leave it", () => {
    const masked = new LiveIngestAdapter(identity, tools, { ...baseOpts, mask: [{ x: 0, y: 0, w: 0.25, h: 0.3 }] }).buildArgs();
    const vf = masked[masked.indexOf("-vf") + 1]!;
    expect(vf.startsWith("fps=")).toBe(true);
    expect(vf.indexOf("scale=")).toBeGreaterThan(0);
    expect(vf.indexOf(",drawbox=")).toBeGreaterThan(vf.indexOf("scale="));
    expect(vf).toContain(",drawbox=x=floor(iw*0.0000)-2:y=floor(ih*0.0000)-2:w=ceil(iw*0.2500)+4:h=ceil(ih*0.3000)+4:color=black:t=fill,showinfo");
    expect(vf.endsWith(",showinfo")).toBe(true);
    // Without a mask the chain is unchanged.
    const plain = new LiveIngestAdapter(identity, tools, baseOpts).buildArgs();
    expect(plain[plain.indexOf("-vf") + 1]).not.toContain("drawbox");
  });

  it("never masks what viewers get: the rolling buffer and the recording stay copy-only", () => {
    const args = new LiveIngestAdapter(identity, tools, {
      ...baseOpts,
      mask: [{ x: 0, y: 0, w: 0.25, h: 0.3 }],
      rollingBuffer: { dir: "/tmp/buf", segmentSeconds: 6, segments: 10 },
      recording: { dir: "/tmp/rec", runId: "r1", segmentSeconds: 6 },
    }).buildArgs();
    // One filter chain only, for the analysis output (pipe:1); every later output copies the stream.
    expect(args.filter((a) => a === "-vf")).toHaveLength(1);
    const afterPipe = args.slice(args.indexOf("pipe:1") + 1);
    expect(afterPipe.join(" ")).not.toContain("drawbox");
    expect(afterPipe.filter((a) => a === "copy")).toHaveLength(2);
  });
});

describe("camera mask: the demo stream", () => {
  it("hides the demo's placeholder webcam tile completely and no OCR region", () => {
    const [m] = DEMO_CAMERA_MASK;
    const t = DEMO_CAMERA_TILE;
    expect(CameraMask.safeParse(DEMO_CAMERA_MASK).success).toBe(true);
    expect(m!.x).toBeLessThanOrEqual(t.x);
    expect(m!.y).toBeLessThanOrEqual(t.y);
    expect(m!.x + m!.w).toBeGreaterThanOrEqual(t.x + t.w);
    expect(m!.y + m!.h).toBeGreaterThanOrEqual(t.y + t.h);
    for (const r of getProfile("gta5").regions) {
      const [rx, ry, rw, rh] = r.box;
      const overlaps = m!.x < rx + rw && rx < m!.x + m!.w && m!.y < ry + rh && ry < m!.y + m!.h;
      expect(overlaps, `the demo mask covers OCR region ${r.id}`).toBe(false);
    }
  });
});
