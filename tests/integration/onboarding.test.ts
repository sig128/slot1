import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capabilities, DemoInfo, ReadinessStep, RelayDestinationView, RelayOverview, StudioOverview } from "@slot1/contracts";
import { getRelayDestination } from "@slot1/db";
import { resolveRelayTarget } from "@slot1/services";
import { mintAdminLink } from "../../apps/api/src/lib/admin-session";
import { Browser, MockTwitch, ORIGIN, startHarness, type Harness } from "./harness";

/**
 * One-click start: "Connect my Twitch" asks for every creator permission in one approval, a new
 * streamer lands in Stream setup's guided OBS setup, an older connection adds what's missing in
 * one click, and forwarding to Twitch exists only once the creator finishes the setup. Then the
 * other side of the same pages: visitors and creators never read server setting names, while
 * operators (and /admin sessions) get them together with the command that fixes them.
 * SLOT1's real API against a local mock of Twitch; this is not a test of Twitch itself.
 */

/** Everything Connect my Twitch asks for, sorted. */
const ALL_SCOPES = ["channel:bot", "channel:manage:clips", "channel:read:stream_key", "clips:edit"];
const BASE_SCOPES = ["channel:bot", "clips:edit"];
const NEWBIE = { id: "8101", login: "freshcrew", displayName: "FreshCrew", scopes: ALL_SCOPES };
/** Connected before one-approval connect: Twitch holds only the base scopes for it. */
const VETERAN = { id: "8102", login: "oldcrew", displayName: "OldCrew", scopes: BASE_SCOPES };
const GRANT = { label: "Grant the missing permissions", kind: "link", href: "/api/auth/twitch/start?returnTo=%2Fstudio%3Ftab%3Dstream", actionId: null };

/** Environment-variable-like names (TWITCH_CLIENT_ID, INGEST_GATEWAY=…) and slot1 server commands. */
const SETTING = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/;
const COMMAND = /\bslot1 (?:twitch|ai|update|logs|demo)\b/;

const step = (o: StudioOverview, id: string) => o.readiness.find((s: ReadinessStep) => s.id === id)!;

function ingestEnv() {
  return {
    INGEST_GATEWAY: "nginx-rtmp",
    INGEST_PUBLIC_RTMP_URL: "rtmp://127.0.0.1:1935/live",
    INGEST_READ_URL_TEMPLATE: "rtmp://127.0.0.1:1935/{path}?reader={password}",
    INGEST_READ_PASSWORD: randomBytes(12).toString("hex"),
    INGEST_HOOK_SECRET: randomBytes(16).toString("hex"),
  };
}

/** Local sign-in is rate limited per IP in the Redis every test file shares. */
async function resetRateLimits(h: Harness | undefined) {
  if (!h) return;
  const keys = await h.ctx.redis.keys("slot1-api-rl:*");
  if (keys.length) await h.ctx.redis.del(...keys);
}

async function makeOperator(h: Harness, b: Browser, name: string) {
  const me = await b.signInLocal(name);
  await h.ctx.db.query(`UPDATE users SET is_operator = true WHERE id = $1`, [(me.user as { id: string }).id]);
}

