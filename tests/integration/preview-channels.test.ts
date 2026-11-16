import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryResponse, PreviewChannels, WatchChannelResponse } from "@slot1/contracts";
import { clearPreviewCache, DEFAULT_PREVIEW_LOGINS } from "../../apps/api/src/lib/preview-channels";
import { Browser, MockTwitch, startHarness, type Harness } from "./harness";

/**
 * Admin → Featured channels and follower counts, against the real API, SQL and Redis with a mock
 * Twitch: only an admin can change the list, everyone sees the featured channels (marked `preview`
 * in the data), and follower totals are read with a user token (Twitch refuses app tokens for them)
 * and cached.
 */
const OWNER = { id: "5001", login: "siteowner", displayName: "SiteOwner", scopes: ["channel:bot", "clips:edit"] };
const VADER = { id: "5002", login: "vader", displayName: "Vader", scopes: [] };

describe("Preview channels and follower counts", () => {
  let mock: MockTwitch;
  let h: Harness;
  let owner: Browser;
  let visitor: Browser;
  const followerCalls = () => mock.requests.filter((r) => r === "GET /helix/channels/followers").length;

  async function signInWithTwitch(b: Browser, userId: string) {
    await b.refreshCsrf();
    const start = await b.get("/api/auth/twitch/start");
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cb = await b.get(`/api/auth/twitch/callback?code=${mock.issueCode(userId)}&state=${encodeURIComponent(state)}`);
    expect(String(cb.headers.location)).toMatch(/twitch=connected/);
    return b.refreshCsrf();
  }

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    mock.addUser(OWNER);
    mock.addUser(VADER);
    mock.liveStreams.set("vader", { title: "SUNDAY STREAM - ROLEPLAY", game: "Grand Theft Auto V", viewers: 1234 });
    mock.followers.set(VADER.id, 512345);
    h = await startHarness({ ...mock.env(), SLOT1_OPERATOR_TWITCH_LOGINS: OWNER.login });
    owner = new Browser(h);
    visitor = new Browser(h);
    await signInWithTwitch(owner, OWNER.id);
    await visitor.refreshCsrf();
  });
  afterAll(async () => {
    await h?.close();
    await mock?.stop();
  });

  it("starts from the default list until an admin saves one", async () => {
    await h.ctx.redis.del("slot1:admin:preview-channels");
    expect(PreviewChannels.parse((await owner.get("/api/admin/preview-channels")).json()).logins).toEqual([...DEFAULT_PREVIEW_LOGINS]);
  });

  it("is admin-only: visitors get a plain 404 and can't change it", async () => {
    expect((await visitor.get("/api/admin/preview-channels")).status).toBe(404);
    expect((await visitor.request("PUT", "/api/admin/preview-channels", { json: { logins: ["vader"] } })).status).toBe(404);
  });

  it("takes channel names or twitch.tv links, and names a bad entry", async () => {
    const bad = await owner.request("PUT", "/api/admin/preview-channels", { json: { logins: ["vader", "not a channel!"] } });
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("not a channel!");
    const many = await owner.request("PUT", "/api/admin/preview-channels", { json: { logins: Array.from({ length: 13 }, (_, i) => `chan_${i}`) } });
    expect(many.status).toBe(400);
    // Kick channels as kick.com links or kick:name, kept as "kick:<slug>".
    const kick = await owner.request("PUT", "/api/admin/preview-channels", { json: { logins: ["https://kick.com/Manny_Xers", "kick:lazenxd", "vader"] } });
    expect(PreviewChannels.parse(kick.json()).logins).toEqual(["kick:manny_xers", "kick:lazenxd", "vader"]);
    const ok = await owner.request("PUT", "/api/admin/preview-channels", { json: { logins: ["https://www.twitch.tv/Vader", "vader"] } });
    expect(ok.status).toBe(200);
    expect(PreviewChannels.parse(ok.json()).logins).toEqual(["vader"]);
    expect(PreviewChannels.parse((await owner.get("/api/admin/preview-channels")).json()).logins).toEqual(["vader"]);
  });

  it("lists featured channels in everyone's On air, with Twitch's live data and followers", async () => {
    for (const who of [visitor, owner]) {
      const res = await who.get("/api/channels");
      expect(res.status).toBe(200);
      const card = DirectoryResponse.parse(res.json()).channels.find((c) => c.login === "vader");
      expect(card).toMatchObject({ preview: true, displayName: "Vader", publicAnalysis: false, followers: 512345 });
      expect(card!.broadcast).toMatchObject({ state: "live", title: "SUNDAY STREAM - ROLEPLAY", category: "Grand Theft Auto V", viewerCount: 1234 });
      expect(card!.analysis).toMatchObject({ state: "ready", reason: "Learning is on for this stream." });
    }
  });

  it("puts follower totals on the watch page, read with a user token and cached for later visitors", async () => {
    await h.ctx.redis.del(`slot1:followers:${VADER.id}`);
    const before = followerCalls();
    const w = WatchChannelResponse.parse((await visitor.get("/api/channels/vader/watch")).json());
    expect(w.authorized).toBe(false);
    expect(w.channel.preview).toBe(true);
    expect(w.channel.followers).toBe(512345);
    // A pasted link to a channel that isn't featured stays plain watch-only.
    const other = WatchChannelResponse.parse((await visitor.get("/api/channels/someone_else/watch")).json());
    expect(other.channel.preview).toBeUndefined();
    await visitor.get("/api/channels/vader/watch");
    expect(followerCalls()).toBe(before + 1);
  });

  it("clears the list, and a cleared list stays cleared", async () => {
    const r = await owner.request("PUT", "/api/admin/preview-channels", { json: { logins: [] } });
    expect(PreviewChannels.parse(r.json()).logins).toEqual([]);
    clearPreviewCache();
    expect(DirectoryResponse.parse((await visitor.get("/api/channels")).json()).channels.some((c) => c.preview)).toBe(false);
    expect(PreviewChannels.parse((await owner.get("/api/admin/preview-channels")).json()).logins).toEqual([]);
  });
});
