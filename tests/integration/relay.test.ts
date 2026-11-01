import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestCredentials, RelayDestinationView, RelayOverview } from "@slot1/contracts";
import { getRelayDestination, getSettings, setRelayStatus } from "@slot1/db";
import { resolveRelayTarget } from "@slot1/services";
import { creatorControlPorts } from "../../apps/worker/src/jobs/chat";
import { RelaySupervisor } from "../../apps/worker/src/live/relay";
import { buildReadUrl, LiveSupervisor } from "../../apps/worker/src/live/supervisor";
import { Browser, MockTwitch, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const RTMP_MODULE = "/usr/lib/nginx/modules/ngx_rtmp_module.so";
const hasNginxRtmp = (() => {
  try {
    execFileSync("nginx", ["-v"], { stdio: "ignore" });
    return existsSync(RTMP_MODULE);
  } catch {
    return false;
  }
})();

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A test CA, a localhost certificate it signed, and a self-signed one nobody trusts. */
async function makeCertificates(dir: string) {
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=SLOT1 Test CA");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost");
  writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  run("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf");
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "self.key", "-out", "self.pem", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost");
  const read = (f: string) => readFileSync(path.join(dir, f));
  return { caFile: path.join(dir, "ca.pem"), trusted: { key: read("srv.key"), cert: read("srv.pem") }, untrusted: { key: read("self.key"), cert: read("self.pem") } };
}

