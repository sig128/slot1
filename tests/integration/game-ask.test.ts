import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearLearningCache } from "../../apps/api/src/routes/learning";
import { LearningAnswer, LearningAskAccess, LearningResponse } from "@slot1/contracts";
import { backfillKnowledgeTags, createIngestSession, createLocalBroadcaster, createLocalUser, insertObservation, updateSettings, type NewObservation } from "@slot1/db";
import { Browser, startHarness, type Harness } from "./harness";

/** One stream with entries, on a channel that's public (or not). Returns the entries' ids. */
async function stream(h: Harness, name: string, o: { channel: "public" | "private"; label: "live" | "test" }, entries: Pick<NewObservation, "type" | "description" | "rawText" | "origin">[]) {
  const user = await createLocalUser(h.ctx.db, name);
  const b = await createLocalBroadcaster(h.ctx.db, user.id, `${name.toLowerCase()}${randomBytes(2).toString("hex")}`, name);
  await updateSettings(h.ctx.db, b.id, { visibility: o.channel, publicAnalysis: o.channel === "public" });
  const s = await createIngestSession(h.ctx.db, b.id, o.label, `${name} plays`, "public", 1000);
  const ids: string[] = [];
  for (const e of entries) {
    const { observation } = await insertObservation(h.ctx.db, {
      broadcasterId: b.id,
      sessionId: s.id,
      sourceId: null,
      mediaStartMs: 1000,
      mediaEndMs: 1000,
      capturedAt: null,
      receivedAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      interpretation: "inferred",
      evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: 1000 }],
      model: null,
      modelConfidence: null,
      relatedEntities: [],
      ...e,
    });
    ids.push(observation.id);
  }
  return { broadcaster: b, session: s, ids };
}

const GUN_SHOP = { type: "visible_text" as const, description: "Sign reads AMMU-NATION over a gun store", rawText: "AMMU-NATION", origin: "ocr" as const };
const CHASE = { type: "movement" as const, description: "Police chase through Vinewood", rawText: null, origin: "video" as const };

describe("Ask SLOT1 about the game, from its own records", () => {
  let h: Harness;
  let anon: Browser;
  let gunShopId = "";
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
    const pub = await stream(h, "GunRunner", { channel: "public", label: "live" }, [GUN_SHOP, CHASE, { type: "combat", description: "Player shoots at two gang members near Grove Street", rawText: null, origin: "video" }]);
    gunShopId = pub.ids[0]!;
    // Neither of these counts: a private channel and a test stream.
    await stream(h, "Hidden", { channel: "private", label: "live" }, [GUN_SHOP, CHASE]);
    await stream(h, "Pattern", { channel: "public", label: "test" }, [GUN_SHOP]);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("sorts every entry into activities and places on the Learning page", async () => {
    const r = await read();
    // Only the public, non-test stream counts: one more of each.
    const delta = (k: string) => r.activities.find((a) => a.key === k)!.seen - before.activities.find((a) => a.key === k)!.seen;
    const place = (x: LearningResponse, name: string) => x.places.find((p) => p.name === name)?.seen ?? 0;
    expect(r.activities.find((a) => a.key === "buy_weapons")).toMatchObject({ category: "shops", categoryLabel: "Shops and services" });
    expect(delta("buy_weapons")).toBe(1);
    expect(delta("police_chase")).toBe(1);
    expect(delta("shootout")).toBe(1);
    expect(delta("heist")).toBe(0);
    expect(r.activities.length).toBeGreaterThan(70);
    expect(place(r, "Ammu-Nation") - place(before, "Ammu-Nation")).toBe(1);
    expect(place(r, "Vinewood") - place(before, "Vinewood")).toBe(1);
    expect(place(r, "Grove Street") - place(before, "Grove Street")).toBe(1);
  });

  it("answers from what it saw, with the moments, and says when it hasn't seen something", async () => {
    const a = LearningAnswer.parse((await anon.request("POST", "/api/learning/ask", { json: { question: "Where do I buy guns?" } })).json());
    expect(a.mode).toBe("retrieval");
    expect(a.general).toBeNull();
    expect(a.about.activities).toContain("Buying weapons (Ammu-Nation)");
    expect(a.seen?.answer).toMatch(/Buying weapons \(Ammu-Nation\): seen \d+ times? in \d+ streams?\. Places seen with it: Ammu-Nation \(\d+\)\./);
    expect(a.seen?.sources.map((s) => s.observationId)).toContain(gunShopId);
    expect(a.seen?.sources.find((s) => s.observationId === gunShopId)).toMatchObject({ channel: "GunRunner", href: `/m/${gunShopId}` });

    const none = LearningAnswer.parse((await anon.request("POST", "/api/learning/ask", { json: { question: "How do I fly a jet under the bridge?" } })).json());
    expect(none.seen).toBeNull();
    expect((await anon.request("POST", "/api/learning/ask", { json: { question: "x" } })).status).toBe(400);
  });

  it("tags entries saved before tagging existed", async () => {
    await h.ctx.db.query(`UPDATE observations SET tags = NULL WHERE id = $1`, [gunShopId]);
    expect(await backfillKnowledgeTags(h.ctx.db)).toBeGreaterThanOrEqual(1);
    const { rows } = await h.ctx.db.query(`SELECT tags FROM observations WHERE id = $1`, [gunShopId]);
    expect(rows[0].tags).toEqual(["act:buy_weapons", "place:Ammu-Nation"]);
  });
});

