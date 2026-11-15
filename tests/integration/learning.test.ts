import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LearningResponse, type LearningSkill } from "@slot1/contracts";
import { createIngestSession, createLocalBroadcaster, createLocalUser, insertObservation, updateSettings, type NewObservation } from "@slot1/db";
import { clearLearningCache } from "../../apps/api/src/routes/learning";
import { Browser, startHarness, type Harness } from "./harness";

/**
 * The Learning page's numbers against the real API and SQL: only public streams count as watched,
 * TEST streams and private ones never do, and caught moments follow the "Right now" rules.
 */
describe("What SLOT1 learned", () => {
  let h: Harness;
  let anon: Browser;

  async function stream(name: string, o: { channel: "public" | "private"; label: "live" | "test"; hours: number }) {
    const user = await createLocalUser(h.ctx.db, name);
    const b = await createLocalBroadcaster(h.ctx.db, user.id, `${name.toLowerCase()}${randomBytes(2).toString("hex")}`, name);
    await updateSettings(h.ctx.db, b.id, { visibility: o.channel, publicAnalysis: o.channel === "public" });
    const s = await createIngestSession(h.ctx.db, b.id, o.label, `${name} plays`, "public", 5000);
    await h.ctx.db.query(`UPDATE stream_sessions SET analyzed_ms = $2 WHERE id = $1`, [s.id, o.hours * 3_600_000]);
    const observe = (x: Pick<NewObservation, "type" | "description"> & Partial<NewObservation>) =>
      insertObservation(h.ctx.db, {
        broadcasterId: b.id,
        sessionId: s.id,
        sourceId: null,
        mediaStartMs: 1000,
        mediaEndMs: 1000,
        capturedAt: null,
        receivedAt: new Date().toISOString(),
        analyzedAt: new Date().toISOString(),
        origin: "video",
        interpretation: "inferred",
        evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: 1000 }],
        rawText: null,
        model: null,
        modelConfidence: null,
        relatedEntities: [],
        ...x,
      });
    await observe({ type: "result_screen", description: "Result screen read", rawText: "MISSION PASSED", origin: "ocr", interpretation: "directly_visible" });
    await observe({ type: "environment", description: "Scene: driving" });
    await observe({ type: "movement", description: "Police chase through Vinewood" });
    await observe({ type: "mission_title", description: "Mission title read", rawText: "The Long Stretch", origin: "ocr" });
    const rejected = await observe({ type: "result_screen", description: "Result screen read", rawText: "WASTED", origin: "ocr" });
    await h.ctx.db.query(`UPDATE observations SET review_status = 'rejected' WHERE id = $1`, [rejected.observation.id]);
    await observe({ type: "chat_message", description: "Chat said WASTED lol", rawText: "WASTED", origin: "twitch" });
    // What was said, in two languages.
    const said = (lang: string, text: string) =>
      observe({ type: "dialogue", description: `Said (${lang}): “${text}”`, rawText: text, origin: "audio", evidence: [{ assetId: randomUUID(), kind: "transcript", mediaPtsMs: 1000 }] });
    await said("Turkish", "Polis geliyor");
    await said("Turkish", "Kaçın!");
    await said("Norwegian", "Hei alle sammen");
  }
  const read = async () => {
    clearLearningCache();
    return LearningResponse.parse((await anon.get("/api/learning")).json());
  };
  const skill = (r: LearningResponse, id: string): LearningSkill => r.skills.find((s) => `${s.group}:${s.key}` === id)!;

  beforeAll(async () => {
    h = await startHarness();
    anon = new Browser(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("counts public streams only, and moments by the Right now rules", async () => {
    const before = await read();
    await stream("PublicRacer", { channel: "public", label: "live", hours: 2 });
    await stream("PrivateRacer", { channel: "private", label: "live", hours: 5 });
    await stream("TestPattern", { channel: "public", label: "test", hours: 3 });
    const after = await read();

    expect(after.watched.streams - before.watched.streams).toBe(1);
    expect(after.watched.channels - before.watched.channels).toBe(1);
    expect(Math.round((after.watched.hours - before.watched.hours) * 10) / 10).toBe(2);
    // Mission passed, driving, chase and the mission title; not the rejected or the Twitch-side WASTED.
    expect(after.watched.caught - before.watched.caught).toBe(4);
    expect(skill(after, "event:mission_passed").seen! - skill(before, "event:mission_passed").seen!).toBe(1);
    expect(skill(after, "scene:driving").seen! - skill(before, "scene:driving").seen!).toBe(1);
    expect(skill(after, "event:police_chase").seen! - skill(before, "event:police_chase").seen!).toBe(1);
    expect(skill(after, "event:wasted").seen).toBe(skill(before, "event:wasted").seen);
    expect(skill(after, "box:minimap")).toMatchObject({ seen: null, score: null });
    // Lines heard, by language: only the public stream's three.
    expect(after.heard.lines - before.heard.lines).toBe(3);
    const lang = (r: LearningResponse, name: string) => r.heard.languages.find((l) => l.name === name)?.lines ?? 0;
    expect(lang(after, "Turkish") - lang(before, "Turkish")).toBe(2);
    expect(lang(after, "Norwegian") - lang(before, "Norwegian")).toBe(1);
  });

  it("lists every class of the GTA taxonomy as a skill and is public", async () => {
    const res = await anon.get("/api/learning");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("public");
    const r = LearningResponse.parse(res.json());
    expect(r.skills.filter((s) => s.group === "event")).toHaveLength(10);
    expect(r.skills.filter((s) => s.group === "scene")).toHaveLength(8);
    expect(r.skills.filter((s) => s.group === "box")).toHaveLength(11);
  });
});