/** RTMPS in front of nginx-rtmp: TLS terminated here, plain RTMP behind, like a platform's edge. */
async function rtmpsProxy(tlsOpts: { key: Buffer; cert: Buffer }, rtmpPort: number): Promise<{ server: TlsServer; port: number }> {
  const server = createTlsServer(tlsOpts, (client) => {
    const upstream = connect(rtmpPort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1000);
  }
}

function ingestEnv(rtmpPort: number) {
  return {
    INGEST_GATEWAY: "nginx-rtmp",
    INGEST_PUBLIC_RTMP_URL: `rtmp://127.0.0.1:${rtmpPort}/live`,
    INGEST_READ_URL_TEMPLATE: `rtmp://127.0.0.1:${rtmpPort}/{path}?reader={password}`,
    INGEST_READ_PASSWORD: randomBytes(12).toString("hex"),
    INGEST_HOOK_SECRET: randomBytes(16).toString("hex"),
  };
}

const overview = async (b: Browser) => (await b.get("/api/studio/relay")).json<RelayOverview>();

/* ------------------------------------------------------------------------------------------ */

const CREATOR = { id: "7001", login: "relaycrew", displayName: "RelayCrew" };
const BASE_SCOPES = ["channel:bot", "clips:edit"];
const YT_KEY = "abcd-efgh-ijkl-mnop-qrst";
const KICK_KEY = "sk_us-west-2_KickKey123456789";

describe("forwarding destinations: keys, permissions and the Twitch stream key", () => {
  let mock: MockTwitch;
  let h: Harness;
  let strict: Harness;
  let owner: Browser;
  let other: Browser;

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    mock.addUser({ ...CREATOR, scopes: [...BASE_SCOPES] });
    const port = await freePort();
    h = await startHarness({ ...mock.env(), ...ingestEnv(port), RELAY_ALLOW_PRIVATE_DESTINATIONS: "true" });
    strict = await startHarness(ingestEnv(port));
    owner = new Browser(h);
    await owner.signInLocal("Relay Owner");
    other = new Browser(h);
    await other.signInLocal("Someone Else");
  });

  afterAll(async () => {
    // Grants are encrypted with this file's key: retire them so later files never try to use them.
    await h?.ctx.db.query(`UPDATE encrypted_grants SET status = 'revoked' WHERE twitch_user_id = $1`, [CREATOR.id]).catch(() => undefined);
    await h?.close();
    await strict?.close();
    await mock?.stop();
  });

  it("keeps destination keys write-only and encrypted at rest", async () => {
    const empty = await overview(owner);
    expect(empty).toMatchObject({ available: true, destinations: [], maxDestinations: 4, youtubeServer: "rtmps://a.rtmps.youtube.com:443/live2" });

    const yt = await owner.request("POST", "/api/studio/relay/destinations", { json: { platform: "youtube", streamKey: YT_KEY } });
    expect(yt.status).toBe(200);
    expect(yt.body).not.toContain(YT_KEY);
    const ytView = yt.json<RelayDestinationView>();
    expect(ytView).toMatchObject({ platform: "youtube", label: "YouTube", enabled: false, status: "disabled", serverHost: "a.rtmps.youtube.com", keyHint: "qrst" });

    const { rows } = await h.ctx.db.query<{ key_enc: string; server_url: string }>(`SELECT key_enc, server_url FROM relay_destinations WHERE id = $1`, [ytView.id]);
    expect(rows[0]!.key_enc).toMatch(/^v1\.it1\./);
    expect(rows[0]!.key_enc).not.toContain(YT_KEY);
    expect(h.ctx.cipher.decrypt(rows[0]!.key_enc)).toBe(YT_KEY);
    expect(rows[0]!.server_url).toBe("rtmps://a.rtmps.youtube.com:443/live2");

    const kick = await owner.request("POST", "/api/studio/relay/destinations", {
      json: { platform: "kick", streamKey: KICK_KEY, serverUrl: " rtmps://fa723fc1b171.global-contribute.live-video.net/app \n" },
    });
    expect(kick.status).toBe(200);
    expect(kick.json<RelayDestinationView>()).toMatchObject({ platform: "kick", serverHost: "fa723fc1b171.global-contribute.live-video.net", keyHint: "6789" });

    // One per platform (custom servers excepted), Twitch only for Twitch accounts, at most four.
    const again = await owner.request("POST", "/api/studio/relay/destinations", { json: { platform: "youtube", streamKey: "another-key-1234" } });
    expect(again.status).toBe(409);
    expect(again.json().error.message).toBe("You already forward to YouTube");
    expect((await owner.request("POST", "/api/studio/relay/destinations", { json: { platform: "twitch" } })).status).toBe(400);
    for (const n of [1, 2]) {
      const r = await owner.request("POST", "/api/studio/relay/destinations", { json: { platform: "custom", label: `Server ${n}`, serverUrl: `rtmp://192.0.2.${n}/live`, streamKey: `custom-key-${n}` } });
      expect(r.status).toBe(200);
    }
    const fifth = await owner.request("POST", "/api/studio/relay/destinations", { json: { platform: "custom", label: "One too many", serverUrl: "rtmp://192.0.2.9/live", streamKey: "custom-key-9" } });
    expect(fifth.status).toBe(409);

    // Switching on starts "idle" until the creator streams; replacing the key re-encrypts it.
    const on = await owner.request("PATCH", `/api/studio/relay/destinations/${ytView.id}`, { json: { enabled: true } });
    expect(on.json<RelayDestinationView>()).toMatchObject({ enabled: true, status: "idle" });
    const replaced = await owner.request("PATCH", `/api/studio/relay/destinations/${ytView.id}`, { json: { streamKey: "wxyz-new-key-9876" } });
    expect(replaced.json<RelayDestinationView>().keyHint).toBe("9876");
    const after = await getRelayDestination(h.ctx.db, ytView.id);
    expect(h.ctx.cipher.decrypt(after!.key_enc!)).toBe("wxyz-new-key-9876");

    // Nothing the browser can read ever carries a key or a full server URL with one.
    const all = JSON.stringify(await overview(owner));
    for (const secret of [YT_KEY, KICK_KEY, "wxyz-new-key-9876", "custom-key-1", "custom-key-2"]) expect(all).not.toContain(secret);
    expect(all).not.toContain(after!.key_enc!);

    // Deleting erases the row and the encrypted key with it.
    for (const d of (await overview(owner)).destinations.filter((x) => x.platform === "custom")) {
      expect((await owner.request("DELETE", `/api/studio/relay/destinations/${d.id}`)).status).toBe(200);
      expect(await getRelayDestination(h.ctx.db, d.id)).toBeNull();
    }
    const { rows: left } = await h.ctx.db.query(`SELECT count(*)::int AS n FROM relay_destinations WHERE key_enc IS NOT NULL AND label LIKE 'Server %'`);
    expect(left[0].n).toBe(0);
  });

  it("accepts only rtmp:// and rtmps:// servers, and only public ones by default", async () => {
    const bad = async (b: Browser, serverUrl: string) => {
      const r = await b.request("POST", "/api/studio/relay/destinations", { json: { platform: "custom", label: "Bad", serverUrl, streamKey: "custom-key-x" } });
      return { status: r.status, message: r.json().error?.message as string | undefined };
    };
    expect(await bad(owner, "https://example.com/live")).toMatchObject({ status: 400, message: "The server address must start with rtmps:// or rtmp://" });
    expect(await bad(owner, "rtmp://user:pass@example.com/live")).toMatchObject({ status: 400, message: "Put the stream key in the key field, not in the server address" });
    expect((await bad(owner, "javascript:alert(1)")).status).toBe(400);

    const s = new Browser(strict);
    await s.signInLocal("Strict Crew");
    for (const url of ["rtmp://127.0.0.1:1935/live", "rtmp://169.254.169.254/latest", "rtmp://localhost/live", "rtmp://10.0.0.8/live", "rtmp://[::1]/live"]) {
      expect(await bad(s, url), url).toMatchObject({ status: 400, message: "Forwarding only goes to public streaming servers" });
    }
    const ok = await s.request("POST", "/api/studio/relay/destinations", { json: { platform: "custom", label: "Public", serverUrl: "rtmp://8.8.8.8/live", streamKey: "public-key-1" } });
    expect(ok.status).toBe(200);
  });

  it("lets only the owner see or change a destination", async () => {
    const mine = (await overview(owner)).destinations;
    expect(mine.length).toBeGreaterThan(0);
    const target = mine[0]!;
    expect((await overview(other)).destinations).toEqual([]);
    expect((await other.request("PATCH", `/api/studio/relay/destinations/${target.id}`, { json: { enabled: false } })).status).toBe(404);
    expect((await other.request("PATCH", `/api/studio/relay/destinations/${target.id}`, { json: { streamKey: "hijacked-key" } })).status).toBe(404);
    expect((await other.request("DELETE", `/api/studio/relay/destinations/${target.id}`)).status).toBe(404);
    const anon = new Browser(h);
    await anon.refreshCsrf();
    expect((await anon.get("/api/studio/relay")).status).toBe(401);
    expect((await anon.request("POST", "/api/studio/relay/ingest-credentials", { json: {} })).status).toBe(401);
    const still = await getRelayDestination(h.ctx.db, target.id);
    expect(still).toMatchObject({ enabled: target.enabled });
    expect(h.ctx.cipher.decrypt(still!.key_enc!)).not.toBe("hijacked-key");
  });

  it("gives OBS one Server + Key, shown once and stored only as a hash", async () => {
    const first = await owner.request("POST", "/api/studio/relay/ingest-credentials", { json: {} });
    expect(first.status).toBe(200);
    const creds = first.json<IngestCredentials>();
    expect(creds.server).toBe(h.ctx.config.env.INGEST_PUBLIC_RTMP_URL);
    const secret = new URLSearchParams(creds.streamKey.split("?")[1]).get("key")!;
    expect(secret.length).toBeGreaterThan(20);
    const { rows } = await h.ctx.db.query(`SELECT label, publish_key_hash::text AS hash, publish_key_hint FROM media_sources WHERE id = $1`, [creds.sourceId]);
    expect(rows[0]).toMatchObject({ label: "live" });
    expect(rows[0].hash).not.toContain(secret);
    expect(secret.endsWith(rows[0].publish_key_hint)).toBe(true);
    expect(JSON.stringify(await overview(owner))).not.toContain(secret);

    // Asking again replaces the key on the same source (the old key stops working).
    const second = (await owner.request("POST", "/api/studio/relay/ingest-credentials", { json: {} })).json<IngestCredentials>();
    expect(second.sourceId).toBe(creds.sourceId);
    expect(second.streamKey).not.toBe(creds.streamKey);
    expect((await overview(owner)).ingest).toMatchObject({ sourceId: creds.sourceId, publishing: false, keyHint: second.streamKey.slice(-4) });
  });

  it("gets the Twitch key from Twitch only after the creator allows forwarding", async () => {
    const tw = new Browser(h);
    const connect = async (startPath: string) => {
      await tw.refreshCsrf();
      const start = await tw.get(startPath);
      expect(start.status).toBe(302);
      const loc = new URL(String(start.headers.location));
      const cb = await tw.get(`/api/auth/twitch/callback?code=${mock.issueCode(CREATOR.id)}&state=${encodeURIComponent(loc.searchParams.get("state")!)}`);
      expect(cb.status).toBe(302);
      await tw.refreshCsrf();
      return { scopes: loc.searchParams.get("scope")!.split(" ").sort(), redirect: String(cb.headers.location) };
    };
    expect((await connect("/api/auth/twitch/start")).scopes).toEqual(BASE_SCOPES);

    let o = await overview(tw);
    expect(o.twitch).toEqual({ connected: true, forwardingPermission: false, permissionUrl: "/api/auth/twitch/start?relay=1&returnTo=%2Fstudio%3Ftab%3Dstream" });
    const created = (await tw.request("POST", "/api/studio/relay/destinations", { json: { platform: "twitch" } })).json<RelayDestinationView>();
    expect(created).toMatchObject({ platform: "twitch", serverHost: "ingest.global-contribute.live-video.net", keyHint: null });
    await tw.request("PATCH", `/api/studio/relay/destinations/${created.id}`, { json: { enabled: true } });
    expect((await tw.request("PATCH", `/api/studio/relay/destinations/${created.id}`, { json: { streamKey: "pasted-key" } })).status).toBe(400);

    // Without channel:read:stream_key SLOT1 says what's needed and never asks Twitch.
    const before = await resolveRelayTarget(h.ctx, (await getRelayDestination(h.ctx.db, created.id))!);
    expect(before).toMatchObject({ ok: false, status: "needs_permission" });
    expect(mock.requests.filter((r) => r === "GET /helix/streams/key")).toHaveLength(0);
    await setRelayStatus(h.ctx.db, created.id, "needs_permission", "Allow SLOT1 to forward to Twitch");

    // "Let SLOT1 forward to Twitch": the extra scope is added, nothing granted before is dropped.
    mock.users.get(CREATOR.id)!.scopes = [...BASE_SCOPES, "channel:read:stream_key"];
    const allowed = await connect(o.twitch.permissionUrl!);
    expect(allowed.scopes).toEqual(["channel:bot", "channel:read:stream_key", "clips:edit"]);
    expect(allowed.redirect).toBe("http://localhost:3000/studio?tab=stream&twitch=connected");
    o = await overview(tw);
    expect(o.twitch.forwardingPermission).toBe(true);
    expect(o.destinations.find((d) => d.id === created.id)).toMatchObject({ status: "idle", statusDetail: null });
    // A later plain reconnect keeps the forwarding permission.
    expect((await connect("/api/auth/twitch/start")).scopes).toEqual(["channel:bot", "channel:read:stream_key", "clips:edit"]);

    const target = await resolveRelayTarget(h.ctx, (await getRelayDestination(h.ctx.db, created.id))!);
    const key = mock.streamKeys.get(CREATOR.id)!;
    expect(key).toMatch(/^live_7001_/);
    expect(target).toEqual({ ok: true, url: `rtmps://ingest.global-contribute.live-video.net/app/${key}`, secrets: [key], host: "ingest.global-contribute.live-video.net" });
    const row = (await getRelayDestination(h.ctx.db, created.id))!;
    expect(row.key_enc).not.toContain(key);
    expect(h.ctx.cipher.decrypt(row.key_enc!)).toBe(key);
    expect(row.key_hint).toBe(key.slice(-4));
    expect(JSON.stringify(await overview(tw))).not.toContain(key);

    // A key reset at Twitch is picked up; during a Twitch outage the last key is used.
    mock.streamKeys.set(CREATOR.id, "live_7001_ResetAtTwitch0000000");
    expect(await resolveRelayTarget(h.ctx, (await getRelayDestination(h.ctx.db, created.id))!)).toMatchObject({ ok: true, secrets: ["live_7001_ResetAtTwitch0000000"] });
    mock.streamKeyOutage = true;
    expect(await resolveRelayTarget(h.ctx, (await getRelayDestination(h.ctx.db, created.id))!)).toMatchObject({ ok: true, secrets: ["live_7001_ResetAtTwitch0000000"] });
    mock.streamKeyOutage = false;

    // Permission withdrawn on Twitch's side: back to asking, never a stale guess.
    mock.users.get(CREATOR.id)!.scopes = [...BASE_SCOPES];
    expect(await resolveRelayTarget(h.ctx, (await getRelayDestination(h.ctx.db, created.id))!)).toMatchObject({ ok: false, status: "needs_permission" });
  });

  it("runs the creator's chat controls against the real settings", async () => {
    const broadcasterId = ((await owner.refreshCsrf()).broadcaster as { id: string }).id;
    const ports = creatorControlPorts(h.ctx, broadcasterId);
    expect(await ports.setRecording(true)).toEqual({ ok: false, message: "Recording needs your OK first: SLOT1 Studio → Library → Recording. Then type !slot1 record on again." });
    expect((await getSettings(h.ctx.db, broadcasterId)).recordingEnabled).toBe(false);

    expect((await owner.request("PATCH", "/api/studio/settings", { json: { recordingConsent: true } })).status).toBe(200);
    expect(await ports.setRecording(true)).toMatchObject({ ok: true, message: expect.stringMatching(/^Recording on\./) });
    expect(await ports.setAutoClips(true)).toMatchObject({ ok: true, message: expect.stringMatching(/^Auto-clips on\. SLOT1 clips/) });
    let s = await getSettings(h.ctx.db, broadcasterId);
    expect(s).toMatchObject({ recordingEnabled: true, autoClips: true });
    await ports.setRecording(false);
    s = await getSettings(h.ctx.db, broadcasterId);
    expect(s.recordingEnabled).toBe(false);

    const statuses = await ports.relayStatus();
    expect(statuses).toEqual(expect.arrayContaining([{ label: "YouTube", status: "waiting for your stream" }, { label: "Kick", status: "off" }]));
    expect(JSON.stringify(statuses)).not.toMatch(/rtmp|:\/\/|abcd-efgh|sk_us/);
  });
});

