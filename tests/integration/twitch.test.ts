import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLiveClip } from "../../apps/worker/src/jobs/clips";
import { handleChatCommand } from "../../apps/worker/src/jobs/chat";
import { processEventSub } from "../../apps/worker/src/jobs/eventsub";
import { validateGrants } from "../../apps/worker/src/jobs/maintenance";
import { getBotGrant, getGrant } from "@slot1/db";
import { computeEventSubSignature } from "@slot1/twitch";
import { Browser, EVENTSUB_SECRET, MockTwitch, startHarness, type Harness } from "./harness";

/**
 * SLOT1's real OAuth, Helix, EventSub, bot and clip code against a local mock of Twitch's
 * endpoints. This proves SLOT1's side of each flow; it is not a test of Twitch itself.
 */
const CREATOR = { id: "1001", login: "nightcrew", displayName: "NightCrew", scopes: ["channel:bot", "clips:edit"] };
const BOT = { id: "2002", login: "slot1bot", displayName: "SLOT1 Bot", scopes: ["user:read:chat", "user:write:chat", "user:bot"] };
const VIEWER = { id: "3003", login: "someviewer" };

describe("Twitch integration against a mock Twitch", () => {
  let mock: MockTwitch;
  let h: Harness;
  let creator: Browser;

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    mock.addUser(CREATOR);
    mock.addUser(BOT);
    h = await startHarness({ ...mock.env(), SLOT1_BOT_TWITCH_LOGIN: BOT.login, SLOT1_OPERATOR_TWITCH_LOGINS: CREATOR.login });
    creator = new Browser(h);
  });
  afterAll(async () => {
    await h?.close();
    await mock?.stop();
  });

  function webhook(type: string, event: unknown, opts: { id?: string; ts?: string; secret?: string; messageType?: string; challenge?: string } = {}) {
    const id = opts.id ?? randomUUID();
    const ts = opts.ts ?? new Date().toISOString();
    const body = JSON.stringify({
      subscription: { id: randomUUID(), type, version: "1", status: "enabled", condition: { broadcaster_user_id: CREATOR.id }, created_at: ts },
      ...(opts.challenge ? { challenge: opts.challenge } : { event }),
    });
    return h.app.inject({
      method: "POST",
      url: "/api/twitch/eventsub",
      payload: body,
      headers: {
        "content-type": "application/json",
        "twitch-eventsub-message-id": id,
        "twitch-eventsub-message-timestamp": ts,
        "twitch-eventsub-message-signature": computeEventSubSignature(opts.secret ?? EVENTSUB_SECRET, id, ts, body),
        "twitch-eventsub-message-type": opts.messageType ?? "notification",
        "twitch-eventsub-subscription-type": type,
      },
    });
  }

  it("binds OAuth state to the browser that started the flow", async () => {
    await creator.refreshCsrf();
    const start = await creator.get("/api/auth/twitch/start");
    expect(start.status).toBe(302);
    const loc = new URL(String(start.headers.location));
    expect(`${loc.origin}${loc.pathname}`).toBe(`${mock.base}/oauth2/authorize`);
    expect(loc.searchParams.get("scope")!.split(" ").sort()).toEqual(["channel:bot", "clips:edit"]);
    const state = loc.searchParams.get("state")!;

    const attacker = new Browser(h);
    await attacker.refreshCsrf();
    const stolen = await attacker.get(`/api/auth/twitch/callback?code=${mock.issueCode(CREATOR.id)}&state=${encodeURIComponent(state)}`);
    expect(stolen.status).toBe(400);
    expect((await creator.get(`/api/auth/twitch/callback?code=${mock.issueCode(CREATOR.id)}&state=forged-state`)).status).toBe(400);
    expect(mock.requests.filter((r) => r === "POST /oauth2/token")).toHaveLength(0);

    const ok = await creator.get(`/api/auth/twitch/callback?code=${mock.issueCode(CREATOR.id)}&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(302);
    expect(String(ok.headers.location)).toMatch(/twitch=connected/);
    // A state is single-use.
    expect((await creator.get(`/api/auth/twitch/callback?code=${mock.issueCode(CREATOR.id)}&state=${encodeURIComponent(state)}`)).status).toBe(400);

    // Signing in rotates the session and its CSRF token.
    const me = await creator.refreshCsrf();
    expect(me.broadcaster).toMatchObject({ login: CREATOR.login, displayName: CREATOR.displayName });
    expect(h.jobs.some((j) => j.name === "eventsub-reconcile")).toBe(true);
  });

  it("stores Twitch tokens only encrypted", async () => {
    const { rows } = await h.ctx.db.query<{ access_token_enc: string; refresh_token_enc: string }>(`SELECT access_token_enc, refresh_token_enc FROM encrypted_grants WHERE twitch_user_id = $1`, [CREATOR.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.access_token_enc).toMatch(/^v1\.it1\./);
    expect(rows[0]!.access_token_enc).not.toMatch(/access-1001/);
    expect(rows[0]!.refresh_token_enc).not.toMatch(/refresh-1001/);
  });

  it("links the bot account only for an operator and only with the configured login", async () => {
    // Studio offers the operator the linking step; it isn't done yet.
    const before = (await creator.get("/api/studio")).json();
    expect(before.readiness.find((s: { id: string }) => s.id === "bot_ready")).toMatchObject({ status: "todo", action: { label: "Link bot account" } });
    const start = await creator.get("/api/auth/twitch/start?role=bot");
    expect(start.status).toBe(302);
    const loc = new URL(String(start.headers.location));
    expect(loc.searchParams.get("force_verify")).toBe("true");
    // The creator's own account is not the bot account.
    const wrong = await creator.get(`/api/auth/twitch/callback?code=${mock.issueCode(CREATOR.id)}&state=${encodeURIComponent(loc.searchParams.get("state")!)}`);
    expect(String(wrong.headers.location)).toMatch(/bot=wrong_account/);
    expect(await getBotGrant(h.ctx.db)).toBeNull();

    const again = new URL(String((await creator.get("/api/auth/twitch/start?role=bot")).headers.location));
    const linked = await creator.get(`/api/auth/twitch/callback?code=${mock.issueCode(BOT.id)}&state=${encodeURIComponent(again.searchParams.get("state")!)}`);
    expect(String(linked.headers.location)).toMatch(/bot=linked/);
    expect((await getBotGrant(h.ctx.db))?.twitch_login).toBe(BOT.login);

    const outsider = new Browser(h);
    await outsider.signInLocal("Not an operator");
    expect((await outsider.get("/api/auth/twitch/start?role=bot")).status).toBe(403);
  });

  it("verifies EventSub signatures, answers challenges and drops duplicate deliveries", async () => {
    const challenge = await webhook("stream.online", null, { messageType: "webhook_callback_verification", challenge: "pogchamp-123" });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.headers["content-type"]).toMatch(/text\/plain/);
    expect(challenge.body).toBe("pogchamp-123");

    expect((await webhook("stream.online", {}, { secret: "wrong-secret-0123456789" })).statusCode).toBe(403);
    expect((await webhook("stream.online", {}, { ts: new Date(Date.now() - 11 * 60_000).toISOString() })).statusCode).toBe(403);

    const online = { id: "stream-1", broadcaster_user_id: CREATOR.id, broadcaster_user_login: CREATOR.login, broadcaster_user_name: CREATOR.displayName, type: "live", started_at: new Date().toISOString() };
    const id = randomUUID();
    const before = h.jobs.length;
    expect((await webhook("stream.online", online, { id })).statusCode).toBe(204);
    expect((await webhook("stream.online", online, { id })).statusCode).toBe(204);
    const queued = h.jobs.slice(before).filter((j) => j.name === "eventsub-process");
    expect(queued).toHaveLength(1);
    await processEventSub(h.ctx, queued[0]!.data as Parameters<typeof processEventSub>[1]);

    const watch = (await creator.get(`/api/channels/${CREATOR.login}/watch`)).json();
    expect(watch.session.broadcastState).toBe("live");
    // Broadcast status never implies vision: no video source is connected.
    expect(watch.session.analysis.state).not.toBe("live_vision");
    // No video input, so no gameplay observations: only the Twitch fact itself.
    const obs = (await creator.get(`/api/sessions/${watch.session.id}/observations`)).json<{ observations: { origin: string; type: string }[] }>().observations;
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.every((o) => o.origin === "twitch")).toBe(true);
  });

  it("ignores ordinary chat and queues only commands", async () => {
    const before = h.jobs.length;
    const chat = (text: string) => ({
      broadcaster_user_id: CREATOR.id, broadcaster_user_login: CREATOR.login, chatter_user_id: VIEWER.id, chatter_user_login: VIEWER.login,
      chatter_user_name: VIEWER.login, message_id: randomUUID(), message: { text }, badges: [],
    });
    await webhook("channel.chat.message", chat("hello everyone"));
    await webhook("channel.chat.message", chat("!slot1 status"));
    const queued = h.jobs.slice(before);
    expect(queued.map((j) => j.name)).toEqual(["handle-command"]);
  });

  it("answers a chat command once, as the bot account, with honest vision status", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { botEnabled: true } })).status).toBe(200);
    const messageId = randomUUID();
    const event = {
      broadcaster_user_id: CREATOR.id, broadcaster_user_login: CREATOR.login, chatter_user_id: VIEWER.id, chatter_user_login: VIEWER.login,
      chatter_user_name: VIEWER.login, message_id: messageId, message: { text: "!slot1 now" }, badges: [],
    };
    await handleChatCommand(h.ctx, { messageId: randomUUID(), event });
    await handleChatCommand(h.ctx, { messageId: randomUUID(), event }); // redelivery of the same chat message
    expect(mock.chat).toHaveLength(1);
    expect(mock.chat[0]).toMatchObject({ broadcasterId: CREATOR.id, senderId: BOT.id });
    expect(mock.chat[0]!.message).toMatch(/vision isn't connected/i);
    const audit = await h.ctx.db.query(`SELECT decision FROM bot_command_audit WHERE message_id = $1`, [messageId]);
    expect(audit.rows).toEqual([{ decision: "answered" }]);
  });

  it("creates a clip only after Twitch confirms it exists", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { clipPermission: "everyone" } })).status).toBe(200);
    // A different viewer: the first one is still inside the per-user cooldown.
    const event = {
      broadcaster_user_id: CREATOR.id, broadcaster_user_login: CREATOR.login, chatter_user_id: "3004", chatter_user_login: "otherviewer",
      chatter_user_name: "otherviewer", message_id: randomUUID(), message: { text: "!slot1 clip" }, badges: [],
    };
    const before = h.jobs.length;
    await handleChatCommand(h.ctx, { messageId: randomUUID(), event });
    const job = h.jobs.slice(before).find((j) => j.name === "create-live-clip");
    expect(job).toBeTruthy();
    expect(mock.chat.at(-1)!.message).toMatch(/Clip requested/);
    await createLiveClip(h.ctx, job!.data as { clipJobId: string });
    const { rows } = await h.ctx.db.query<{ state: string; clip_url: string | null; media_state: string }>(`SELECT state, clip_url, media_state FROM clip_jobs WHERE id = $1`, [(job!.data as { clipJobId: string }).clipJobId]);
    expect(rows[0]!.state).toBe("ready");
    expect(rows[0]!.clip_url).toMatch(/^https:\/\/clips\.twitch\.tv\/MockClip/);
    // Clip analysis needs a separate permission the creator didn't grant: it says so instead of pretending.
    expect(rows[0]!.media_state).toBe("missing_scope");
  });

  it("fails a clip without a link when Twitch refuses it", async () => {
    mock.clipsDisabled = true;
    const r = await creator.request("POST", "/api/clips", { json: { sessionId: (await creator.get(`/api/channels/${CREATOR.login}/watch`)).json().session.id, kind: "twitch_live", idempotencyKey: "it-clip-disabled-1" } });
    expect(r.status).toBe(200);
    const job = h.jobs.filter((j) => j.name === "create-live-clip").at(-1)!;
    await createLiveClip(h.ctx, job.data as { clipJobId: string });
    const { rows } = await h.ctx.db.query<{ state: string; clip_url: string | null; error_code: string | null; error_message: string | null }>(
      `SELECT state, clip_url, error_code, error_message FROM clip_jobs WHERE id = $1`,
      [(job.data as { clipJobId: string }).clipJobId],
    );
    expect(rows[0]).toMatchObject({ state: "failed", clip_url: null, error_code: "clips_disabled" });
    expect(rows[0]!.error_message).toMatch(/clipping may be disabled/);
    mock.clipsDisabled = false;
  });

  it("refreshes an invalid token and disconnects safely when the refresh token is revoked", async () => {
    const grant = (await getGrant(h.ctx.db, "broadcaster", CREATOR.id))!;
    const access = h.ctx.cipher.decrypt(grant.access_token_enc);
    mock.invalidAccess.add(access);
    const first = await validateGrants(h.ctx);
    expect(first.refreshed).toBeGreaterThanOrEqual(1);
    const refreshed = (await getGrant(h.ctx.db, "broadcaster", CREATOR.id))!;
    expect(h.ctx.cipher.decrypt(refreshed.access_token_enc)).not.toBe(access);
    expect(refreshed.status).toBe("active");

    mock.invalidAccess.add(h.ctx.cipher.decrypt(refreshed.access_token_enc));
    mock.revokedRefresh.add(h.ctx.cipher.decrypt(refreshed.refresh_token_enc!));
    const second = await validateGrants(h.ctx);
    expect(second.revoked).toBeGreaterThanOrEqual(1);
    expect((await getGrant(h.ctx.db, "broadcaster", CREATOR.id))!.status).toBe("revoked");
    const studio = (await creator.get("/api/studio")).json();
    expect(studio.readiness.find((s: { id: string }) => s.id === "twitch_connected").status).not.toBe("done");
  });

  it("revokes tokens at Twitch when the creator disconnects", async () => {
    mock.revoked.length = 0;
    const r = await creator.request("POST", "/api/studio/twitch/disconnect");
    expect(r.status).toBe(200);
    expect(mock.revoked.length).toBeGreaterThanOrEqual(1);
    expect((await getGrant(h.ctx.db, "broadcaster", CREATOR.id))!.status).toBe("revoked");
    const conn = await h.ctx.db.query<{ status: string }>(`SELECT c.status FROM broadcaster_connections c JOIN broadcasters b ON b.id = c.broadcaster_id WHERE b.twitch_user_id = $1`, [CREATOR.id]);
    expect(conn.rows[0]!.status).not.toBe("active");
  });
});