/** A text model that cites one real entry and one it made up. */
class MockAnthropic {
  server: Server;
  base = "";
  calls: { system: string; user: string }[] = [];
  reply: (user: string) => unknown = () => ({});
  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body) as { system: string; messages: { content: string }[] };
        this.calls.push({ system: j.system, user: j.messages[0]!.content });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(this.reply(j.messages[0]!.content)) }], usage: { input_tokens: 900, output_tokens: 120 } }));
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe("Ask SLOT1 about the game, with a text model", () => {
  let h: Harness;
  let ai: MockAnthropic;
  let gunShopId = "";

  beforeAll(async () => {
    ai = await new MockAnthropic().start();
    h = await startHarness({ VISION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test-key-0123456789", ANTHROPIC_VISION_MODEL: "claude-test", ANTHROPIC_BASE_URL: ai.base });
    gunShopId = (await stream(h, "ShopKeeper", { channel: "public", label: "live" }, [GUN_SHOP])).ids[0]!;
    ai.reply = () => ({
      seen: "SLOT1 saw an Ammu-Nation gun store once, on ShopKeeper's stream.",
      general: "Ammu-Nation stores sell weapons in Los Santos and Blaine County.",
      citedObservationIds: [gunShopId, randomUUID()],
    });
  });
  afterAll(async () => {
    await h?.close();
    await ai?.stop();
  });

  it("keeps what it saw (cited) apart from general knowledge, and drops made-up citations", async () => {
    const anon = new Browser(h);
    await anon.refreshCsrf();
    const a = LearningAnswer.parse((await anon.request("POST", "/api/learning/ask", { json: { question: "Where do I buy guns?" } })).json());
    expect(a).toMatchObject({
      mode: "model",
      seen: { answer: "SLOT1 saw an Ammu-Nation gun store once, on ShopKeeper's stream.", sources: [{ observationId: gunShopId, href: `/m/${gunShopId}` }] },
      general: "Ammu-Nation stores sell weapons in Los Santos and Blaine County.",
    });
    const call = ai.calls.at(-1)!;
    expect(call.system).toContain("game guide");
    expect(call.user).toContain(`[${gunShopId}]`);
    expect(call.user).toMatch(/Buying weapons \(Ammu-Nation\): seen \d+ times? in \d+ streams?\./);
    expect(call.user).toContain("<untrusted_question>\nWhere do I buy guns?\n</untrusted_question>");

    // A "seen" answer that cites nothing real isn't shown as seen.
    ai.reply = () => ({ seen: "SLOT1 saw it everywhere.", general: "Try Ammu-Nation.", citedObservationIds: [randomUUID()] });
    const b = LearningAnswer.parse((await anon.request("POST", "/api/learning/ask", { json: { question: "Where do I buy guns?" } })).json());
    expect(b.seen).toBeNull();
    expect(b.general).toBe("Try Ammu-Nation.");
  });
});

describe("Ask SLOT1 opens at 1,000 hours watched", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ SLOT1_ASK_OPENS_AT_HOURS: "1000" });
    clearLearningCache();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("shows the counter and refuses questions until then, except for admins", async () => {
    const anon = new Browser(h);
    await anon.refreshCsrf();
    const learning = LearningResponse.parse((await anon.get("/api/learning")).json());
    expect(learning.ask).toEqual({ open: false, opensAtHours: 1000 });
    expect(LearningAskAccess.parse((await anon.get("/api/learning/ask")).json())).toMatchObject({ open: false, adminOnly: false, opensAtHours: 1000 });
    const refused = await anon.request("POST", "/api/learning/ask", { json: { question: "Where do I buy guns?" } });
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: "not_open_yet" } });

    const admin = new Browser(h);
    const me = await admin.signInLocal("Learning Admin");
    await h.ctx.db.query(`UPDATE users SET is_operator = true WHERE id = $1`, [(me.user as { id: string }).id]);
    await admin.refreshCsrf();
    expect(LearningAskAccess.parse((await admin.get("/api/learning/ask")).json())).toMatchObject({ open: true, adminOnly: true });
    const ok = await admin.request("POST", "/api/learning/ask", { json: { question: "Where do I buy guns?" } });
    expect(ok.status).toBe(200);
  });
});
