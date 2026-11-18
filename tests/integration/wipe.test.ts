import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminWipeResponse, LearningResponse } from "@slot1/contracts";
import {
  createIngestSession,
  createIngestSource,
  createLocalBroadcaster,
  createLocalUser,
  getSettings,
  insertAsset,
  insertObservation,
  insertTrainingFrame,
  markPublishing,
  updateSettings,
} from "@slot1/db";
import { runWipe } from "@slot1/services";
import { ADMIN_COOKIE, mintAdminLink } from "../../apps/api/src/lib/admin-session";
import { clearLearningCache } from "../../apps/api/src/routes/learning";
import { Browser, ORIGIN, startHarness, type Harness } from "./harness";

/**
 * Admin → Wipe data against the real API, SQL, Redis and storage: only an admin sees or starts it,
 * it needs the confirm word, it waits while someone is sending video, and it deletes what SLOT1
 * found, kept and learned, files included, while the stream, its channel, settings and stream key
 * stay. The hours-watched counter is back at 0 afterwards.
 */

async function adminBrowser(h: Harness): Promise<Browser> {
  const b = new Browser(h);
  await b.refreshCsrf();
  const { url } = await mintAdminLink(h.ctx);
  const used = await h.app.inject({
    method: "POST",
    url: "/api/admin/link",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ token: new URL(url).searchParams.get("token")! }).toString(),
  });
  const set = used.headers["set-cookie"];
  const c = (Array.isArray(set) ? set : [set]).find((x) => typeof x === "string" && x.startsWith(`${ADMIN_COOKIE}=`)) as string;
  b.cookie = [b.cookie, c.split(";")[0]].filter(Boolean).join("; ");
  return b;
}

