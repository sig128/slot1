import { describe, expect, it } from "vitest";
import {
  buildStories,
  cleanFailReason,
  cleanMissionName,
  knowledgeTags,
  missionLabel,
  questionMissions,
  summarizeMissions,
  type AttemptRecord,
  type StoryEntry,
} from "@slot1/contracts";

let n = 0;
/** One log entry at `s` seconds, tagged the way the live log tags it. */
function at(s: number, type: string, text: string, origin = "ocr"): StoryEntry {
  const description = origin === "ocr" ? `On-screen text: “${text}”` : text;
  return { id: `e${++n}`, type, origin, mediaStartMs: s * 1000, rawText: origin === "ocr" ? text : null, tags: knowledgeTags({ type, description, rawText: origin === "ocr" ? text : null, origin }) };
}
const objective = (s: number, t: string) => at(s, "objective_text", t);
const result = (s: number, t: string, origin = "ocr") => at(s, "result_screen", t, origin);
const banner = (s: number, t: string) => at(s, "visible_text", t);
const seen = (s: number, t: string, type = "movement") => at(s, type, t, "video");

describe("missions as stories", () => {
  it("rebuilds a passed mission: name from the result screen, time, objectives and what happened", () => {
    const { attempts, events } = buildStories([
      objective(10, "Go to the dealership."),
      seen(40, "Player drives a car through Vinewood", "vehicle"),
      objective(70, "Follow Lamar"),
      seen(90, "Police chase on the highway"),
      result(400, "MISSION PASSED"),
      result(401, "Mission passed", "video"), // the same screen, read by the AI too
      banner(401, "FRANKLIN AND LAMAR"),
      banner(403, "TIME TAKEN 05:32"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      seq: 0,
      name: "Franklin and Lamar",
      nameFrom: "result_screen",
      key: "name:franklin and lamar",
      outcome: "passed",
      durationMs: 390_000,
      objectives: ["Go to the dealership", "Follow Lamar"],
      lastObjective: "Follow Lamar",
      deaths: 0,
    });
    expect(attempts[0]!.activities).toEqual(expect.arrayContaining(["driving", "police_chase"]));
    expect(attempts[0]!.places).toContain("Vinewood");
    expect(events.map((e) => e.kind)).toEqual(["mission_passed"]);
    expect(events[0]!.attemptSeq).toBe(0);
  });

  it("keeps why it failed and where, and names the failed try after the retry that passed", () => {
    const { attempts, events } = buildStories([
      objective(0, "Get in the car"),
      objective(30, "Lose the cops"),
      seen(50, "Car crashes into a wall", "possible_collision"),
      result(55, "WASTED"),
      result(60, "MISSION FAILED"),
      banner(61, "Lamar died."),
      objective(80, "Lose the cops"),
      result(300, "MISSION PASSED"),
      banner(301, "THE LONG STRETCH"),
    ]);
    expect(attempts.map((a) => [a.outcome, a.name, a.nameFrom])).toEqual([
      ["failed", "The Long Stretch", "retry"],
      ["passed", "The Long Stretch", "result_screen"],
    ]);
    expect(attempts[0]).toMatchObject({ failReason: "Lamar died.", lastObjective: "Lose the cops", deaths: 1, durationMs: 60_000 });
    // What led to the death: the crash. What led to the failure: the crash and the death.
    const wasted = events.find((e) => e.kind === "wasted")!;
    const failed = events.find((e) => e.kind === "mission_failed")!;
    expect(wasted).toMatchObject({ attemptSeq: 0 });
    expect(wasted.before).toContain("crash");
    expect(wasted.before).not.toContain("wasted");
    expect(failed.before.slice(0, 2)).toEqual(["wasted", "crash"]);
  });

  it("says Wasted when nothing else was read, and keeps deaths outside missions as their own events", () => {
    const { attempts, events } = buildStories([
      seen(0, "Police chase through Mission Row"),
      result(20, "BUSTED"),
      objective(100, "Go to the bank"),
      result(130, "WASTED"),
      result(140, "MISSION FAILED"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "failed", failReason: "Wasted.", deaths: 1, busts: 0 });
    const busted = events.find((e) => e.kind === "busted")!;
    expect(busted).toMatchObject({ attemptSeq: null, places: ["Mission Row"] });
    expect(busted.before).toContain("police_chase");
  });

  it("ends an attempt with no result as no result seen, and a new title as a new attempt", () => {
    const { attempts } = buildStories([
      objective(0, "Go to the airfield"),
      objective(30, "Fly the plane"),
      objective(30 + 11 * 60, "Go to the boat"),
      at(30 + 13 * 60, "mission_title", "Monkey Business", "ocr"),
      objective(30 + 13 * 60 + 5, "Swim to the container"),
    ]);
    expect(attempts.map((a) => [a.outcome, a.name, a.objectives[0]])).toEqual([
      ["unknown", null, "Go to the airfield"],
      ["unknown", null, "Go to the boat"],
      ["unknown", "Monkey Business", "Swim to the container"],
    ]);
    expect(attempts[0]!.durationMs).toBe(30_000);
  });

  it("only takes names and reasons that are text, not stats or buttons", () => {
    expect(cleanMissionName("FATHER/SON")).toBe("Father/Son");
    expect(cleanMissionName("MR. PHILIPS")).toBe("Mr. Philips");
    expect(cleanMissionName("The Time's Come")).toBe("The Time's Come");
    expect(cleanMissionName("Accuracy 63.2%")).toBeNull();
    expect(cleanMissionName("GOLD")).toBeNull();
    expect(cleanMissionName("MISSION PASSED")).toBeNull();
    expect(cleanFailReason("You abandoned the mission")).toBe("You abandoned the mission.");
    expect(cleanFailReason("Retry")).toBeNull();
    expect(cleanFailReason("WASTED")).toBeNull();
  });
});

describe("missions across streams", () => {
  const rec = (o: Partial<AttemptRecord>): AttemptRecord => ({
    sessionId: "s1",
    broadcasterId: "b1",
    name: null,
    key: null,
    outcome: "unknown",
    failReason: null,
    durationMs: null,
    objectives: [],
    lastObjective: null,
    deaths: 0,
    busts: 0,
    activities: [],
    endObservationId: null,
    endedAt: null,
    ...o,
  });

  it("groups attempts by mission, joining the ones known only by how they start", () => {
    const [m, other] = summarizeMissions([
      rec({ name: "The Long Stretch", key: "name:the long stretch", outcome: "passed", durationMs: 300_000, objectives: ["Get in the car", "Lose the cops"], activities: ["driving", "police_chase"], endObservationId: "o1", endedAt: "2026-11-01T10:00:00Z" }),
      rec({ sessionId: "s2", broadcasterId: "b2", name: "The Long Stretch", key: "name:the long stretch", outcome: "passed", durationMs: 500_000, objectives: ["Get in the car"], activities: ["driving"], endObservationId: "o2", endedAt: "2026-11-02T10:00:00Z" }),
      rec({ sessionId: "s3", broadcasterId: "b3", key: "objective:get in the car", outcome: "failed", objectives: ["Get in the car", "Lose the cops"], lastObjective: "Lose the cops", failReason: "Lamar died.", deaths: 1, activities: ["police_chase", "crash"], endObservationId: "o3", endedAt: "2026-11-03T10:00:00Z" }),
      rec({ sessionId: "s3", broadcasterId: "b3", key: "objective:swim to the container", objectives: ["Swim to the container"] }),
    ]);
    expect(m).toMatchObject({
      key: "name:the long stretch",
      name: "The Long Stretch",
      attempts: 3,
      passed: 2,
      failed: 1,
      streams: 3,
      channels: 3,
      medianPassMs: 400_000,
      fastestPassMs: 300_000,
      deaths: 1,
      failsAt: [{ objective: "Lose the cops", count: 1 }],
      failReasons: [{ reason: "Lamar died.", count: 1 }],
      proof: ["o3", "o2", "o1"],
    });
    expect(m!.inPassed[0]).toEqual({ activity: "driving", count: 2 });
    expect(m!.inFailed.map((a) => a.activity)).toEqual(["crash", "police_chase"]);
    expect(missionLabel(other!)).toBe("The mission that starts with “Swim to the container”");
  });

  it("finds the mission a question names", () => {
    const missions = [
      { key: "name:the long stretch", name: "The Long Stretch" },
      { key: "name:the paleto score", name: "The Paleto Score" },
    ];
    expect(questionMissions("How do I pass The Long Stretch?", missions)).toEqual(["name:the long stretch"]);
    expect(questionMissions("tips for the paleto score heist", missions)).toEqual(["name:the paleto score"]);
    expect(questionMissions("how do I pass this", missions)).toEqual([]);
  });
});