/* ------------------------------------------------------------------------------------------ */

/**
 * Forwarding end to end: OBS (ffmpeg) publishes to SLOT1's real nginx-rtmp ingest, the real relay
 * supervisor forwards it, copy-only, to a second nginx-rtmp application standing in for a
 * platform, and ffprobe checks what arrived. A second destination fails and retries without
 * affecting the first, and SLOT1 keeps receiving frames for analysis throughout.
 */
describe.skipIf(!hasNginxRtmp || !hasOpenssl)("forwarding a real stream through nginx-rtmp", () => {
  let h: Harness;
  let creator: Browser;
  let nginx: ChildProcess | null = null;
  let live: LiveSupervisor | null = null;
  let relays: RelaySupervisor | null = null;
  let rtmpPort = 0;
  let publishUrl = "";
  let publishPath = "";
  let goodId = "";
  let badId = "";
  let secureId = "";
  let untrustedId = "";
  let certDir = "";
  const tlsServers: TlsServer[] = [];
  const publishers: ChildProcess[] = [];
  const logged: string[] = [];
  const DEST_KEY = `dest-${randomBytes(9).toString("hex")}`;
  const BAD_KEY = `bad-${randomBytes(9).toString("hex")}`;
  const SECURE_KEY = `secure-${randomBytes(9).toString("hex")}`;
  const UNTRUSTED_KEY = `untrusted-${randomBytes(9).toString("hex")}`;

  beforeAll(async () => {
    rtmpPort = await freePort();
    const env = ingestEnv(rtmpPort);
    certDir = await mkdtemp(path.join(tmpdir(), "slot1-relay-tls-"));
    const certs = await makeCertificates(certDir);
    // ffmpeg verifies RTMPS destinations against this CA (production: the system bundle).
    h = await startHarness({ ...env, RELAY_ALLOW_PRIVATE_DESTINATIONS: "true", RELAY_TLS_CA_FILE: certs.caFile });
    // Every log line the relay or the ingest pipeline writes, to prove no key is ever logged.
    const log = h.ctx.log as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      const orig = log[level]!.bind(h.ctx.log);
      log[level] = (...args: unknown[]) => {
        logged.push(JSON.stringify(args));
        return orig(...args);
      };
    }
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = (h.app.server.address() as AddressInfo).port;

    const runDir = path.join(h.storageRoot, "nginx");
    await mkdir(runDir, { recursive: true });
    const conf = readFileSync(path.join(ROOT, "infra/nginx-rtmp/nginx.conf.template"), "utf8")
      .replaceAll("${SLOT1_HOOK_BASE}", `http://127.0.0.1:${apiPort}`)
      .replaceAll("${INGEST_HOOK_SECRET}", env.INGEST_HOOK_SECRET)
      .replaceAll("${INGEST_RTMP_PORT}", String(rtmpPort))
      .replaceAll("${NGINX_RUN_DIR}", runDir)
      // A second, open application standing in for Twitch/YouTube/Kick.
      .replace("    application live {", "    application dest {\n      live on;\n      record off;\n    }\n\n    application live {");
    expect(conf).toContain("application dest {");
    writeFileSync(path.join(runDir, "nginx.conf"), conf);
    nginx = spawn("nginx", ["-c", path.join(runDir, "nginx.conf"), "-p", runDir, "-g", "daemon off;"], { stdio: "ignore" });
    await sleep(500);

    creator = new Browser(h);
    await creator.signInLocal("Relay Streamer");
    const creds = (await creator.request("POST", "/api/studio/relay/ingest-credentials", { json: {} })).json<IngestCredentials>();
    publishUrl = `${creds.server}/${creds.streamKey}`;
    publishPath = (await h.ctx.db.query(`SELECT publish_path FROM media_sources WHERE id = $1`, [creds.sourceId])).rows[0].publish_path;

    const add = async (label: string, serverUrl: string, streamKey: string) => {
      const d = (await creator.request("POST", "/api/studio/relay/destinations", { json: { platform: "custom", label, serverUrl, streamKey } })).json<RelayDestinationView>();
      expect((await creator.request("PATCH", `/api/studio/relay/destinations/${d.id}`, { json: { enabled: true } })).status).toBe(200);
      return d.id;
    };
    goodId = await add("Test platform", `rtmp://127.0.0.1:${rtmpPort}/dest`, DEST_KEY);
    badId = await add("Broken server", `rtmp://127.0.0.1:${await freePort()}/app`, BAD_KEY);
    const secure = await rtmpsProxy(certs.trusted, rtmpPort);
    const untrusted = await rtmpsProxy(certs.untrusted, rtmpPort);
    tlsServers.push(secure.server, untrusted.server);
    secureId = await add("Secure platform", `rtmps://localhost:${secure.port}/dest`, SECURE_KEY);
    untrustedId = await add("Untrusted server", `rtmps://localhost:${untrusted.port}/dest`, UNTRUSTED_KEY);

    live = new LiveSupervisor(h.ctx, "it-relay-live");
    live.start();
    relays = new RelaySupervisor(h.ctx, "it-relay-worker");
    relays.start();
  });

  afterAll(async () => {
    for (const p of publishers) p.kill("SIGKILL");
    await relays?.stopAll();
    await live?.stopAll();
    nginx?.kill("SIGQUIT");
    for (const s of tlsServers) s.close();
    await h?.close();
    if (certDir) await rm(certDir, { recursive: true, force: true });
  });

  function publish(url: string) {
    const p = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", SAMPLE, "-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "flv", url],
      { stdio: "ignore" },
    );
    publishers.push(p);
    return p;
  }

  const dest = async (id: string) => (await overview(creator)).destinations.find((d) => d.id === id);

  /** Async on purpose: the API answering nginx's hooks runs in this same process. */
  function probe(url: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const p = spawn("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-show_entries", "stream=codec_type,codec_name,profile,width,height,pix_fmt,sample_rate,channels", "-of", "json", url]);
      let out = "";
      let err = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => p.kill("SIGKILL"), 40_000);
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`ffprobe failed: ${err}`));
        resolve((JSON.parse(out) as { streams: Record<string, unknown>[] }).streams.sort((a, b) => String(a.codec_type).localeCompare(String(b.codec_type))));
      });
    });
  }

  it("does nothing until the creator streams", async () => {
    await sleep(4000);
    expect(relays!.active()).toEqual([]);
    expect(await dest(goodId)).toMatchObject({ enabled: true, status: "idle" });
  });

  it("forwards the exact stream, unchanged, while the creator streams", async () => {
    publish(publishUrl);
    await waitFor(async () => (await overview(creator)).ingest.publishing, 20_000, "publish hook");
    const good = await waitFor(async () => {
      const d = await dest(goodId);
      return d?.status === "live" ? d : null;
    }, 60_000, "forwarding to go live");
    expect(good.statusDetail).toBe("Forwarding to 127.0.0.1");
    expect(good.lastConnectedAt).not.toBeNull();

    // Copy-only: what the platform receives is stream-for-stream what SLOT1 receives.
    const arrived = await probe(`rtmp://127.0.0.1:${rtmpPort}/dest/${DEST_KEY}`);
    const source = await probe(buildReadUrl(h.ctx, publishPath));
    expect(arrived).toEqual(source);
    expect(arrived).toEqual([
      expect.objectContaining({ codec_type: "audio", codec_name: "aac" }),
      expect.objectContaining({ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }),
    ]);

    // RTMPS (what Twitch, YouTube and Kick use) with the server's certificate verified.
    const secure = await waitFor(async () => {
      const d = await dest(secureId);
      return d?.status === "live" ? d : null;
    }, 60_000, "RTMPS forwarding to go live");
    expect(secure.statusDetail).toBe("Forwarding to localhost");
    expect(await probe(`rtmp://127.0.0.1:${rtmpPort}/dest/${SECURE_KEY}`)).toEqual(source);
  });

  it("retries a failing destination with backoff, without touching the others or SLOT1's own analysis", async () => {
    const bad = await waitFor(async () => {
      const d = await dest(badId);
      return d?.status === "retrying" && /Retrying in (4|8|16|32)s$/.test(d.statusDetail ?? "") ? d : null;
    }, 45_000, "backoff to grow");
    expect(bad.statusDetail).toMatch(/^Lost 127\.0\.0\.1: Connection refused\. Retrying in \d+s$/);
    expect(bad.lastConnectedAt).toBeNull();
    // An RTMPS server whose certificate isn't trusted never gets the key.
    const untrusted = await waitFor(async () => {
      const d = await dest(untrustedId);
      return d?.status === "retrying" && d.statusDetail ? d : null;
    }, 45_000, "untrusted RTMPS server to be refused");
    expect(untrusted.statusDetail).toMatch(/^Lost localhost: The server's TLS certificate couldn't be verified\. Retrying in \d+s$/);
    expect(untrusted.lastConnectedAt).toBeNull();
    expect(await dest(goodId)).toMatchObject({ status: "live" });
    expect(await dest(secureId)).toMatchObject({ status: "live" });

    // SLOT1 keeps receiving the creator's frames for analysis the whole time.
    await waitFor(async () => {
      const s = (await creator.get("/api/studio")).json();
      return s.readiness.find((x: { id: string }) => x.id === "video_source_ready")?.status === "done";
    }, 40_000, "SLOT1 to receive frames while forwarding");

    // A new OBS key would cut the stream: refused while live.
    const rotate = await creator.request("POST", "/api/studio/relay/ingest-credentials", { json: {} });
    expect(rotate.status).toBe(409);
    expect(rotate.json().error.message).toBe("You're streaming to SLOT1 right now");
  });

  it("stops forwarding to a destination that is switched off, and resumes when it's back on", async () => {
    await creator.request("PATCH", `/api/studio/relay/destinations/${goodId}`, { json: { enabled: false } });
    await waitFor(async () => !relays!.active().includes(goodId), 15_000, "relay to stop");
    expect(await dest(goodId)).toMatchObject({ enabled: false, status: "disabled" });
    await creator.request("PATCH", `/api/studio/relay/destinations/${goodId}`, { json: { enabled: true } });
    await waitFor(async () => (await dest(goodId))?.status === "live", 60_000, "forwarding to resume");
  });

  it("stops every relay when the creator stops streaming, and never forwards a TEST source", async () => {
    for (const p of publishers) p.kill("SIGINT");
    await waitFor(async () => !(await overview(creator)).ingest.publishing, 30_000, "publish to end");
    await waitFor(async () => relays!.active().length === 0, 20_000, "relays to stop");
    await waitFor(async () => {
      const all = (await overview(creator)).destinations;
      return all.length === 4 && all.every((d) => d.status === "idle");
    }, 15_000, "idle statuses");
    expect((await dest(goodId))!.lastConnectedAt).not.toBeNull();

    const test = (await creator.request("POST", "/api/studio/sources", { json: { name: "Replay loop", label: "test" } })).json<{ publishUrl: string; source: { id: string } }>();
    publish(test.publishUrl);
    await waitFor(async () => (await h.ctx.db.query(`SELECT 1 FROM media_sources WHERE id = $1 AND status = 'publishing'`, [test.source.id])).rowCount, 20_000, "TEST publish");
    await sleep(8000);
    expect(relays!.active()).toEqual([]);
    expect(await dest(goodId)).toMatchObject({ status: "idle" });
  });

  it("never wrote a stream key to a log or a status", async () => {
    const all = logged.join("\n");
    for (const secret of [DEST_KEY, BAD_KEY, SECURE_KEY, UNTRUSTED_KEY]) {
      expect(all).not.toContain(secret);
      const { rows } = await h.ctx.db.query(`SELECT count(*)::int AS n FROM relay_destinations WHERE status_detail LIKE $1`, [`%${secret}%`]);
      expect(rows[0].n).toBe(0);
    }
    expect(logged.some((l) => l.includes("relay disconnected"))).toBe(true);
  });
});
