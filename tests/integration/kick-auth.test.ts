import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, ORIGIN, startHarness, type Harness } from "./harness";

/**
 * Mock Kick: just enough of id.kick.com (OAuth 2.1 with PKCE) and the public API to run SLOT1's real
 * "Sign in with Kick" code. The token endpoint checks the PKCE verifier against the challenge the
 * authorize step received, the way Kick does.
 */
class MockKick {
  server: Server;
  base = "";
  users = new Map<string, { id: number; name: string; slug: string; picture: string }>();
  /** code → who approved it, and the PKCE challenge and redirect URI it was issued for. */
  codes = new Map<string, { userId: number; challenge: string; redirectUri: string; scope: string }>();
  tokens = new Map<string, number>();
  revoked: string[] = [];
  exchanges: Record<string, string>[] = [];
  /** Answers the next token exchange with this status. */
  failNextExchange: number | null = null;
  private n = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  env(): Record<string, string> {
    return { KICK_CLIENT_ID: "mockkickclient01", KICK_CLIENT_SECRET: "mockkicksecret0123456789", KICK_ID_BASE: this.base, KICK_API_BASE: `${this.base}/public/v1` };
  }

  /** What Kick does when the person approves on its consent screen. */
  approve(authorizeUrl: string, userId: number): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const code = `kcode-${++this.n}`;
    this.codes.set(code, { userId, challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")!, scope: u.searchParams.get("scope")! });
    return { code, state: u.searchParams.get("state")! };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      if (form.get("client_id") !== "mockkickclient01" || form.get("client_secret") !== "mockkicksecret0123456789") return send(401, { error: "invalid_client" });
      if (form.get("grant_type") === "client_credentials") return send(200, { access_token: "app-token", token_type: "Bearer", expires_in: 3600 });
      this.exchanges.push(Object.fromEntries(form));
      if (this.failNextExchange) {
        const status = this.failNextExchange;
        this.failNextExchange = null;
        return send(status, { error: "nope" });
      }
      const c = this.codes.get(form.get("code") ?? "");
      if (!c) return send(400, { error: "invalid_grant" });
      this.codes.delete(form.get("code")!);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== c.challenge || form.get("redirect_uri") !== c.redirectUri) return send(400, { error: "invalid_grant" });
      const token = `kuser-${c.userId}-${++this.n}`;
      this.tokens.set(token, c.userId);
      return send(200, { access_token: token, refresh_token: `kref-${this.n}`, token_type: "Bearer", expires_in: 3600, scope: c.scope });
    }
    if (url.pathname === "/oauth/revoke" && req.method === "POST") {
      this.revoked.push(url.searchParams.get("token") ?? "");
      res.writeHead(200);
      return res.end("OK");
    }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const userId = this.tokens.get(auth);
    if (url.pathname === "/public/v1/users") {
      const u = [...this.users.values()].find((x) => x.id === userId);
      if (!u) return send(401, { message: "Unauthorized" });
      return send(200, { data: [{ user_id: u.id, name: u.name, email: "someone@example.com", profile_picture: u.picture }], message: "OK" });
    }
    if (url.pathname === "/public/v1/channels") {
      const slugs = url.searchParams.getAll("slug");
      const list = slugs.length ? [...this.users.values()].filter((x) => slugs.includes(x.slug)) : [...this.users.values()].filter((x) => x.id === userId);
      if (!slugs.length && userId === undefined) return send(401, { message: "Unauthorized" });
      return send(200, {
        data: list.map((x) => ({ slug: x.slug, broadcaster_user_id: x.id, stream_title: "", category: null, stream: { is_live: false }, active_subscribers_count: 7 })),
        message: "OK",
      });
    }
    send(404, { message: "not found" });
  }
}