describe("one-click start: one Twitch approval, then the guided OBS setup", () => {
  let mock: MockTwitch;
  let h: Harness;
  const newbie = { browser: null as Browser | null };

  /** Connect my Twitch as `userId`: what SLOT1 asked Twitch for, and where the creator lands. */
  async function connect(b: Browser, userId: string, startPath = "/api/auth/twitch/start") {
    await b.refreshCsrf();
    const start = await b.get(startPath);
    expect(start.status).toBe(302);
    const loc = new URL(String(start.headers.location));
    expect(`${loc.origin}${loc.pathname}`).toBe(`${mock.base}/oauth2/authorize`);
    const cb = await b.get(`/api/auth/twitch/callback?code=${mock.issueCode(userId)}&state=${encodeURIComponent(loc.searchParams.get("state")!)}`);
    expect(cb.status).toBe(302);
    await b.refreshCsrf();
    return { scopes: loc.searchParams.get("scope")!.split(" ").sort(), landing: String(cb.headers.location) };
  }
  const studio = async (b: Browser) => (await b.get("/api/studio")).json<StudioOverview>();
  const relay = async (b: Browser) => (await b.get("/api/studio/relay")).json<RelayOverview>();

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    mock.addUser({ ...NEWBIE, scopes: [...NEWBIE.scopes] });
    mock.addUser({ ...VETERAN, scopes: [...VETERAN.scopes] });
    h = await startHarness({ ...mock.env(), ...ingestEnv() });
    await resetRateLimits(h);
  });
  afterAll(async () => {
    await resetRateLimits(h);
    await h?.close();
    await mock?.stop();
  });

  it("asks for every permission at once and lands a new streamer in the OBS setup", async () => {
    const b = (newbie.browser = new Browser(h));
    const r = await connect(b, NEWBIE.id);
    expect(r.scopes).toEqual(ALL_SCOPES);
    expect(r.landing).toBe(`${ORIGIN}/studio?tab=stream&onboarding=1&twitch=connected`);

    const o = await studio(b);
    expect(o.twitch.missingScopes).toEqual([]);
    expect(step(o, "twitch_connected")).toMatchObject({ status: "done", action: null });
    expect(step(o, "clip_permissions_ready")).toMatchObject({ status: "done", detail: "Clips can be created, downloaded and analyzed." });

    // Forwarding is allowed but nothing is forwarded until the creator chooses it.
    const rel = await relay(b);
    expect(rel.twitch).toMatchObject({ connected: true, forwardingPermission: true });
    expect(rel.destinations).toEqual([]);
  });

  it("creates forwarding to Twitch only when the creator finishes the setup", async () => {
    const b = newbie.browser!;
    // Finish setup with "SLOT1 sends your stream on to Twitch" on sends exactly these two requests.
    const created = await b.request("POST", "/api/studio/relay/destinations", { json: { platform: "twitch" } });
    expect(created.status).toBe(200);
    const dest = created.json<RelayDestinationView>();
    expect(dest).toMatchObject({ platform: "twitch", enabled: false, keyHint: null });
    expect((await b.request("PATCH", `/api/studio/relay/destinations/${dest.id}`, { json: { enabled: true } })).status).toBe(200);
    expect((await relay(b)).destinations).toMatchObject([{ id: dest.id, platform: "twitch", enabled: true, status: "idle" }]);

    // The permission came with Connect, so SLOT1 can read the key from Twitch: nothing to paste.
    const target = await resolveRelayTarget(h.ctx, (await getRelayDestination(h.ctx.db, dest.id))!);
    expect(target).toMatchObject({ ok: true, host: "ingest.global-contribute.live-video.net" });
    expect(mock.requests).toContain("GET /helix/streams/key");

    // Once streaming is set up, connecting again returns where the creator asked, not to the setup.
    expect((await b.request("POST", "/api/studio/relay/ingest-credentials", { json: {} })).status).toBe(200);
    const again = await connect(b, NEWBIE.id);
    expect(again.landing).toBe(`${ORIGIN}/studio?twitch=connected`);
    expect((await relay(b)).twitch.forwardingPermission).toBe(true);
    expect((await relay(b)).destinations).toMatchObject([{ id: dest.id, enabled: true }]);
  });

  it("offers an older connection one click to grant what's missing", async () => {
    const b = new Browser(h);
    const first = await connect(b, VETERAN.id);
    expect(first.scopes).toEqual(ALL_SCOPES);
    let o = await studio(b);
    expect(o.twitch.scopes.sort()).toEqual(BASE_SCOPES);
    expect(o.twitch.missingScopes).toEqual(["channel:manage:clips", "channel:read:stream_key"]);
    expect(step(o, "twitch_connected")).toMatchObject({ status: "todo", action: GRANT });
    expect(step(o, "twitch_connected").detail).toBe(
      "Signed in as oldcrew. Twitch still has to allow channel:manage:clips, channel:read:stream_key: one approval adds them all.",
    );
    expect(step(o, "clip_permissions_ready")).toMatchObject({ status: "todo", action: GRANT });
    expect((await relay(b)).twitch.forwardingPermission).toBe(false);

    // The one click: Twitch approves the full set and the creator is back in Stream setup.
    mock.users.get(VETERAN.id)!.scopes = [...ALL_SCOPES];
    const fixed = await connect(b, VETERAN.id, GRANT.href);
    expect(fixed.scopes).toEqual(ALL_SCOPES);
    expect(fixed.landing).toBe(`${ORIGIN}/studio?tab=stream&twitch=connected`);
    o = await studio(b);
    expect(o.twitch.missingScopes).toEqual([]);
    expect(step(o, "twitch_connected")).toMatchObject({ status: "done", action: null });
    expect(step(o, "clip_permissions_ready")).toMatchObject({ status: "done" });
    expect((await relay(b)).twitch.forwardingPermission).toBe(true);
  });
});

