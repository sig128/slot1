import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminLearning, LearningResponse } from "@slot1/contracts";
import { upsertTwitchBroadcaster, upsertTwitchBroadcastSession, upsertTwitchUser } from "@slot1/db";
import { ADDED_WATCH_STATUS_KEY, LEARNING_PAUSED_KEY, LEARNING_SWITCH_KEY, PREVIEW_CHANNELS_KEY, watchAddedStreams, writeLearningSwitch } from "@slot1/services";
import { ADMIN_COOKIE, mintAdminLink } from "../../apps/api/src/lib/admin-session";
import { clearLearningCache } from "../../apps/api/src/routes/learning";
import { Browser, ORIGIN, startHarness, type Harness } from "./harness";

/**
 * Admin → Learning against the real API, SQL and Redis: only an admin sees or flips it, it is on
 * until an admin turns it off, the Learning page says so, and while it's off the featured-channel
 * watcher looks at nothing and ends the sessions it had open, once.
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

describe("Admin → Learning", () => {
  let h: Harness;
  let admin: Browser;
  let anon: Browser;

  beforeAll(async () => {
    h = await startHarness();
    anon = new Browser(h);
    await anon.refreshCsrf();
    admin = await adminBrowser(h);
    await h.ctx.redis.del(LEARNING_SWITCH_KEY, LEARNING_PAUSED_KEY);
  });
  afterAll(async () => {
    await h?.ctx.redis.del(LEARNING_SWITCH_KEY, LEARNING_PAUSED_KEY, PREVIEW_CHANNELS_KEY);
    await h?.close();
  });

  it("is admin-only: everyone else gets a plain 404 and can't flip it", async () => {
    expect((await anon.get("/api/admin/learning")).status).toBe(404);
    expect((await anon.request("PUT", "/api/admin/learning", { json: { on: true } })).status).toBe(404);
    expect(AdminLearning.parse((await admin.get("/api/admin/learning")).json()).on).toBe(true);
  });

  it("is on until an admin turns it off, and the Learning page says which", async () => {
    expect(AdminLearning.parse((await admin.get("/api/admin/learning")).json())).toEqual({ on: true, changedAt: null });
    clearLearningCache();
    expect(LearningResponse.parse((await anon.get("/api/learning")).json()).learningOn).toBe(true);

    expect((await admin.request("PUT", "/api/admin/learning", { json: { on: "yes" } })).status).toBe(400);
    const on = await admin.request("PUT", "/api/admin/learning", { json: { on: true } });
    expect(on.status).toBe(200);
    const value = AdminLearning.parse(on.json());
    expect(value.on).toBe(true);
    expect(value.changedAt).not.toBeNull();
    expect(AdminLearning.parse((await admin.get("/api/admin/learning")).json()).on).toBe(true);
    expect(LearningResponse.parse((await anon.get("/api/learning")).json()).learningOn).toBe(true);

    const off = AdminLearning.parse((await admin.request("PUT", "/api/admin/learning", { json: { on: false } })).json());
    expect(off.on).toBe(false);
    expect(LearningResponse.parse((await anon.get("/api/learning")).json()).learningOn).toBe(false);
  });

  it("while off, the watcher looks at nothing and ends the featured sessions it had open, once", async () => {
    const login = `paused${randomBytes(3).toString("hex")}`;
    const twitchId = String(700_000 + Math.floor(Math.random() * 99_999));
    const owner = await upsertTwitchUser(h.ctx.db, twitchId, login, false);
    const b = await upsertTwitchBroadcaster(h.ctx.db, { ownerUserId: owner.id, twitchUserId: twitchId, login, displayName: login, avatarUrl: null });
    const session = await upsertTwitchBroadcastSession(h.ctx.db, {
      broadcasterId: b.id,
      twitchStreamId: `stream-${login}`,
      startedAt: new Date().toISOString(),
      title: "GTA",
      category: "Grand Theft Auto V",
      visibility: "public",
    });
    await h.ctx.redis.set(PREVIEW_CHANNELS_KEY, JSON.stringify([login]));
    await h.ctx.redis.set(ADDED_WATCH_STATUS_KEY(login), "{}", "EX", 180);
    await writeLearningSwitch(h.ctx.redis, false);

    const result = await watchAddedStreams(h.ctx);
    expect(result).toMatchObject({ watched: 0, learned: 0 });
    const ended = await h.ctx.db.query<{ ended_at: Date | null }>(`SELECT ended_at FROM stream_sessions WHERE id = $1`, [session.id]);
    expect(ended.rows[0]!.ended_at).not.toBeNull();
    expect(await h.ctx.redis.get(ADDED_WATCH_STATUS_KEY(login))).toBeNull();
    expect(await h.ctx.redis.get(LEARNING_PAUSED_KEY)).not.toBeNull();

    // Done once: a session that opens later (a creator sending video, say) is left alone.
    const again = await upsertTwitchBroadcastSession(h.ctx.db, {
      broadcasterId: b.id,
      twitchStreamId: `stream-${login}-2`,
      startedAt: new Date().toISOString(),
      title: "GTA",
      category: "Grand Theft Auto V",
      visibility: "public",
    });
    await watchAddedStreams(h.ctx);
    const still = await h.ctx.db.query<{ ended_at: Date | null }>(`SELECT ended_at FROM stream_sessions WHERE id = $1`, [again.id]);
    expect(still.rows[0]!.ended_at).toBeNull();

    // Any change starts over: turning it on clears the marker.
    await writeLearningSwitch(h.ctx.redis, true);
    expect(await h.ctx.redis.get(LEARNING_PAUSED_KEY)).toBeNull();
  });
});
