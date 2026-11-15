import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearLearningCache } from "../../apps/api/src/routes/learning";
import { LearningAnswer, LearningResponse, type ObservationType } from "@slot1/contracts";
import { createIngestSession, createLocalBroadcaster, createLocalUser, insertObservation, refreshSessionStories, sessionsNeedingStories, updateSettings } from "@slot1/db";
import { Browser, startHarness, type Harness } from "./harness";

type Line = [seconds: number, type: ObservationType, text: string, origin?: "ocr" | "video"];

/** One stream of entries at the given times (seconds), on a channel that's public (or not). */
async function stream(h: Harness, name: string, o: { channel: "public" | "private"; label: "live" | "test" }, lines: Line[]) {
  const user = await createLocalUser(h.ctx.db, name);
  const b = await createLocalBroadcaster(h.ctx.db, user.id, `${name.toLowerCase()}${randomBytes(2).toString("hex")}`, name);
  await updateSettings(h.ctx.db, b.id, { visibility: o.channel, publicAnalysis: o.channel === "public" });
  const s = await createIngestSession(h.ctx.db, b.id, o.label, `${name} plays`, "public", 1000);
  const ids: string[] = [];
  for (const [sec, type, text, origin = "ocr"] of lines) {
    const { observation } = await insertObservation(h.ctx.db, {
      broadcasterId: b.id,
      sessionId: s.id,
      sourceId: null,
      mediaStartMs: sec * 1000,
      mediaEndMs: sec * 1000,
      capturedAt: null,
      receivedAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      interpretation: origin === "ocr" ? "directly_visible" : "inferred",
      evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: sec * 1000 }],
      model: null,
      modelConfidence: null,
      relatedEntities: [],
      type,
      origin,
      description: origin === "ocr" ? `On-screen text: “${text}”` : text,
      rawText: origin === "ocr" ? text : null,
    });
    ids.push(observation.id);
  }
  return { session: s, ids };
}

/** A made-up mission name, new every run (the test database keeps earlier runs). */
const word = () =>
  Array.from(randomBytes(6))
    .map((x) => String.fromCharCode(97 + (x % 26)))
    .join("");

describe("missions as stories, across streams", () => {
  let h: Harness;
  let anon: Browser;
  const w = word();
  // Read on screen in capitals, kept in title case.
  const mission = `The ${w.charAt(0).toUpperCase()}${w.slice(1)} Job`;
  let passedId = "";
  let sessionId = "";
  let before: LearningResponse;
  const read = async () => {
    clearLearningCache();
    return LearningResponse.parse((await anon.get("/api/learning")).json());
  };

  beforeAll(async () => {
    h = await startHarness();
    anon = new Browser(h);
    await anon.refreshCsrf();
    before = await read();
    const lines: Line[] = [
      [0, "objective_text", "Get in the car"],
      [30, "objective_text", "Lose the cops"],
      [45, "movement", "Police chase through Mission Row", "video"],
      [50, "possible_collision", "Car crashes into a barrier", "video"],
      [55, "result_screen", "WASTED"],
      [60, "result_screen", "MISSION FAILED"],
      [61, "visible_text", "Lamar died."],
      [90, "objective_text", "Lose the cops"],
      [400, "result_screen", "MISSION PASSED"],
      [401, "visible_text", mission.toUpperCase()],
      [403, "visible_text", "TIME TAKEN 05:10"],
      // Free roam afterwards: busted, not part of any mission.
      [900, "movement", "Police chase on the highway", "video"],
      [920, "result_screen", "BUSTED"],
    ];
    const pub = await stream(h, "StoryTeller", { channel: "public", label: "live" }, lines);
    sessionId = pub.session.id;
    passedId = pub.ids[8]!;
    // The same stream on a private channel and as a TEST source: rebuilt, but never counted.
    const hidden = await stream(h, "Hidden", { channel: "private", label: "live" }, lines);
    const test = await stream(h, "Pattern", { channel: "public", label: "test" }, lines);
    for (const id of [sessionId, hidden.session.id, test.session.id]) await refreshSessionStories(h.ctx.db, id);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("rebuilds each stream once, and again only when new mission entries arrive", async () => {
    const pending = await sessionsNeedingStories(h.ctx.db, 1000, 0);
    expect(pending).not.toContain(sessionId);
    const { rows } = await h.ctx.db.query(`SELECT seq, name, name_from, outcome, fail_reason, deaths, last_objective FROM mission_attempts WHERE session_id = $1 ORDER BY seq`, [sessionId]);
    expect(rows).toEqual([
      { seq: 0, name: mission, name_from: "retry", outcome: "failed", fail_reason: "Lamar died.", deaths: 1, last_objective: "Lose the cops" },
      { seq: 1, name: mission, name_from: "result_screen", outcome: "passed", fail_reason: null, deaths: 0, last_objective: "Lose the cops" },
    ]);
    const events = await h.ctx.db.query(`SELECT kind, attempt_seq FROM story_events WHERE session_id = $1 ORDER BY at_ms`, [sessionId]);
    expect(events.rows).toEqual([
      { kind: "wasted", attempt_seq: 0 },
      { kind: "mission_failed", attempt_seq: 0 },
      { kind: "mission_passed", attempt_seq: 1 },
      { kind: "busted", attempt_seq: null },
    ]);
  });

  it("shows the mission and what leads to each result on the Learning page, public streams only", async () => {
    const r = await read();
    const m = r.missions.find((x) => x.label === mission);
    expect(m).toMatchObject({
      named: true,
      attempts: 2,
      passed: 1,
      failed: 1,
      streams: 1,
      medianPassMs: 310_000,
      deaths: 1,
      failsAt: [{ objective: "Lose the cops", count: 1 }],
      failReasons: [{ reason: "Lamar died.", count: 1 }],
      href: `/m/${passedId}`,
    });
    const total = (x: LearningResponse, k: string) => x.outcomes.find((o) => o.kind === k)!.total;
    for (const k of ["wasted", "busted", "mission_failed", "mission_passed"]) expect(total(r, k) - total(before, k)).toBe(1);
    const wasted = r.outcomes.find((o) => o.kind === "wasted")!;
    expect(wasted.before.map((b) => b.label)).toEqual(expect.arrayContaining(["Crashing", "Police chase"]));
    expect(r.outcomes.find((o) => o.kind === "busted")!.before.map((b) => b.key)).toContain("police_chase");
  });

  it("answers how to pass a mission, and what leads to dying, from the stories", async () => {
    const ask = async (question: string) => LearningAnswer.parse((await anon.request("POST", "/api/learning/ask", { json: { question } })).json());
    const a = await ask(`How do I pass ${mission}?`);
    expect(a.mode).toBe("retrieval");
    expect(a.about.missions).toEqual([mission]);
    expect(a.seen?.answer).toContain(`${mission}: 2 attempts in 1 stream, 1 passed, 1 failed.`);
    expect(a.seen?.answer).toContain("Passing took about 5 min.");
    expect(a.seen?.answer).toContain("Failed most at the objective “Lose the cops” (1).");
    expect(a.seen?.answer).toContain("The result screen said: “Lamar died.” (1).");
    expect(a.seen?.sources[0]).toMatchObject({ observationId: passedId, channel: "StoryTeller", href: `/m/${passedId}` });

    const d = await ask("Why do I keep dying?");
    expect(d.seen?.answer).toMatch(/In the minute before WASTED \(\d+ times?\) SLOT1 saw: .*Crashing \(\d+\)/);
  });
});
