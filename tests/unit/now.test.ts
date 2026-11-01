import { describe, expect, it } from "vitest";
import { ACTIVITY_WINDOW_MS, deriveActivity, type Observation } from "@slot1/contracts";
import { wheelIndexFromPoint, wheelKey, wheelPosition } from "../../apps/web/lib/wheel";

const NOW = Date.parse("2026-11-01T21:00:00Z");
let n = 0;
type In = Parameters<typeof deriveActivity>[0][number];
function o(type: Observation["type"], description: string, agoMs: number, over: Partial<In> = {}): In {
  return { id: `o${++n}`, type, description, rawText: null, origin: "video", receivedAt: new Date(NOW - agoMs).toISOString(), reviewStatus: "unreviewed", ...over };
}

describe("what's happening on a stream right now", () => {
  it("prefers events over scenes over mission text, and says plain Live otherwise", () => {
    const mission = o("mission_title", "Mission title", 5000, { origin: "ocr", rawText: "Go to the docks" });
    const scene = o("environment", "Scene: Driving", 4000);
    const chase = o("movement", "Likely police chase", 20_000);
    expect(deriveActivity([mission], NOW)).toMatchObject({ key: "mission", tier: "mission", detail: "Go to the docks" });
    expect(deriveActivity([mission, scene], NOW)).toMatchObject({ key: "driving", label: "Driving", tier: "scene" });
    expect(deriveActivity([mission, scene, chase], NOW)).toMatchObject({ key: "police_chase", label: "Police chase", tier: "event", observationId: chase.id });
    expect(deriveActivity([], NOW, "Analysis paused by the creator")).toEqual({
      key: "live", label: "Live", detail: "Analysis paused by the creator", tier: "none", observedAt: null, observationId: null,
    });
  });

  it("reads result screens, crashes and shootouts as events; the newest event wins", () => {
    const crash = o("possible_collision", "Possible collision", 30_000);
    const passed = o("result_screen", "MISSION PASSED screen", 10_000, { origin: "ocr", rawText: "MISSION PASSED" });
    expect(deriveActivity([crash, passed], NOW)).toMatchObject({ key: "mission_passed", label: "Mission passed" });
    expect(deriveActivity([o("result_screen", "WASTED screen", 3000)], NOW)).toMatchObject({ key: "wasted", tier: "event" });
    expect(deriveActivity([o("result_screen", "BUSTED screen", 3000)], NOW)).toMatchObject({ key: "busted" });
    expect(deriveActivity([o("combat", "Gunfire on screen", 3000)], NOW)).toMatchObject({ key: "shootout" });
    expect(deriveActivity([crash], NOW)).toMatchObject({ key: "crash", observedAt: new Date(NOW - 30_000).toISOString() });
  });

  it("knows the GTA model's scene classes and ignores ones it doesn't", () => {
    expect(deriveActivity([o("environment", "Scene: On foot", 1000)], NOW)).toMatchObject({ key: "on_foot", label: "On foot" });
    expect(deriveActivity([o("environment", "Scene: Cutscene", 1000)], NOW)).toMatchObject({ key: "cutscene" });
    expect(deriveActivity([o("environment", "Scene: Menu or map", 1000)], NOW)).toMatchObject({ key: "menu", label: "In the menu or map" });
    expect(deriveActivity([o("environment", "Scene: Underwater", 1000)], NOW)).toMatchObject({ key: "live" });
    expect(deriveActivity([o("environment", "Night time", 1000)], NOW)).toMatchObject({ key: "live" });
  });

  it("never presents old, rejected, Twitch or unreadable evidence as current", () => {
    const old = o("movement", "Likely police chase", ACTIVITY_WINDOW_MS + 1000);
    const rejected = o("movement", "Likely police chase", 2000, { reviewStatus: "rejected" });
    const twitch = o("result_screen", "MISSION PASSED", 2000, { origin: "twitch", rawText: "MISSION PASSED" });
    const future = o("combat", "Gunfire", -10_000);
    const short = o("objective_text", "Objective", 2000, { origin: "ocr", rawText: "Go" });
    expect(deriveActivity([old, rejected, twitch, future, short], NOW, "Nothing SLOT1 could name in the last minute")).toMatchObject({
      key: "live",
      detail: "Nothing SLOT1 could name in the last minute",
    });
  });
});

describe("radio wheel keys and pointer", () => {
  it("moves clockwise with Right/Down and back with Left/Up, wrapping around", () => {
    expect(wheelKey("ArrowRight", 0, 4)).toEqual({ type: "move", index: 1 });
    expect(wheelKey("ArrowDown", 3, 4)).toEqual({ type: "move", index: 0 });
    expect(wheelKey("ArrowLeft", 0, 4)).toEqual({ type: "move", index: 3 });
    expect(wheelKey("ArrowUp", 2, 4)).toEqual({ type: "move", index: 1 });
    expect(wheelKey("Home", 2, 4)).toEqual({ type: "move", index: 0 });
    expect(wheelKey("End", 0, 4)).toEqual({ type: "move", index: 3 });
  });

  it("switches with Enter or Space and closes with Escape or Q", () => {
    expect(wheelKey("Enter", 1, 4)).toEqual({ type: "commit" });
    expect(wheelKey(" ", 1, 4)).toEqual({ type: "commit" });
    expect(wheelKey("Escape", 1, 4)).toEqual({ type: "close" });
    expect(wheelKey("q", 1, 4)).toEqual({ type: "close" });
    expect(wheelKey("Q", 1, 4)).toEqual({ type: "close" });
    expect(wheelKey("a", 1, 4)).toBeNull();
    expect(wheelKey("ArrowRight", 0, 0)).toBeNull();
    expect(wheelKey("Escape", 0, 0)).toEqual({ type: "close" });
    expect(wheelKey("ArrowRight", 9, 3)).toEqual({ type: "move", index: 0 });
  });

  it("lays options out from the top, clockwise, and maps a pointer back to them", () => {
    const top = wheelPosition(0, 4);
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(-1);
    const right = wheelPosition(1, 4);
    expect(right.x).toBeCloseTo(1);
    expect(right.y).toBeCloseTo(0);
    expect(wheelIndexFromPoint(0, -50, 4)).toBe(0);
    expect(wheelIndexFromPoint(50, 0, 4)).toBe(1);
    expect(wheelIndexFromPoint(0, 50, 4)).toBe(2);
    expect(wheelIndexFromPoint(-50, 0, 4)).toBe(3);
    expect(wheelIndexFromPoint(-5, -50, 4)).toBe(0);
    expect(wheelIndexFromPoint(3, 3, 4, 20)).toBeNull();
    for (let i = 0; i < 7; i++) {
      const p = wheelPosition(i, 7);
      expect(wheelIndexFromPoint(p.x * 100, p.y * 100, 7)).toBe(i);
    }
  });
});