describe("Sign in with Kick", () => {
  let kick: MockKick;
  let h: Harness;

  beforeAll(async () => {
    kick = await new MockKick().start();
    kick.users.set("1", { id: 4101, name: "RaeGTA", slug: "rae_gta", picture: "https://files.kick.com/images/user/4101/profile.webp" });
    kick.users.set("2", { id: 4102, name: "chatfan", slug: "chatfan", picture: "" });
    h = await startHarness(kick.env());
  });

  afterAll(async () => {
    await h?.close();
    await kick?.stop();
  });

  const start = async (b: Browser, query: string) => {
    const r = await b.get(`/api/auth/kick/start${query}`);
    expect(r.status).toBe(302);
    return String(r.headers.location);
  };

  it("connects a creator's Kick channel with PKCE, then drops Kick's token", async () => {
    const b = new Browser(h);
    const authorize = await start(b, "");
    const u = new URL(authorize);
    expect(`${u.origin}${u.pathname}`).toBe(`${kick.base}/oauth/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "mockkickclient01",
      redirect_uri: `${ORIGIN}/api/auth/kick/callback`,
      scope: "user:read channel:read",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { code, state } = kick.approve(authorize, 4101);
    const cb = await b.get(`/api/auth/kick/callback?code=${code}&state=${state}`);
    expect(cb.status).toBe(302);
    const back = new URL(String(cb.headers.location));
    expect(back.searchParams.get("kick")).toBe("connected");
    // The verifier went to Kick's token endpoint and matched the challenge (the mock checks it).
    expect(kick.exchanges.at(-1)?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // Kick's token is revoked right after (in the background, so the redirect doesn't wait on it).
    await expect.poll(() => kick.revoked.length, { timeout: 3000 }).toBe(1);

    const me = await b.refreshCsrf();
    expect(me.user).toMatchObject({ kind: "kick", displayName: "RaeGTA", isOperator: false });
    expect(me.broadcaster).toMatchObject({ kind: "kick", login: "kick-rae_gta", displayName: "RaeGTA" });
    // Kick's email is never stored.
    const { rows } = await h.ctx.db.query(`SELECT * FROM users WHERE kick_user_id = '4101'`);
    expect(JSON.stringify(rows)).not.toContain("example.com");

    const studio = (await b.get("/api/studio")).json<{ readiness: { id: string; status: string; label: string }[]; twitch: { linked: boolean } }>();
    expect(studio.twitch.linked).toBe(false);
    expect(studio.readiness.find((s) => s.id === "kick_connected")).toMatchObject({ status: "done", label: "Kick connected" });
    expect(studio.readiness.find((s) => s.id === "bot_ready")?.status).toBe("unavailable");

    // Its channel page is a SLOT1 channel on Kick, and it can be made public and listed.
    const own = (await b.get("/api/channels/kick-rae_gta/watch")).json<{ authorized: boolean; channel: { platform?: string; twitchUrl: string } }>();
    expect(own).toMatchObject({ authorized: true, channel: { platform: "kick", twitchUrl: "" } });
    expect((await b.request("PATCH", "/api/studio/settings", { json: { visibility: "public", directoryOptIn: true } })).status).toBe(200);
    const anon = (await new Browser(h).get("/api/channels/kick-rae_gta/watch")).json<{ authorized: boolean }>();
    expect(anon.authorized).toBe(true);
    const dir = (await new Browser(h).get("/api/channels")).json<{ channels: { login: string; platform?: string; preview?: boolean }[] }>();
    expect(dir.channels.find((c) => c.login === "kick-rae_gta")).toMatchObject({ platform: "kick" });
    expect(dir.channels.find((c) => c.login === "kick-rae_gta")?.preview).toBeUndefined();

    // Signing in again finds the same account and channel.
    const b2 = new Browser(h);
    const again = kick.approve(await start(b2, ""), 4101);
    await b2.get(`/api/auth/kick/callback?code=${again.code}&state=${again.state}`);
    const me2 = await b2.refreshCsrf();
    expect(me2.broadcaster).toMatchObject({ id: (me.broadcaster as { id: string }).id });
  });

  it("signs a viewer in to chat with only user:read, and they can post in SLOT1 chat", async () => {
    const b = new Browser(h);
    const authorize = await start(b, "?role=viewer&returnTo=%2Fwatch%2Fkick-lazenxd%3Fchat%3Dslot1");
    expect(new URL(authorize).searchParams.get("scope")).toBe("user:read");
    const { code, state } = kick.approve(authorize, 4102);
    const cb = await b.get(`/api/auth/kick/callback?code=${code}&state=${state}`);
    expect(String(cb.headers.location)).toBe(`${ORIGIN}/watch/kick-lazenxd?chat=slot1&kick=signed_in`);
    const me = await b.refreshCsrf();
    expect(me.user).toMatchObject({ kind: "kick", displayName: "chatfan" });
    expect(me.broadcaster).toBeNull();
    const posted = await b.request("POST", "/api/chat/kick-lazenxd/messages", { json: { text: "hello from Kick" } });
    expect(posted.status).toBe(201);
  });

  it("refuses states that are reused, unknown, or from a cancelled or failed sign-in", async () => {
    const b = new Browser(h);
    const authorize = await start(b, "");
    const { code, state } = kick.approve(authorize, 4102);
    // Cancelled on Kick.
    const denied = await b.get(`/api/auth/kick/callback?error=access_denied&state=${state}`);
    expect(new URL(String(denied.headers.location)).searchParams.get("kick")).toBe("denied");
    // The state was used up by that answer.
    const reused = await b.get(`/api/auth/kick/callback?code=${code}&state=${state}`);
    expect(Object.fromEntries(new URL(String(reused.headers.location)).searchParams)).toMatchObject({ kick: "error", why: "expired" });
    // Another browser can't finish someone else's sign-in.
    const other = kick.approve(await start(b, ""), 4102);
    const stolen = await new Browser(h).get(`/api/auth/kick/callback?code=${other.code}&state=${other.state}`);
    expect(new URL(String(stolen.headers.location)).searchParams.get("why")).toBe("expired");
    // Kick refusing the app's credentials is the site's problem, said so.
    const fresh = kick.approve(await start(b, ""), 4102);
    kick.failNextExchange = 401;
    const app = await b.get(`/api/auth/kick/callback?code=${fresh.code}&state=${fresh.state}`);
    expect(new URL(String(app.headers.location)).searchParams.get("why")).toBe("app");
    expect((await b.refreshCsrf()).user).toBeNull();
  });

  it("a Kick state can't finish a Twitch sign-in", async () => {
    const t = await startHarness({ ...kick.env(), TWITCH_CLIENT_ID: "x", TWITCH_CLIENT_SECRET: "y", TWITCH_REDIRECT_URI: `${ORIGIN}/api/auth/twitch/callback` });
    try {
      const b = new Browser(t);
      const { state } = kick.approve(String((await b.get("/api/auth/kick/start")).headers.location), 4102);
      const r = await b.get(`/api/auth/twitch/callback?code=abc&state=${state}`);
      expect(new URL(String(r.headers.location)).searchParams.get("why")).toBe("expired");
    } finally {
      await t.close();
    }
  });

  it("says Sign in with Kick isn't open when the site has no Kick app", async () => {
    const bare = await startHarness();
    try {
      const r = await new Browser(bare).get("/api/auth/kick/start?returnTo=%2Fstudio");
      expect(r.status).toBe(302);
      expect(String(r.headers.location)).toBe(`${ORIGIN}/studio?kick=error&why=not_configured`);
    } finally {
      await bare.close();
    }
  });
});
