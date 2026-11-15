import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearLearningCache } from "../../apps/api/src/routes/learning";
import { LearningAnswer, LearningResponse, type ObservationType, type RelatedEntity } from "@slot1/contracts";
import { createIngestSession, createLocalBroadcaster, createLocalUser, insertObservation, updateSettings } from "@slot1/db";
import { Browser, startHarness, type Harness } from "./harness";

/** A made-up word, new every run (the test database keeps earlier runs). */
const word = () =>
  Array.from(randomBytes(6))
    .map((x) => String.fromCharCode(97 + (x % 26)))
    .join("");

describe("everything SLOT1 named, with no fixed list", () => {
  let h: Harness;
  let anon: Browser;
  const thing = `${word()} statue`;
  const objective = `Find the ${word()} crate`;
  let thingId = "";

  beforeAll(async () => {
    h = await startHarness();
    anon = new Browser(h);
    await anon.refreshCsrf();
    const user = await createLocalUser(h.ctx.db, "Namer");
    const b = await createLocalBroadcaster(h.ctx.db, user.id, `namer${randomBytes(2).toString("hex")}`, "Namer");
    await updateSettings(h.ctx.db, b.id, { visibility: "public", publicAnalysis: true });
    const s = await createIngestSession(h.ctx.db, b.id, "live", "Namer plays", "public", 1000);
    const add = async (type: ObservationType, origin: "ocr" | "video", text: string, entities: RelatedEntity[] = []) =>
      (
        await insertObservation(h.ctx.db, {
          broadcasterId: b.id,
          sessionId: s.id,
          sourceId: null,
          mediaStartMs: 1000,
          mediaEndMs: 1000,
          capturedAt: null,
          receivedAt: new Date().toISOString(),
          analyzedAt: new Date().toISOString(),
          interpretation: "directly_visible",
          evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: 1000 }],
          model: null,
          modelConfidence: null,
          relatedEntities: entities,
          type,
          origin,
          description: origin === "ocr" ? `On-screen text: “${text}”` : text,
          rawText: origin === "ocr" ? text : null,
        })
      ).observation.id;
    thingId = await add("landmark", "video", `A giant ${thing} in a park`, [{ id: `item:${thing}`, kind: "item", label: thing, certainty: "visible" }]);
    await add("environment", "video", "Someone stands by it", [{ id: "item:x", kind: "item", label: "something", certainty: "uncertain" }]);
    await add("objective_text", "ocr", objective);
    await add("place_name", "ocr", "BATI 801");
    await add("visible_text", "ocr", "Combat Pistol");
  });
  afterAll(async () => {
    await h?.close();
  });

  it("lists every name it saw, sorted by kind, with the moment", async () => {
    clearLearningCache();
    const r = LearningResponse.parse((await anon.get("/api/learning")).json());
    const find = (label: string) => r.named.find((x) => x.label.toLowerCase() === label.toLowerCase());
    expect(find(thing)).toMatchObject({ kind: "item", seen: 1, streams: 1, href: `/m/${thingId}` });
    expect(find(objective)).toMatchObject({ kind: "objective" });
    expect(find("Bati 801")).toMatchObject({ kind: "vehicle" });
    expect(find("Combat Pistol")).toMatchObject({ kind: "weapon" });
    // Uncertain names stay out, and a car's name never becomes a place.
    expect(find("something")).toBeUndefined();
    expect(r.places.find((p) => p.name.toLowerCase() === "bati 801")).toBeUndefined();
    expect(r.namedTotal).toBeGreaterThanOrEqual(4);
  });

  it("answers about a named thing with its moment", async () => {
    const a = LearningAnswer.parse((await anon.request("POST", "/api/learning/ask", { json: { question: `Where is the ${thing}?` } })).json());
    expect(a.about.named.map((x) => x.toLowerCase())).toContain(thing);
    expect(a.seen?.answer).toMatch(new RegExp(`${thing} \\(item\\): seen 1 time in 1 stream\\.`, "i"));
    expect(a.seen?.sources.map((x) => x.observationId)).toContain(thingId);
  });
});
