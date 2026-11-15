import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminChatResponse, ChatRoomResponse, type ChatMessage } from "@slot1/contracts";
import { clearPreviewCache } from "../../apps/api/src/lib/preview-channels";
import { appendChatMessage, recentChatMessages } from "../../apps/api/src/lib/chat";
import { Browser, MockTwitch, ORIGIN, readSse, startHarness, type Harness } from "./harness";

/**
 * SLOT1 chat against the real API, SQL and Redis with a mock Twitch: which channels have a chat,
 * signing in only to chat, posting rules, the bot's answers, live delivery, and moderation.
 */
const OWNER = { id: "6001", login: "chatowner", displayName: "ChatOwner", scopes: ["channel:bot", "clips:edit"] };
const VIEWER = { id: "6002", login: "chatfan", displayName: "ChatFan", scopes: [] };
const OTHER = { id: "6003", login: "otherfan", displayName: "OtherFan", scopes: [] };
const VADER = { id: "6004", login: "vader", displayName: "Vader", scopes: [] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SLOT1 chat", () => {
  let mock: MockTwitch;
  let h: Harness;
  let owner: Browser;
  let viewer: Browser;
  let other: Browser;
  let visitor: Browser;

  async function signIn(b: Browser, userId: string, role: "viewer" | "broadcaster", returnTo = "/watch/vader") {
    await b.refreshCsrf();
    const start = await b.get(`/api/auth/twitch/start?role=${role}&returnTo=${encodeURIComponent(returnTo)}`);
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cb = await b.get(`/api/auth/twitch/callback?code=${mock.issueCode(userId)}&state=${encodeURIComponent(state)}`);
    await b.refreshCsrf();
    return String(cb.headers.location);
  }
  const room = async (b: Browser, login = "vader") => ChatRoomResponse.parse((await b.get(`/api/chat/${login}`)).json());
  const post = (b: Browser, text: string, login = "vader") => b.request("POST", `/api/chat/${login}/messages`, { json: { text } });
  const problem = (res: { json: <T>() => T }) => res.json<{ error: { message: string } }>().error.message;
  async function botReplyTo(m: ChatMessage, login = "vader"): Promise<ChatMessage> {
    // Straight from Redis: polling the API would run into its per-address rate limit.
    for (let i = 0; i < 40; i++) {
      const found = (await recentChatMessages(h.ctx.redis, login)).find((x) => x.kind === "bot" && x.replyTo?.id === m.id);
      if (found) return found;
      await sleep(100);
    }
    throw new Error(`no bot reply to "${m.text}"`);
  }

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    for (const u of [OWNER, VIEWER, OTHER, VADER]) mock.addUser(u);
    mock.liveStreams.set("vader", { title: "SUNDAY STREAM - ROLEPLAY", game: "Grand Theft Auto V", viewers: 1234 });
    mock.followers.set(VADER.id, 512345);
    h = await startHarness({ ...mock.env(), SLOT1_OPERATOR_TWITCH_LOGINS: OWNER.login });
    await h.ctx.redis.del("slot1:admin:preview-channels", "slot1:chat:room:vader", "slot1:chat:room:chatowner");
    clearPreviewCache();
    owner = new Browser(h);
    viewer = new Browser(h);
    other = new Browser(h);
    visitor = new Browser(h);
    await visitor.refreshCsrf();
    // The operator's Twitch connection is what follower totals are read with.
    await signIn(owner, OWNER.id, "broadcaster", "/studio");
  });
  afterAll(async () => {
    await h?.close();
    await mock?.stop();
  });

  it("is open on featured channels and SLOT1 channels, not on any pasted link", async () => {
    const r = await room(visitor);
    expect(r).toMatchObject({ room: "vader", displayName: "Vader" });
    expect(r.viewer).toMatchObject({ signedIn: false, canPost: false, blocked: "sign_in", canModerate: false });
    expect(r.commands).toContain("!slot1 now");
    expect((await visitor.get("/api/chat/someone_else")).status).toBe(404);
    expect((await post(visitor, "hi")).status).toBe(401);
  });

  it("signs a viewer in to chat with identity only: no channel, no permissions kept", async () => {
    const back = await signIn(viewer, VIEWER.id, "viewer");
    expect(back).toBe(`${ORIGIN}/watch/vader?twitch=signed_in`);
    const { rows } = await h.ctx.db.query(
      `SELECT (SELECT count(*) FROM broadcasters WHERE twitch_user_id = $1)::int AS b, (SELECT count(*) FROM encrypted_grants WHERE twitch_user_id = $1)::int AS g`,
      [VIEWER.id],
    );
    expect(rows[0]).toEqual({ b: 0, g: 0 });
    expect((await room(viewer)).viewer).toMatchObject({ signedIn: true, name: "ChatFan", canPost: true, blocked: null, canModerate: false });
    await signIn(other, OTHER.id, "viewer");
  });

  it("posts for everyone to read, and keeps out links, slurs and floods but not swearing", async () => {
    const res = await post(viewer, "  hello   chat  ");
    expect(res.status).toBe(201);
    expect(res.json<{ message: ChatMessage }>().message).toMatchObject({ kind: "user", name: "ChatFan", text: "hello chat", badges: [] });
    expect((await room(visitor)).messages.map((m) => m.text)).toContain("hello chat");

    expect((await post(viewer, "too fast")).status).toBe(429);
    for (const text of ["go to evil.com now", "https://x.y/z", "visit discord dot gg/abc"]) {
      const bad = await post(viewer, text);
      expect(bad.status, text).toBe(400);
      expect(problem(bad)).toMatch(/Links aren't allowed/);
    }
    expect(problem(await post(viewer, "watch porn"))).toMatch(/words SLOT1 chat doesn't allow/);
    expect((await post(viewer, "x".repeat(301))).status).toBe(400);
    await sleep(1100);
    expect((await post(viewer, "holy shit what a fucking jump")).status).toBe(201);
    await sleep(1100);
    expect(problem(await post(viewer, "holy shit what a fucking jump"))).toBe("You just sent that.");
  });

  it("answers !slot1 on a featured channel from Twitch's live info only", async () => {
    await sleep(1100);
    const now = (await post(other, "!slot1 now")).json<{ message: ChatMessage }>().message;
    const a = await botReplyTo(now);
    expect(a).toMatchObject({ kind: "bot", name: "SLOT1", badges: ["bot"], replyTo: { id: now.id, name: "OtherFan" } });
    expect(a.text).toMatch(/^Vader is live in Grand Theft Auto V: “SUNDAY STREAM - ROLEPLAY” · live 1h 0m · 1\.2K watching\.$/);

    await sleep(1100);
    const f = (await post(other, "!slot1 followers")).json<{ message: ChatMessage }>().message;
    expect((await botReplyTo(f)).text).toBe("Vader has 512K followers on Twitch.");

    await sleep(1100);
    const q = (await post(other, "@slot1 what mission is he on?")).json<{ message: ChatMessage }>().message;
    expect((await botReplyTo(q)).text).toMatch(/^I can't see the game on this stream, only Twitch's live info\./);
  });

  it("delivers what a page missed after a reconnect", async () => {
    const before = (await room(visitor)).messages.at(-1)!.id;
    await sleep(1100);
    await post(viewer, "missed one");
    await sleep(1100);
    await post(viewer, "missed two");
    if (!h.app.server.listening) await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as AddressInfo).port;
    const got = await readSse(`http://127.0.0.1:${port}/api/chat/vader/events`, { origin: ORIGIN, "last-event-id": before }, 2, 6000);
    expect(got.map((e) => [e.event, e.data.text])).toEqual([
      ["message", "missed one"],
      ["message", "missed two"],
    ]);
  });

  it("drops messages older than 24 hours", async () => {
    await appendChatMessage(h.ctx.redis, "vader", { at: new Date(Date.now() - 25 * 3600_000).toISOString(), kind: "user", uid: null, name: "Old", badges: [], text: "from yesterday", replyTo: null });
    expect((await recentChatMessages(h.ctx.redis, "vader")).some((m) => m.text === "from yesterday")).toBe(false);
  });

  it("lets viewers report, admins delete and ban, and lifts bans", async () => {
    const mine = (await room(viewer)).messages.find((m) => m.text === "missed two")!;
    expect((await viewer.request("POST", `/api/chat/vader/messages/${mine.id}/report`, { json: {} })).status).toBe(400); // own message
    expect((await other.request("POST", `/api/chat/vader/messages/${mine.id}/report`, { json: {} })).status).toBe(200);
    expect((await other.request("DELETE", `/api/chat/vader/messages/${mine.id}`)).status).toBe(403);

    const admin = AdminChatResponse.parse((await owner.get("/api/admin/chat")).json());
    expect(admin.reports).toEqual([expect.objectContaining({ room: "vader", messageId: mine.id, name: "ChatFan", text: "missed two", reports: 1, stillInChat: true })]);
    expect((await visitor.get("/api/admin/chat")).status).toBe(404);

    expect((await room(owner)).viewer).toMatchObject({ canModerate: true, canBanEverywhere: true });
    expect((await owner.request("POST", `/api/chat/vader/messages/${mine.id}/ban`, { json: { everywhere: true } })).status).toBe(200);
    const after = await room(visitor);
    expect(after.messages.some((m) => m.name === "ChatFan")).toBe(false);
    expect((await room(viewer)).viewer).toMatchObject({ canPost: false, blocked: "banned" });
    await sleep(1100);
    expect((await post(viewer, "let me back")).status).toBe(403);

    const bans = AdminChatResponse.parse((await owner.get("/api/admin/chat")).json());
    expect(bans.reports).toEqual([]);
    const ban = bans.bans.find((b) => b.name === "ChatFan")!;
    expect(ban).toMatchObject({ room: null, bannedBy: "ChatOwner" });
    expect((await owner.request("DELETE", `/api/admin/chat/bans/${ban.id}`)).status).toBe(200);
    expect((await post(viewer, "thanks")).status).toBe(201);
  });

  it("handles a report from Admin → Chat", async () => {
    await sleep(1100);
    const m = (await post(other, "rude but not filtered")).json<{ message: ChatMessage }>().message;
    await viewer.request("POST", `/api/chat/vader/messages/${m.id}/report`, { json: {} });
    expect((await owner.request("POST", "/api/admin/chat/reports/resolve", { json: { room: "vader", messageId: m.id, action: "delete" } })).status).toBe(200);
    expect((await room(visitor)).messages.some((x) => x.id === m.id)).toBe(false);
    expect((await owner.request("POST", "/api/admin/chat/reports/resolve", { json: { room: "vader", messageId: m.id, action: "dismiss" } })).status).toBe(404);
  });

  it("gives a SLOT1 channel its own chat, where the creator moderates and the bot uses SLOT1's status", async () => {
    const r = await room(owner, "chatowner");
    expect(r.viewer).toMatchObject({ canModerate: true });
    await sleep(1100);
    const m = (await post(owner, "!slot1 status", "chatowner")).json<{ message: ChatMessage }>().message;
    expect(m.badges).toEqual(["creator", "team"]);
    expect((await botReplyTo(m, "chatowner")).text).toMatch(/^Broadcast: not live · vision not connected/);
    await sleep(1100);
    const ctl = (await post(owner, "!slot1 pause", "chatowner")).json<{ message: ChatMessage }>().message;
    expect((await botReplyTo(ctl, "chatowner")).text).toBe("Creator commands work in your Twitch chat or in SLOT1 Studio.");
  });
});