describe("server settings stay with operators", () => {
  // A fresh server: no Twitch app, no ingest, no AI.
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await resetRateLimits(h);
  });
  afterAll(async () => {
    await resetRateLimits(h);
    await h?.close();
  });

  it("tells visitors and creators what isn't available, without naming a setting", async () => {
    const anon = await h.app.inject({ method: "GET", url: "/api/capabilities" });
    expect(anon.headers["cache-control"]).toBe("private, no-store");
    const caps = anon.json<Capabilities>();
    expect(JSON.stringify(caps)).not.toMatch(SETTING);
    expect(JSON.stringify(caps)).not.toMatch(COMMAND);
    expect(caps.twitch).toMatchObject({ available: false, reason: "Twitch sign-in isn't open on SLOT1 yet", setup: null });
    expect(caps.bot.reason).toBe("The SLOT1 chat bot isn't switched on yet");
    expect(caps.ingest.reason).toBe("Streaming to SLOT1 isn't open yet");
    expect(caps.relay.reason).toBe("Forwarding isn't switched on yet");
    expect(caps.vision.reason).toBe("The AI that describes gameplay isn't switched on yet, so SLOT1 reports on-screen text and video measurements only");

    // Every "Sign in with Twitch" button links straight to the start route: without Twitch set up,
    // it goes back to Studio, which says so (never an error document).
    const start = await new Browser(h).get("/api/auth/twitch/start");
    expect(start.status).toBe(302);
    expect(String(start.headers.location)).toBe(`${ORIGIN}/studio?twitch=error&why=not_configured`);

    // A creator's Studio: readiness, usage and refusals in plain words.
    const creator = new Browser(h);
    await creator.signInLocal("Plain Words Crew");
    const o = (await creator.get("/api/studio")).json<StudioOverview>();
    for (const text of [JSON.stringify(o.readiness), o.usage.costBasis]) {
      expect(text).not.toMatch(SETTING);
      expect(text).not.toMatch(COMMAND);
    }
    expect(step(o, "video_source_ready").detail).toBe("Streaming to SLOT1 isn't open yet. Uploaded replays still work.");
    expect(o.usage.costBasis).toBe("Provider-reported token counts. SLOT1 doesn't estimate spend yet.");
    const key = await creator.request("POST", "/api/studio/relay/ingest-credentials", { json: {} });
    expect(key.status).toBe(503);
    expect(key.json().error).toEqual({ code: "unavailable", message: "Streaming to SLOT1 isn't open yet", requirement: null });
    expect((await creator.get("/api/studio/relay")).json<RelayOverview>().reason).toBe("Forwarding isn't switched on yet");
  });

  it("shows operators the exact missing settings and the command that fixes them", async () => {
    const op = new Browser(h);
    await makeOperator(h, op, "Settings Operator");
    const caps = (await op.get("/api/capabilities")).json<Capabilities>();
    expect(caps.twitch.reason).toBe("Twitch not configured: missing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI");
    expect(caps.twitch.setup).toEqual({ missing: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_REDIRECT_URI"], command: "slot1 twitch" });
    expect(caps.vision.setup).toEqual({ missing: ["VISION_PROVIDER"], command: "slot1 ai" });
    expect(caps.ingest.setup?.command).toBe("slot1 update");
    expect(caps.ingest.setup?.missing).toContain("INGEST_GATEWAY");

    const o = (await op.get("/api/studio")).json<StudioOverview>();
    expect(step(o, "twitch_connected").detail).toBe(
      "Not set up on the server yet. Missing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI. Fix it on the server: slot1 twitch.",
    );
    expect(o.usage.costBasis).toMatch(/VISION_PRICE_INPUT_PER_MTOK/);
    const start = await op.get("/api/auth/twitch/start?returnTo=%2Fstudio%3Ftab%3Dstream");
    expect(start.status).toBe(302);
    expect(String(start.headers.location)).toBe(`${ORIGIN}/studio?tab=stream&twitch=error&why=not_configured`);
  });

  it("gives an /admin session the operator view, including how to switch the demo on", async () => {
    const { url } = await mintAdminLink(h.ctx);
    const used = await h.app.inject({
      method: "POST",
      url: "/api/admin/link",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: new URL(url).searchParams.get("token")! }).toString(),
    });
    expect(used.statusCode).toBe(303);
    const set = used.headers["set-cookie"];
    const cookie = (Array.isArray(set) ? set : [String(set)]).find((c) => c.startsWith("slot1_admin="))!.split(";")[0]!;

    const caps = (await h.app.inject({ method: "GET", url: "/api/capabilities", headers: { cookie } })).json<Capabilities>();
    expect(caps.twitch.setup?.command).toBe("slot1 twitch");
    const demo = (await h.app.inject({ method: "GET", url: "/api/demo", headers: { cookie } })).json<DemoInfo>();
    expect(demo).toMatchObject({ enabled: false });
    expect(demo.reason).toMatch(/slot1 demo on/);
    // A visitor's /demo just says it's off.
    expect((await h.app.inject({ method: "GET", url: "/api/demo" })).json<DemoInfo>()).toMatchObject({ enabled: false, reason: null });
  });
});