describe("Admin → Wipe data", () => {
  let h: Harness;
  let admin: Browser;
  let anon: Browser;
  let broadcasterId: string;
  let sessionId: string;
  let frameKey: string;
  let trainingKey: string;
  let streamKeyId: string;

  beforeAll(async () => {
    h = await startHarness();
    anon = new Browser(h);
    await anon.refreshCsrf();
    admin = await adminBrowser(h);
    // Earlier test files share this database. The wipe keeps stream rows, so clear leftovers here
    // and the counts below are exact.
    await h.ctx.db.query(`DELETE FROM stream_sessions`);
    await h.ctx.db.query(`DELETE FROM models`);
    await h.ctx.db.query(`DELETE FROM dataset_versions`);
    await h.ctx.db.query(`DELETE FROM evidence_assets`);
    await h.ctx.db.query(`DELETE FROM library_items`);
    await h.ctx.db.query(`DELETE FROM project_media`);
    await h.ctx.db.query(`DELETE FROM edit_projects`);
    await h.ctx.db.query(`DELETE FROM media_sources WHERE kind <> 'live_ingest'`);
    await h.ctx.redis.del("slot1:admin:wipe");

    const user = await createLocalUser(h.ctx.db, "Wiper");
    const b = await createLocalBroadcaster(h.ctx.db, user.id, `wiper${randomBytes(3).toString("hex")}`, "Wiper");
    broadcasterId = b.id;
    await updateSettings(h.ctx.db, b.id, { visibility: "public", publicAnalysis: true });
    const source = await createIngestSource(h.ctx.db, {
      broadcasterId: b.id,
      name: "OBS",
      label: "live",
      publishPath: `wipe-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32),
      keyHint: "abcd",
    });
    streamKeyId = source.id;
    const s = await createIngestSession(h.ctx.db, b.id, "live", "Wiper plays", "public", 5000);
    sessionId = s.id;
    await h.ctx.db.query(`UPDATE stream_sessions SET analyzed_ms = $2 WHERE id = $1`, [s.id, 3 * 3_600_000]);
    await insertObservation(h.ctx.db, {
      broadcasterId: b.id,
      sessionId: s.id,
      sourceId: null,
      mediaStartMs: 1000,
      mediaEndMs: 1000,
      capturedAt: null,
      receivedAt: new Date().toISOString(),
      analyzedAt: new Date().toISOString(),
      origin: "ocr",
      interpretation: "directly_visible",
      evidence: [{ assetId: randomUUID(), kind: "frame", mediaPtsMs: 1000 }],
      rawText: "MISSION PASSED",
      model: null,
      modelConfidence: null,
      relatedEntities: [],
      type: "result_screen",
      description: "Result screen read",
    });
    frameKey = `b/${b.id}/s/${s.id}/src/${source.id}/frames/0000001000.jpg`;
    await insertAsset(h.ctx.db, {
      broadcasterId: b.id,
      sessionId: s.id,
      sourceId: source.id,
      kind: "frame",
      storageKey: frameKey,
      contentType: "image/jpeg",
      bytes: 7,
      mediaPtsMs: 1000,
    });
    await h.ctx.storage.putBuffer(frameKey, Buffer.from("a frame"), "image/jpeg");
    trainingKey = `b/${b.id}/s/${s.id}/training/${randomUUID()}.jpg`;
    await h.ctx.storage.putBuffer(trainingKey, Buffer.from("a training frame"), "image/jpeg");
    await insertTrainingFrame(h.ctx.db, {
      broadcasterId: b.id,
      sessionId: s.id,
      sourceId: source.id,
      sourceKind: "live_ingest",
      sourceLabel: "live",
      mediaPtsMs: 1000,
      storageKey: trainingKey,
      width: 16,
      height: 9,
      bytes: 16,
      priority: 0,
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  // The harness stores files on disk under STORAGE_FS_ROOT.
  const exists = (key: string) =>
    access(path.join(h.storageRoot, "storage", key))
      .then(() => true)
      .catch(() => false);

  it("is admin-only and shows what is stored", async () => {
    expect((await anon.get("/api/admin/wipe")).status).toBe(404);
    expect((await anon.request("POST", "/api/admin/wipe", { json: { confirm: "WIPE" } })).status).toBe(404);
    const r = AdminWipeResponse.parse((await admin.get("/api/admin/wipe")).json());
    expect(r.counts).toMatchObject({ streams: 1, findings: 1, trainingFrames: 1, hoursWatched: 3 });
    expect(r.status.state).toBe("idle");
    expect(r.liveVideo).toBe(0);
  });

  it("needs the confirm word, and waits while someone is sending video", async () => {
    const no = await admin.request("POST", "/api/admin/wipe", { json: { confirm: "wipe" } });
    expect(no.status).toBe(400);
    expect(no.json<{ error: { message: string } }>().error.message).toMatch(/Type WIPE/);

    // Frames arriving right now: wait. A key stuck on "publishing" with no frames doesn't block.
    await markPublishing(h.ctx.db, streamKeyId, null);
    await h.ctx.db.query(`UPDATE stream_sessions SET last_received_frame_at = now() WHERE id = $1`, [sessionId]);
    const live = await admin.request("POST", "/api/admin/wipe", { json: { confirm: "WIPE" } });
    expect(live.status).toBe(409);
    expect(live.json<{ error: { message: string } }>().error.message).toMatch(/sending video/);
    await h.ctx.db.query(`UPDATE stream_sessions SET last_received_frame_at = now() - interval '10 minutes' WHERE id = $1`, [sessionId]);
    expect(AdminWipeResponse.parse((await admin.get("/api/admin/wipe")).json()).liveVideo).toBe(0);
    expect(h.jobs.filter((j) => j.name === "wipe-data")).toHaveLength(0);
  });

  it("deletes the learning data and its files, and keeps the stream, channel and stream key", async () => {
    const res = await admin.request("POST", "/api/admin/wipe", { json: { confirm: "WIPE" } });
    expect(res.status).toBe(202);
    expect(AdminWipeResponse.parse(res.json()).status.state).toBe("queued");
    expect(h.jobs.filter((j) => j.name === "wipe-data")).toHaveLength(1);
    // A second request while one is queued is refused.
    expect((await admin.request("POST", "/api/admin/wipe", { json: { confirm: "WIPE" } })).status).toBe(409);

    expect(await exists(frameKey)).toBe(true);
    const done = await runWipe(h.ctx);
    expect(done.state).toBe("done");
    expect(done.deleted).toMatchObject({ streams: 1, findings: 1, trainingFrames: 1, hoursWatched: 3 });

    const after = AdminWipeResponse.parse((await admin.get("/api/admin/wipe")).json());
    expect(after.counts).toEqual({ streams: 1, findings: 0, files: 0, speech: 0, missions: 0, trainingFrames: 0, clips: 0, library: 0, models: 0, hoursWatched: 0 });
    expect(after.status.state).toBe("done");
    expect(await exists(frameKey)).toBe(false);
    expect(await exists(trainingKey)).toBe(false);
    const kept = await h.ctx.db.query<{ n: number; analyzed_ms: string }>(
      `SELECT count(*)::int AS n, coalesce(max(analyzed_ms), 0)::text AS analyzed_ms FROM stream_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(kept.rows[0]?.n).toBe(1);
    expect(kept.rows[0]?.analyzed_ms).toBe("0");

    // The channel, its settings and its stream key stay.
    expect((await getSettings(h.ctx.db, broadcasterId)).publicAnalysis).toBe(true);
    const key = await h.ctx.db.query(`SELECT count(*)::int AS n FROM media_sources WHERE id = $1`, [streamKeyId]);
    expect(key.rows[0].n).toBe(1);

    // The Learning page counts from zero again.
    clearLearningCache();
    const learning = LearningResponse.parse((await anon.get("/api/learning")).json());
    expect(learning.watched.hours).toBe(0);
    expect(learning.watched.streams).toBe(0);

    // Running it again finds nothing left and still finishes.
    expect((await runWipe(h.ctx)).state).toBe("done");
  });
});
