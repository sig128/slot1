import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueWhepToken } from "../../apps/api/src/routes/live";
import { createIngestSession, markPublishEnded, setSourceSession } from "@slot1/db";
import { signPayload } from "@slot1/platform";
import { Browser, startHarness, type Harness } from "./harness";

/**
 * SLOT1-hosted live video: who gets a WebRTC playback grant, and what the MediaMTX auth hook
 * accepts for WHIP publishing and WHEP viewing. MediaMTX itself is not run here; the hook is
 * called the way MediaMTX's authMethod=http calls it.
 */
const WEBRTC = "http://127.0.0.1:8889";

describe("live video over WebRTC (MediaMTX)", () => {
  let h: Harness;
  let creator: Browser;
  let stranger: Browser;
  let anonymous: Browser;
  let sourceId = "";
  let name = "";
  let secret = "";
  let sessionId = "";

  const hook = (body: Record<string, string>) =>
    h.app.inject({ method: "POST", url: "/api/ingest/hooks/mediamtx/auth?hook_secret=hook-secret", payload: body });

  beforeAll(async () => {
    h = await startHarness({
      INGEST_GATEWAY: "mediamtx",
      INGEST_PUBLIC_RTMP_URL: "rtmp://127.0.0.1:1935",
      INGEST_READ_URL_TEMPLATE: "rtsp://{user}:{password}@127.0.0.1:8554/{path}",
      INGEST_READ_PASSWORD: "worker-pass",
      INGEST_HOOK_SECRET: "hook-secret",
      INGEST_PUBLIC_WEBRTC_URL: WEBRTC,
      INGEST_PUBLIC_SRT_URL: "srt://127.0.0.1:8890",
    });
    creator = new Browser(h);
    stranger = new Browser(h);
    anonymous = new Browser(h);
    await creator.signInLocal("Low Latency Crew");
    await stranger.signInLocal("Someone Else");
    await anonymous.refreshCsrf();
  });
  afterAll(async () => h?.close());

  it("reports the capability, and gives creators WHIP and SRT publishing details once", async () => {
    const caps = (await anonymous.get("/api/capabilities")).json();
    expect(caps.liveVideo).toMatchObject({ available: true, reason: null });
    const r = await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "live" } });
    expect(r.status).toBe(200);
    const body = r.json<{ source: { id: string; publish: { whipUrl: string; srtUrl: string } }; streamKey: string; whip: { url: string; bearerToken: string }; srt: { url: string } }>();
    sourceId = body.source.id;
    name = body.streamKey.split("?")[0]!;
    secret = body.whip.bearerToken;
    expect(body.whip.url).toBe(`${WEBRTC}/live/${name}/whip`);
    expect(body.srt.url).toBe(`srt://127.0.0.1:8890?streamid=publish:live/${name}:${name}:${secret}`);
    // Later listings show where to publish, never the key.
    const studio = JSON.stringify((await creator.get("/api/studio")).json());
    expect(studio).toContain(`${WEBRTC}/live/${name}/whip`);
    expect(studio).not.toContain(secret);
  });

  it("accepts WHIP publishing only with this source's stream key", async () => {
    const path = `live/${name}`;
    expect((await hook({ action: "publish", path, protocol: "webrtc" })).statusCode).toBe(401);
    expect((await hook({ action: "publish", path, protocol: "webrtc", token: "not-the-key" })).statusCode).toBe(403);
    expect((await hook({ action: "publish", path: "live/zzzz9999", protocol: "webrtc", token: secret })).statusCode).toBe(403);
    expect((await hook({ action: "publish", path, protocol: "webrtc", token: secret })).statusCode).toBe(200);
    const { rows } = await h.ctx.db.query<{ status: string }>(`SELECT status FROM media_sources WHERE id = $1`, [sourceId]);
    expect(rows[0]!.status).toBe("publishing");
  });

  it("grants playback to the creator and refuses other viewers of a private session", async () => {
    // What the live supervisor does once frames arrive: attach the source to an ingest session.
    const b = (await creator.get("/api/me")).json<{ broadcaster: { id: string } }>().broadcaster;
    const s = await createIngestSession(h.ctx.db, b.id, "live", "Live ingest: OBS", "private", 5000);
    await setSourceSession(h.ctx.db, sourceId, s.id);
    sessionId = s.id;

    const grant = (await creator.get(`/api/sessions/${sessionId}/live-video`)).json();
    expect(grant).toMatchObject({ available: true, reason: null, whepUrl: `${WEBRTC}/live/${name}/whep` });
    const ttl = new Date(grant.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(121_000);
    expect((await stranger.get(`/api/sessions/${sessionId}/live-video`)).status).toBe(404);
    expect((await anonymous.get(`/api/sessions/${sessionId}/live-video`)).status).toBe(404);
  });

  it("lets anyone watch a public session", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { visibility: "public", publicAnalysis: true } })).status).toBe(200);
    expect((await creator.request("PATCH", `/api/sessions/${sessionId}`, { json: { visibility: "public" } })).status).toBe(200);
    const grant = (await anonymous.get(`/api/sessions/${sessionId}/live-video`)).json();
    expect(grant.available).toBe(true);
    expect(grant.token).toBeTruthy();
  });

  it("lets the gateway serve WebRTC viewers only with a valid token for that exact stream", async () => {
    const path = `live/${name}`;
    const { token } = (await creator.get(`/api/sessions/${sessionId}/live-video`)).json<{ token: string }>();
    expect((await hook({ action: "read", path, protocol: "webrtc", token })).statusCode).toBe(200);
    expect((await hook({ action: "read", path, protocol: "webrtc", query: `token=${encodeURIComponent(token)}` })).statusCode).toBe(200);
    expect((await hook({ action: "read", path, protocol: "webrtc" })).statusCode).toBe(401);
    // Tampered, expired, for another stream, or a different kind of signed token: refused.
    expect((await hook({ action: "read", path, protocol: "webrtc", token: `${token.slice(0, -2)}xx` })).statusCode).toBe(403);
    const expired = issueWhepToken(h.ctx, path, Date.now() - 10 * 60_000).token;
    expect((await hook({ action: "read", path, protocol: "webrtc", token: expired })).statusCode).toBe(403);
    const other = issueWhepToken(h.ctx, "live/abcd1234").token;
    expect((await hook({ action: "read", path, protocol: "webrtc", token: other })).statusCode).toBe(403);
    const mediaToken = signPayload(h.ctx.config.sessionSecret, { k: "some/key.jpg", exp: Math.floor(Date.now() / 1000) + 60, ct: "image/jpeg" });
    expect((await hook({ action: "read", path, protocol: "webrtc", token: mediaToken })).statusCode).toBe(403);
    // A viewer token never opens the worker's RTSP read; the worker credential still does.
    expect((await hook({ action: "read", path, protocol: "rtsp", token })).statusCode).toBe(403);
    expect((await hook({ action: "read", path, protocol: "rtsp", user: "slot1-worker", password: "worker-pass" })).statusCode).toBe(200);
  });

  it("says why there's no video when the creator stops sending", async () => {
    await markPublishEnded(h.ctx.db, sourceId);
    const grant = (await creator.get(`/api/sessions/${sessionId}/live-video`)).json();
    expect(grant).toMatchObject({ available: false, whepUrl: null, token: null });
    expect(grant.reason).toMatch(/isn't sending video/);
  });

  it("refuses everything once the source is revoked", async () => {
    const path = `live/${name}`;
    const { token } = issueWhepToken(h.ctx, path);
    expect((await creator.request("DELETE", `/api/studio/sources/${sourceId}`)).status).toBe(200);
    expect((await hook({ action: "publish", path, protocol: "webrtc", token: secret })).statusCode).toBe(403);
    expect((await hook({ action: "read", path, protocol: "webrtc", token })).statusCode).toBe(403);
  });
});

