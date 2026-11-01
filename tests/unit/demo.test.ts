import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GTA5_PROFILE, type FrameInsight } from "@slot1/analysis";
import { AiViewSnapshot, DEMO_LOGIN } from "@slot1/contracts";
import { loadConfig } from "@slot1/platform";
import { buildAiViewSnapshot, demoConfigured, demoSettings, hiddenDemo, isDemoBroadcaster, REGION_LABELS } from "@slot1/services";
import { buildDemoScene, DEMO_CYCLE_SEC, DEMO_EVENTS, DEMO_LAYOUT, DEMO_WATERMARK, demoCash, demoEncodeArgs, demoPublishUrl } from "../../apps/worker/src/demo/scene";

const region = (id: string) => {
  const r = GTA5_PROFILE.regions.find((x) => x.id === id)!;
  const [x, y, w, h] = r.box;
  return { x0: x, y0: y, x1: x + w, y1: y + h };
};
/** Vertical span of a text line: its top and font size (glyphs stay within one em). */
const span = (t: { y: number; size: number }) => ({ top: t.y, bottom: t.y + t.size });

describe("demo scene", () => {
  it("puts every HUD line inside the GTA V region SLOT1's OCR reads it from, and nowhere else", () => {
    const bottom = region("bottom_center");
    const center = region("center_banner");
    const area = region("bottom_right_area");
    const cash = region("top_right_hud");
    const line = span(DEMO_LAYOUT.line);
    expect(line.top).toBeGreaterThanOrEqual(bottom.y0);
    // Subtitles and objectives stay above the area-name region (no partial double reads).
    expect(line.bottom).toBeLessThan(area.y0);
    const place = span(DEMO_LAYOUT.place);
    expect(place.top).toBeGreaterThan(bottom.y1);
    expect(place.bottom).toBeLessThanOrEqual(area.y1);
    expect(DEMO_LAYOUT.place.right).toBeGreaterThan(area.x0);
    expect(DEMO_LAYOUT.place.right).toBeLessThanOrEqual(area.x1);
    for (const t of [DEMO_LAYOUT.title, DEMO_LAYOUT.passed, DEMO_LAYOUT.bigResult]) {
      expect(span(t).top).toBeGreaterThanOrEqual(center.y0);
      expect(span(t).bottom).toBeLessThanOrEqual(center.y1);
    }
    const c = span(DEMO_LAYOUT.cash);
    expect(c.top).toBeGreaterThanOrEqual(cash.y0);
    expect(c.bottom).toBeLessThanOrEqual(cash.y1);
    expect(DEMO_LAYOUT.cash.right).toBeGreaterThan(cash.x0);
    // The watermark is never read: it sits left of the cash region and above every other region.
    const w = span(DEMO_LAYOUT.watermark);
    expect(w.bottom).toBeLessThan(center.y0);
    const approxWidth = DEMO_WATERMARK.length * 0.62 * DEMO_LAYOUT.watermark.size * (9 / 16);
    expect(DEMO_LAYOUT.watermark.x + approxWidth).toBeLessThan(cash.x0);
  });

  it("runs one mission per cycle with original text, at most one line per region at a time", () => {
    for (const e of DEMO_EVENTS) {
      expect(e.start).toBeGreaterThanOrEqual(0);
      expect(e.end).toBeLessThanOrEqual(DEMO_CYCLE_SEC);
      // Long enough for at least two samples at the default 3 s interval.
      expect(e.end - e.start).toBeGreaterThanOrEqual(6);
    }
    const groups: Record<string, string[]> = { line: ["subtitle", "objective"], center: ["mission_title", "passed", "wasted", "busted"], place: ["place"] };
    for (const kinds of Object.values(groups)) {
      const evs = DEMO_EVENTS.filter((e) => kinds.includes(e.kind)).sort((a, b) => a.start - b.start);
      for (let i = 1; i < evs.length; i++) expect(evs[i]!.start).toBeGreaterThanOrEqual(evs[i - 1]!.end);
    }
    expect(DEMO_EVENTS.map((e) => e.kind)).toEqual(expect.arrayContaining(["passed", "wasted", "busted", "subtitle", "objective", "place", "mission_title"]));
    // Invented names only.
    expect(DEMO_EVENTS.map((e) => e.text).join(" ")).not.toMatch(/Lamar|Franklin|Trevor|Michael|Vespucci|Los Santos|Vinewood/i);
  });

  it("shows cash the way the HUD region expects it", () => {
    const re = GTA5_PROFILE.regions.find((r) => r.id === "top_right_hud")!.requirePattern!;
    for (const c of [0, 49, 81, 113, 149]) expect(re.test(`$${demoCash(c).toLocaleString("en-US")}`)).toBe(true);
    expect(demoCash(50) - demoCash(0)).toBe(25_000);
  });

  it("writes a filter graph with every event, the watermark and low-latency encoding", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slot1-demo-unit-"));
    try {
      const scene = await buildDemoScene(dir, { width: 1280, height: 720, fps: 30, font: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" });
      const graph = await readFile(path.join(dir, "filter.txt"), "utf8");
      expect(graph.match(/drawtext=/g)?.length).toBe(DEMO_EVENTS.length + 2);
      for (const e of DEMO_EVENTS) expect(graph).toContain(`between(mod(t,${DEMO_CYCLE_SEC}),${e.start},${e.end})`);
      expect(await readFile(path.join(dir, "watermark.txt"), "utf8")).toBe(DEMO_WATERMARK);
      expect(graph).not.toMatch(/pricedown/i);
      expect(scene.args.filter((a) => a === "-re").length).toBe(4);
      expect(scene.args).toContain("-filter_complex_script");
      const enc = demoEncodeArgs({ fps: 30, bitrateKbps: 2500, preset: "veryfast" });
      expect(enc.join(" ")).toContain("-g 30 -keyint_min 30 -sc_threshold 0 -bf 0");
      expect(enc.join(" ")).toContain("-tune zerolatency");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("publishes with each gateway's own key format", () => {
    expect(demoPublishUrl("mediamtx", "rtmp://mediamtx:1935/live/", "abcdef0123456789")).toBe("rtmp://mediamtx:1935/live/slot1demo?user=slot1demo&pass=abcdef0123456789");
    expect(demoPublishUrl("nginx-rtmp", "rtmp://ingest:1935/live", "abcdef0123456789")).toBe("rtmp://ingest:1935/live/slot1demo?key=abcdef0123456789");
  });
});

describe("demo channel settings", () => {
  const cfg = (extra: Record<string, string>) => loadConfig({ NODE_ENV: "test", ...extra });

  it("is off unless switched on with a real key", () => {
    expect(demoConfigured(cfg({})).enabled).toBe(false);
    expect(demoConfigured(cfg({ SLOT1_DEMO: "true" })).reason).toMatch(/no stream key/);
    expect(demoConfigured(cfg({ SLOT1_DEMO: "true", SLOT1_DEMO_STREAM_KEY: "short" })).enabled).toBe(false);
    expect(demoConfigured(cfg({ SLOT1_DEMO: "true", SLOT1_DEMO_STREAM_KEY: "0123456789abcdef0123" })).enabled).toBe(true);
  });

  it("never reaches paid AI or the training pool by default, and records nothing in full", () => {
    const s = demoSettings(cfg({ SLOT1_DEMO: "true" }));
    expect(s.maxVisionCallsPerHour).toBe(0);
    expect(s.viewerQuestions).toBe("off");
    expect(s.trainingConsent).toBe(false);
    expect(s.recordingEnabled).toBe(false);
    expect(s.rollingBufferEnabled).toBe(true);
    expect(s.visibility).toBe("public");
    expect(s.gameProfile).toBe("gta5");
    const paid = demoSettings(cfg({ SLOT1_DEMO: "true", SLOT1_DEMO_VISION: "true" }));
    expect(paid.maxVisionCallsPerHour).toBe(12);
  });

  it("recognizes only SLOT1's own demo channel, and hides it when the demo is off", () => {
    expect(isDemoBroadcaster({ kind: "local", login: DEMO_LOGIN })).toBe(true);
    expect(isDemoBroadcaster({ kind: "twitch", login: DEMO_LOGIN })).toBe(false);
    expect(isDemoBroadcaster({ kind: "local", login: "slot1demo" })).toBe(false);
    expect(hiddenDemo(cfg({}), { kind: "local", login: DEMO_LOGIN })).toBe(true);
    expect(hiddenDemo(cfg({ SLOT1_DEMO: "true", SLOT1_DEMO_STREAM_KEY: "0123456789abcdef0123" }), { kind: "local", login: DEMO_LOGIN })).toBe(false);
  });
});

describe("AI view snapshot", () => {
  const insight = (over: Partial<FrameInsight> = {}): FrameInsight => ({
    frame: { ptsMs: 12_000, receivedAt: new Date("2026-11-01T12:00:00Z"), capturedAt: null, jpeg: Buffer.alloc(1), width: 1280, height: 720, reason: "live" },
    ref: { ptsMs: 12_000, assetId: "a1", receivedAt: new Date("2026-11-01T12:00:00Z"), capturedAt: null },
    profile: GTA5_PROFILE,
    ocr: {
      enabled: true,
      engine: "tesseract",
      lines: [
        { text: "MISSION PASSED", confidence: 96.14, regionId: "center_banner", type: "result_screen", bbox: [0.3, 0.41, 0.4, 0.1] },
        { text: "$1,273,500", confidence: 95.4, regionId: "top_right_hud", type: "hud_reading" },
      ],
      durationMs: 780,
      error: null,
    },
    model: { enabled: false, label: null, prediction: null, skipped: null, error: null },
    vision: { enabled: false, provider: null, model: null, state: "off", result: null, note: null, batch: { have: 0, need: 0 } },
    produced: [{ id: "o1", type: "result_screen", description: "Result screen: MISSION PASSED", action: "new" }],
    analyzedAt: new Date("2026-11-01T12:00:00.900Z"),
    ...over,
  });

  it("lists every OCR region with what was read there, exactly", () => {
    const s = buildAiViewSnapshot("6f6b9d1c-1f7b-4ad9-9f55-2d7f3c1a0b11", { sessionId: "3c0a7d4e-58a1-4b8e-9a35-8a6f6d0b2c11", label: "test", demo: true, intervalMs: 3000, measuredCadenceMs: 3010 }, insight(), {
      width: 640,
      height: 360,
      analyzedWidth: 1280,
      analyzedHeight: 720,
    });
    expect(AiViewSnapshot.safeParse(s).success).toBe(true);
    expect(s.ocr.regions.map((r) => r.id)).toEqual(GTA5_PROFILE.regions.map((r) => r.id));
    for (const r of s.ocr.regions) expect(r.label).toBe(REGION_LABELS[r.id]);
    expect(s.ocr.regions.find((r) => r.id === "center_banner")!.readings).toEqual([{ text: "MISSION PASSED", confidence: 96.1, type: "result_screen", box: [0.3, 0.41, 0.4, 0.1] }]);
    expect(s.ocr.regions.find((r) => r.id === "top_right_hud")!.readings[0]!.box).toBeNull();
    expect(s.ocr.regions.find((r) => r.id === "bottom_center")!.readings).toEqual([]);
    expect(s.frame.url).toBe("/api/sessions/3c0a7d4e-58a1-4b8e-9a35-8a6f6d0b2c11/ai-view/frame/6f6b9d1c-1f7b-4ad9-9f55-2d7f3c1a0b11");
    expect(s.latencyMs).toBe(900);
    expect(s.produced).toHaveLength(1);
  });

  it("says plainly what isn't running instead of showing a guess", () => {
    const demo = buildAiViewSnapshot("6f6b9d1c-1f7b-4ad9-9f55-2d7f3c1a0b11", { sessionId: "3c0a7d4e-58a1-4b8e-9a35-8a6f6d0b2c11", label: "test", demo: true, intervalMs: 3000, measuredCadenceMs: null }, insight(), { width: 640, height: 360, analyzedWidth: 1280, analyzedHeight: 720 });
    expect(demo.vision.status).toBe("off");
    expect(demo.vision.note).toMatch(/Paid AI vision is off for the demo/);
    expect(demo.gtaModel.status).toBe("none");
    expect(demo.gtaModel.note).toMatch(/No trained GTA model is active/);
    const batching = buildAiViewSnapshot(
      "6f6b9d1c-1f7b-4ad9-9f55-2d7f3c1a0b11",
      { sessionId: "3c0a7d4e-58a1-4b8e-9a35-8a6f6d0b2c11", label: "live", demo: false, intervalMs: 5000, measuredCadenceMs: null },
      insight({ vision: { enabled: true, provider: "anthropic", model: "m", state: "batching", result: null, note: null, batch: { have: 1, need: 3 } } }),
      { width: 640, height: 360, analyzedWidth: 1280, analyzedHeight: 720 },
    );
    expect(batching.vision.note).toBe("Waiting for 2 more frames to send a batch");
    const noOcr = buildAiViewSnapshot(
      "6f6b9d1c-1f7b-4ad9-9f55-2d7f3c1a0b11",
      { sessionId: "3c0a7d4e-58a1-4b8e-9a35-8a6f6d0b2c11", label: "live", demo: false, intervalMs: 5000, measuredCadenceMs: null },
      insight({ ocr: { enabled: false, engine: null, lines: [], durationMs: null, error: null } }),
      { width: 640, height: 360, analyzedWidth: 1280, analyzedHeight: 720 },
    );
    expect(noOcr.ocr.status).toBe("off");
    expect(noOcr.ocr.regions.every((r) => r.readings.length === 0)).toBe(true);
  });
});
