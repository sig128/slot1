import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NowResponse } from "@slot1/contracts";
import {
  createIngestSession,
  createIngestSource,
  createLocalBroadcaster,
  createLocalUser,
  insertAsset,
  insertObservation,
  markPublishEnded,
  markPublishing,
  recordFrameReceived,
  setAnalysisState,
  setSourceSession,
  updateSettings,
  upsertConnection,
  upsertGrant,
  upsertSourceHealth,
  upsertTwitchBroadcaster,
  upsertTwitchUser,
  type NewObservation,
} from "@slot1/db";
import { storageKeys } from "@slot1/platform";
import { clearNowCache } from "../../apps/api/src/routes/now";
import { Browser, MockTwitch, startHarness, type Harness } from "./harness";

const JPEG = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=1", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);

interface Seeded {
  browser: Browser | null;
  broadcasterId: string;
  login: string;
  displayName: string;
  sessionId: string;
  sourceId: string;
}

/**
 * "Los Santos right now" against the real API and SQL: who is listed (public and live only),
 * what each one is doing (from real observation rows, in priority order), and that nothing of a
 * private stream ever reaches the response.
 */
describe("Los Santos right now", () => {
  let h: Harness;
  let mock: MockTwitch;
  let anon: Browser;

  /** A creator whose stream reaches SLOT1, with the privacy settings under test. */
  async function seedStream(
    name: string,
    o: { channel?: "public" | "private"; publicAnalysis?: boolean; session?: "public" | "private"; publishing?: boolean; label?: "live" | "test"; state?: "live_vision" | "stopped"; owner?: boolean } = {},
  ): Promise<Seeded> {
    // Only creators whose own view is checked sign in through the (rate-limited) sign-in route.
    let browser: Browser | null = null;
    let b: { id: string; login: string; displayName: string };
    if (o.owner) {
      browser = new Browser(h);
      b = (await signIn(browser, name)).broadcaster;
    } else {
      const user = await createLocalUser(h.ctx.db, name);
      const row = await createLocalBroadcaster(h.ctx.db, user.id, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16)}${randomBytes(2).toString("hex")}`, name);
      b = { id: row.id, login: row.login, displayName: row.display_name };
    }
    // A private channel can never have public analysis (the database refuses it).
    await updateSettings(h.ctx.db, b.id, { visibility: o.channel ?? "public", publicAnalysis: o.channel === "private" ? false : (o.publicAnalysis ?? true) });
    const label = o.label ?? "live";
    const source = await createIngestSource(h.ctx.db, { broadcasterId: b.id, name: "OBS", label, publishPath: `live/${randomBytes(6).toString("hex")}`, keyHash: randomBytes(32), keyHint: "abcd" });
    const session = await createIngestSession(h.ctx.db, b.id, label, `${name} in Los Santos`, o.session ?? "public", 5000);
    await setSourceSession(h.ctx.db, source.id, session.id);
    if (o.publishing ?? true) await markPublishing(h.ctx.db, source.id, null);
    await setAnalysisState(h.ctx.db, session.id, o.state ?? "live_vision", o.state === "stopped" ? "Analysis paused by the creator" : "Watching");
    await recordFrameReceived(h.ctx.db, session.id, 5000);
    const key = storageKeys.frame(b.id, session.id, source.id, 1000);
    const { bytes } = await h.ctx.storage.putBuffer(key, JPEG, "image/jpeg");
    const asset = await insertAsset(h.ctx.db, { broadcasterId: b.id, sessionId: session.id, sourceId: source.id, kind: "frame", storageKey: key, contentType: "image/jpeg", bytes, mediaPtsMs: 1000 });
    await upsertSourceHealth(h.ctx.db, source.id, { lastFrameAt: new Date(), lastFrameAssetId: asset.id, lastFramePtsMs: 1000, framesReceivedDelta: 1 });
    return { browser, broadcasterId: b.id, login: b.login, displayName: b.displayName, sessionId: session.id, sourceId: source.id };
  }

  /** Local sign-in, waiting out the per-address limit the rest of the suite may have used up. */
  async function signIn(b: Browser, name: string): Promise<{ broadcaster: { id: string; login: string; displayName: string } }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await b.signInLocal(name)) as { broadcaster: { id: string; login: string; displayName: string } };
      } catch (err) {
        if (attempt >= 3 || !/ 429 /.test((err as Error).message)) throw err;
        await new Promise((r) => setTimeout(r, 21_000));
      }
    }
  }

  async function observe(s: Seeded, agoMs: number, o: Pick<NewObservation, "type" | "description"> & Partial<NewObservation>) {
    const { observation } = await insertObservation(h.ctx.db, {
      broadcasterId: s.broadcasterId,
      sessionId: s.sessionId,
      sourceId: s.sourceId,
      mediaStartMs: 1000,
      mediaEndMs: 1000,
      capturedAt: null,
      receivedAt: new Date(Date.now() - agoMs).toISOString(),
      analyzedAt: new Date().toISOString(),
      origin: "video",
      interpretation: "inferred",
      evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: 1000 }],
      rawText: null,
      model: null,
      modelConfidence: null,
      relatedEntities: [],
      ...o,
    });
    return observation;
  }

  async function now(b: Browser = anon): Promise<{ body: NowResponse; raw: string; headers: Record<string, unknown> }> {
    clearNowCache(h.ctx);
    const r = await b.get("/api/now");
    expect(r.status).toBe(200);
    return { body: r.json<NowResponse>(), raw: r.body, headers: r.headers };
  }

  let driving: Seeded;
  let quiet: Seeded;
  let paused: Seeded;
  let test: Seeded;
  const hidden: Seeded[] = [];

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    h = await startHarness(mock.env());
    anon = new Browser(h);
    await anon.refreshCsrf();

    driving = await seedStream("Getaway Driver");
    await observe(driving, 10_000, { type: "environment", description: "Scene: Driving", origin: "video" });
    await observe(driving, 5000, { type: "mission_title", description: "Mission title on screen", origin: "ocr", interpretation: "directly_visible", rawText: "Go to the docks" });
    await observe(driving, 30_000, { type: "movement", description: "Likely police chase", origin: "video" });
    await observe(driving, 90_000, { type: "result_screen", description: "WASTED screen", origin: "ocr", interpretation: "directly_visible", rawText: "WASTED" });
    quiet = await seedStream("Quiet Cruiser");
    await observe(quiet, 120_000, { type: "environment", description: "Scene: On foot" });
    paused = await seedStream("Paused Player", { state: "stopped" });
    test = await seedStream("Bench Tester", { label: "test" });
    await observe(test, 3000, { type: "environment", description: "Scene: Menu or map" });

    // Never listed: a private channel, private analysis, a private session, a stream that ended.
    for (const [name, opts] of [
      ["Private Channel", { channel: "private", owner: true }],
      ["Private Analysis", { publicAnalysis: false }],
      ["Private Session", { session: "private", owner: true }],
      ["Already Ended", { publishing: false }],
    ] as const) {
      const s = await seedStream(name, opts);
      await observe(s, 2000, { type: "result_screen", description: `Secret heist of ${name}`, origin: "ocr", interpretation: "directly_visible", rawText: "MISSION PASSED" });
      hidden.push(s);
    }
  });

  afterAll(async () => {
    await h?.close();
    await mock?.stop();
  });

  it("lists public live streams only, each with what SLOT1 saw in the last minute", async () => {
    const { body, headers } = await now();
    const byLogin = new Map(body.streams.map((s) => [s.login, s]));
    expect([...byLogin.keys()].sort()).toEqual([driving.login, quiet.login, paused.login, test.login].sort());
    expect(body.emptyReason).toBeNull();
    expect(body.refreshMs).toBe(5000);
    expect(String(headers["cache-control"])).toBe("public, max-age=2");

    // Events beat the scene, the scene beats mission text; older than a minute doesn't count.
    const d = byLogin.get(driving.login)!;
    expect(d).toMatchObject({ kind: "slot1", sessionId: driving.sessionId, label: "live", watchPath: `/watch/${driving.login}`, twitchUrl: null, analysisState: "live_vision" });
    expect(d.activity).toMatchObject({ key: "police_chase", label: "Police chase", tier: "event", detail: "Likely police chase" });
    expect(d.recent.map((r) => r.description)).toEqual(["Mission title on screen", "Scene: Driving", "Likely police chase", "WASTED screen"]);
    // Quiet or paused streams say so instead of guessing.
    expect(byLogin.get(quiet.login)!.activity).toEqual({ key: "live", label: "Live", detail: "Nothing SLOT1 could name in the last minute", tier: "none", observedAt: null, observationId: null });
    expect(byLogin.get(paused.login)!.activity).toMatchObject({ key: "live", detail: "Analysis paused by the creator" });
    // A test stream stays labeled as one.
    expect(byLogin.get(test.login)).toMatchObject({ label: "test", activity: { key: "menu", tier: "scene" } });

    // The latest frame is a short-lived signed link that really serves the image.
    expect(d.thumbnailUrl).toMatch(/^\/api\/media\/f\//);
    const img = await anon.get(d.thumbnailUrl!);
    expect(img.status).toBe(200);
    expect(String(img.headers["content-type"])).toMatch(/image\/jpeg/);
  });

  it("never lets a private stream through, not even to its owner", async () => {
    for (const viewer of [anon, ...hidden.flatMap((s) => (s.browser ? [s.browser] : []))]) {
      const { raw } = await now(viewer);
      for (const s of hidden) {
        for (const secret of [s.login, s.displayName, s.sessionId, s.sourceId, `Secret heist of ${s.displayName}`]) expect(raw).not.toContain(secret);
      }
    }
  });

  it("shows Twitch-only directory channels as watch-only, never analyzed", async () => {
    const user = await upsertTwitchUser(h.ctx.db, "77001", "Highway Patrol", false);
    const b = await upsertTwitchBroadcaster(h.ctx.db, { ownerUserId: user.id, twitchUserId: "77001", login: "highwaypatrol", displayName: "Highway Patrol", avatarUrl: null });
    const grant = await upsertGrant(h.ctx.db, { role: "broadcaster", twitchUserId: "77001", twitchLogin: "highwaypatrol", scopes: [], accessTokenEnc: "x", refreshTokenEnc: null, keyId: "it1", expiresInSec: 3600 });
    await upsertConnection(h.ctx.db, b.id, grant.id);
    await updateSettings(h.ctx.db, b.id, { visibility: "public", directoryOptIn: true });
    // Twitch's live state as SLOT1's Helix poll caches it.
    const live = { state: "live", title: "Patrolling Vinewood", category: "Grand Theft Auto V", thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_highwaypatrol-960x540.jpg", viewerCount: 42, startedAt: new Date().toISOString(), streamId: "s1", refreshedAt: new Date().toISOString() };
    await h.ctx.redis.set("slot1:live:77001", JSON.stringify(live), "EX", 60);

    const { body } = await now();
    const t = body.streams.find((s) => s.login === "highwaypatrol")!;
    expect(t).toMatchObject({ kind: "twitch", sessionId: null, activity: null, analysisState: null, recent: [], viewerCount: 42, title: "Patrolling Vinewood", twitchUrl: "https://www.twitch.tv/highwaypatrol", thumbnailUrl: live.thumbnailUrl });
    // SLOT1 streams come first; Twitch-only channels after them.
    expect(body.streams.at(-1)!.login).toBe("highwaypatrol");

    // Offline on Twitch: not listed.
    await h.ctx.redis.set("slot1:live:77001", JSON.stringify({ ...live, state: "offline", viewerCount: null, thumbnailUrl: null }), "EX", 60);
    expect((await now()).body.streams.some((s) => s.login === "highwaypatrol")).toBe(false);
  });

  it("is computed once for everyone and cached briefly", async () => {
    clearNowCache(h.ctx);
    const a = (await anon.get("/api/now")).json<NowResponse>();
    const other = new Browser(h);
    const b = (await other.get("/api/now")).json<NowResponse>();
    expect(b.generatedAt).toBe(a.generatedAt);
  });

  it("says honestly when nobody is live", async () => {
    for (const s of [driving, quiet, paused, test]) await markPublishEnded(h.ctx.db, s.sourceId);
    const { body } = await now();
    expect(body.streams).toEqual([]);
    expect(body.emptyReason).toBe(
      `${h.ctx.config.capabilities.ingest.available ? "No creator is sending a public stream to SLOT1 right now." : "Streaming to SLOT1 isn't open yet."} None of the channels in the directory are live on Twitch.`,
    );
  });
});