describe("live video capability without MediaMTX", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      INGEST_GATEWAY: "nginx-rtmp",
      INGEST_PUBLIC_RTMP_URL: "rtmp://127.0.0.1:1935/live",
      INGEST_READ_URL_TEMPLATE: "rtmp://127.0.0.1:1935/{path}?reader={password}",
      INGEST_READ_PASSWORD: "worker-pass",
      INGEST_HOOK_SECRET: "hook-secret",
    });
  });
  afterAll(async () => h?.close());

  it("explains that nginx-rtmp can't serve WebRTC and never hands out a player URL", async () => {
    // Visitors read a plain line; an operator gets the exact settings and the command that fixes them.
    const caps = (await h.app.inject({ method: "GET", url: "/api/capabilities" })).json();
    expect(caps.liveVideo).toMatchObject({ available: false, reason: "SLOT1's own live video isn't switched on yet", setup: null });
    const operator = new Browser(h);
    const me = await operator.signInLocal("Live Video Operator");
    await h.ctx.db.query(`UPDATE users SET is_operator = true WHERE id = $1`, [(me.user as { id: string }).id]);
    const opCaps = (await operator.get("/api/capabilities")).json();
    expect(opCaps.liveVideo.reason).toMatch(/nginx-rtmp can't serve WebRTC/);
    expect(opCaps.liveVideo.reason).toMatch(/INGEST_PUBLIC_WEBRTC_URL/);
    expect(opCaps.liveVideo.setup).toEqual({ missing: ["INGEST_GATEWAY=mediamtx", "INGEST_PUBLIC_WEBRTC_URL"], command: "SLOT1_GATEWAY=mediamtx slot1 update", settings: null });
    const creator = new Browser(h);
    await creator.signInLocal("RTMP Crew");
    const created = (await creator.request("POST", "/api/studio/sources", { json: { name: "OBS", label: "test" } })).json();
    expect(created.whip).toBeNull();
    const b = (await creator.get("/api/me")).json<{ broadcaster: { id: string } }>().broadcaster;
    const s = await createIngestSession(h.ctx.db, b.id, "test", "Test ingest", "private", 5000);
    await setSourceSession(h.ctx.db, created.source.id, s.id);
    const grant = (await creator.get(`/api/sessions/${s.id}/live-video`)).json();
    expect(grant).toMatchObject({ available: false, whepUrl: null, token: null });
    expect(grant.reason).toBe("SLOT1's own live video isn't switched on yet");
  });
});
