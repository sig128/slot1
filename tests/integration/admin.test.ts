import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminMessagesResponse, AdminOverview } from "@slot1/contracts";
import {
  createIngestSession,
  createIngestSource,
  createLocalBroadcaster,
  createLocalUser,
  insertContactMessage,
  insertPageView,
  markPublishing,
  pruneContactMessages,
  rollupAndPruneAnalytics,
  setSourceSession,
} from "@slot1/db";
import { mintAdminLink } from "../../apps/api/src/lib/admin-session";
import { dailySalt, PRESENCE_KEY, resetSaltCache, visitorId } from "../../apps/api/src/lib/visitors";
import { clearAdminCache } from "../../apps/api/src/routes/admin";
import { Browser, ORIGIN, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0";
const IP = "203.0.113.7";

/**
 * The operator dashboard against the real API, SQL and Redis: cookieless page-view counting
 * (what is stored and what never is), presence, retention, who may open /admin, the one-time
 * admin link and the contact inbox.
 */
describe("Admin dashboard, analytics and contact", () => {
  let h: Harness;
  let operator: Browser;
  let anon: Browser;

  async function clearLimits() {
    const keys = [...(await h.ctx.redis.keys("slot1-api-rl:*")), ...(await h.ctx.redis.keys("slot1:contact:*"))];
    if (keys.length) await h.ctx.redis.del(...keys);
  }

  async function makeOperator(name: string): Promise<Browser> {
    const b = new Browser(h);
    const me = await b.signInLocal(name);
    await h.ctx.db.query(`UPDATE users SET is_operator = true WHERE id = $1`, [(me.user as { id: string }).id]);
    await b.refreshCsrf();
    return b;
  }

  function collect(body: unknown, headers: Record<string, string | undefined> = {}) {
    const base: Record<string, string> = { origin: ORIGIN, "user-agent": CHROME, "x-forwarded-for": IP, "content-type": "text/plain;charset=UTF-8" };
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    return h.app.inject({ method: "POST", url: "/api/analytics/collect", headers: base, payload: typeof body === "string" ? body : JSON.stringify(body) });
  }
  function ping(body: unknown, headers: Record<string, string> = {}) {
    return h.app.inject({
      method: "POST",
      url: "/api/analytics/ping",
      headers: { origin: ORIGIN, "user-agent": CHROME, "x-forwarded-for": IP, "content-type": "text/plain;charset=UTF-8", ...headers },
      payload: JSON.stringify(body),
    });
  }
  async function overview(b: Browser, range: 7 | 30 = 30) {
    clearAdminCache();
    const r = await b.get(`/api/admin/overview?range=${range}`);
    expect(r.status, r.body).toBe(200);
    return AdminOverview.parse(r.json());
  }
  const pageViews = async () => (await h.ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM page_views`)).rows[0]!.n;

  beforeAll(async () => {
    // Behind Caddy in production: the client address comes from X-Forwarded-For.
    h = await startHarness({ SLOT1_TRUST_PROXY: "true" });
    await clearLimits();
    operator = await makeOperator("Admin Operator");
    anon = new Browser(h);
    await anon.refreshCsrf();
  });
  afterAll(async () => {
    await clearLimits();
    await h?.close();
  });
  beforeEach(async () => {
    await h.ctx.db.query(`DELETE FROM page_views; DELETE FROM analytics_daily; DELETE FROM contact_messages;`);
    const keys = await h.ctx.redis.keys("slot1:analytics:*");
    if (keys.length) await h.ctx.redis.del(...keys);
    resetSaltCache();
  });

  describe("visitor counting", () => {
    it("counts a page view without storing the IP, the User-Agent or any cookie", async () => {
      const r = await collect({ p: "/watch/SomeCreator?utm_source=x#chat", r: "https://www.google.com/search?q=slot1", b: "l" });
      expect(r.statusCode).toBe(204);
      expect(r.headers["set-cookie"]).toBeUndefined();
      const { rows } = await h.ctx.db.query<{ path: string; referrer_host: string; device: string; browser: string; visitor_id: Buffer; json: string }>(
        `SELECT path, referrer_host, device, browser, visitor_id, row_to_json(p)::text AS json FROM page_views p`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ path: "/watch/SomeCreator", referrer_host: "google.com", device: "desktop", browser: "chrome" });
      expect(row.visitor_id).toHaveLength(16);
      // Neither the address nor the browser string is stored, in any column.
      expect(row.json).not.toContain(IP);
      expect(row.json).not.toContain("Chrome/141");
      expect(row.json).not.toContain("utm_source");
      // The ID is SHA-256(today's salt + IP + User-Agent + site host), cut to 16 bytes.
      const expected = visitorId(await dailySalt(h.ctx.redis), IP, CHROME, new URL(ORIGIN).host);
      expect(row.visitor_id.equals(expected)).toBe(true);
      // Nothing in Redis carries the address either.
      for (const k of await h.ctx.redis.keys("*")) expect(k).not.toContain(IP);
    });

    it("classifies devices and browsers, and keeps only the referrer's host", async () => {
      await collect({ p: "/", b: "s" }, { "user-agent": IPHONE, "x-forwarded-for": "198.51.100.1" });
      await collect({ p: "/los-santos", r: "t.co", b: "l" }, { "user-agent": FIREFOX, "x-forwarded-for": "198.51.100.2" });
      await collect({ p: "/setup", r: "http://localhost:3000/elsewhere", b: "l" });
      const { rows } = await h.ctx.db.query<{ path: string; device: string; browser: string; referrer_host: string | null }>(`SELECT path, device, browser, referrer_host FROM page_views ORDER BY id`);
      expect(rows).toEqual([
        { path: "/", device: "mobile", browser: "safari", referrer_host: null },
        { path: "/los-santos", device: "desktop", browser: "firefox", referrer_host: "t.co" },
        // Our own site as referrer is internal navigation, not a source.
        { path: "/setup", device: "desktop", browser: "chrome", referrer_host: null },
      ]);
    });

    it("never counts Do Not Track, Global Privacy Control, bots, other sites or the admin pages", async () => {
      const skipped = [
        collect({ p: "/" }, { dnt: "1" }),
        collect({ p: "/" }, { "sec-gpc": "1" }),
        collect({ p: "/" }, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }),
        collect({ p: "/" }, { "user-agent": "curl/8.9.1" }),
        collect({ p: "/" }, { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36" }),
        collect({ p: "/" }, { "user-agent": "" }),
        collect({ p: "/" }, { origin: "https://evil.example" }),
        collect({ p: "/" }, { origin: undefined, "sec-fetch-site": "cross-site" }),
        collect({ p: "/admin" }),
        collect({ p: "/admin/messages" }),
        collect({ p: "/api/admin/overview" }),
        collect({ p: "no-slash" }),
        collect("not json"),
        ping({ p: "/" }, { dnt: "1" }),
      ];
      for (const r of await Promise.all(skipped)) expect(r.statusCode).toBe(204);
      expect(await pageViews()).toBe(0);
      expect(await h.ctx.redis.zcard(PRESENCE_KEY)).toBe(0);
      // Same-origin requests without an Origin header still count (Sec-Fetch-Site says so).
      expect((await collect({ p: "/" }, { origin: undefined, "sec-fetch-site": "same-origin" })).statusCode).toBe(204);
      expect(await pageViews()).toBe(1);
    });

    it("uses a new random salt each UTC day and lets it expire within 48 hours", async () => {
      const now = Date.now();
      const today = await dailySalt(h.ctx.redis, now);
      expect(await dailySalt(h.ctx.redis, now)).toEqual(today);
      const tomorrow = await dailySalt(h.ctx.redis, now + 86_400_000);
      expect(tomorrow.equals(today)).toBe(false);
      const host = new URL(ORIGIN).host;
      expect(visitorId(today, IP, CHROME, host).equals(visitorId(tomorrow, IP, CHROME, host))).toBe(false);
      const day = new Date(now).toISOString().slice(0, 10);
      const ttl = await h.ctx.redis.pttl(`slot1:analytics:salt:${day}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(48 * 3600 * 1000);
      resetSaltCache();
    });

    it("keeps daily totals and deletes raw page views after 90 days", async () => {
      const id = () => randomBytes(16);
      const a = id();
      const old = new Date(Date.now() - 100 * 86_400_000);
      for (const v of [a, a, id()]) await insertPageView(h.ctx.db, { path: "/", referrerHost: null, device: "desktop", browser: "chrome", visitorId: v, at: old });
      await insertPageView(h.ctx.db, { path: "/setup", referrerHost: null, device: "mobile", browser: "safari", visitorId: id(), at: new Date(Date.now() - 10 * 86_400_000) });
      await insertPageView(h.ctx.db, { path: "/", referrerHost: null, device: "desktop", browser: "chrome", visitorId: id() });

      const first = await rollupAndPruneAnalytics(h.ctx.db);
      expect(first.rowsDeleted).toBe(3);
      expect(await pageViews()).toBe(2);
      const oldDay = old.toISOString().slice(0, 10);
      const { rows } = await h.ctx.db.query<{ day: string; views: number; visitors: number }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, views, visitors FROM analytics_daily ORDER BY day`);
      expect(rows[0]).toEqual({ day: oldDay, views: 3, visitors: 2 });
      // Completed days are rolled up; today is not (it isn't over yet).
      expect(rows.map((r) => r.day)).not.toContain(new Date().toISOString().slice(0, 10));
      // Idempotent.
      await rollupAndPruneAnalytics(h.ctx.db);
      expect((await h.ctx.db.query(`SELECT views, visitors FROM analytics_daily WHERE day = $1`, [oldDay])).rows[0]).toEqual({ views: 3, visitors: 2 });

      const o = await overview(operator);
      expect(o.visitors.allTimeViews).toBe(5);
      expect(o.visitors.since).toBe(oldDay);
      expect(o.visitors.today).toEqual({ views: 1, visitors: 1 });
      expect(o.visitors.last30).toEqual({ views: 2, visitors: 2 });
      expect(o.visitors.days).toHaveLength(30);
      expect(o.visitors.days.at(-1)).toMatchObject({ views: 1, visitors: 1 });
    });

    it("sums unique visitors per day and ranks pages, sources, devices and browsers", async () => {
      await collect({ p: "/", r: "google.com", b: "l" });
      await collect({ p: "/los-santos", b: "l" });
      await collect({ p: "/" }, { "user-agent": IPHONE, "x-forwarded-for": "198.51.100.9" });
      const o = await overview(operator, 7);
      expect(o.visitors.today).toEqual({ views: 3, visitors: 2 });
      expect(o.visitors.range.days).toBe(7);
      expect(o.visitors.range.pages[0]).toEqual({ key: "/", views: 2, visitors: 2 });
      expect(o.visitors.range.referrers).toEqual([{ key: "google.com", views: 1, visitors: 1 }]);
      expect(o.visitors.range.devices.map((d) => d.key).sort()).toEqual(["desktop", "mobile"]);
      expect(o.visitors.range.browsers.map((d) => d.key).sort()).toEqual(["chrome", "safari"]);
    });
  });

  describe("on the site now", () => {
    it("counts people per page and viewers per live stream; stale entries drop out", async () => {
      const user = await createLocalUser(h.ctx.db, "Live Creator");
      const login = `vinewood${randomBytes(3).toString("hex")}`;
      const b = await createLocalBroadcaster(h.ctx.db, user.id, login, "Vinewood Live");
      const source = await createIngestSource(h.ctx.db, { broadcasterId: b.id, name: "OBS", label: "live", publishPath: `live/${randomBytes(6).toString("hex")}`, keyHash: randomBytes(32), keyHint: "abcd" });
      const session = await createIngestSession(h.ctx.db, b.id, "live", "Heist night", "public", 5000);
      await setSourceSession(h.ctx.db, source.id, session.id);
      await markPublishing(h.ctx.db, source.id, null);

      await collect({ p: `/watch/${login}` }, { "x-forwarded-for": "198.51.100.30" });
      await collect({ p: "/" }, { "x-forwarded-for": "198.51.100.31" });
      // The second visitor moves on; the heartbeat carries the new page.
      await ping({ p: "/los-santos" }, { "x-forwarded-for": "198.51.100.31" });
      // Someone last seen two minutes ago is no longer "on the site now".
      await h.ctx.redis.zadd(PRESENCE_KEY, Date.now() - 120_000, "00".repeat(16));

      const o = await overview(operator);
      expect(o.now.online).toBe(2);
      expect(o.now.byPath).toEqual(
        expect.arrayContaining([
          { path: `/watch/${login}`, visitors: 1 },
          { path: "/los-santos", visitors: 1 },
        ]),
      );
      const live = o.now.live.find((l) => l.login === login);
      expect(live).toMatchObject({ displayName: "Vinewood Live", source: "ingest", visibility: "public", viewers: 1, title: "Heist night" });
      expect(o.platform.sessions.liveNow).toBeGreaterThanOrEqual(1);
      // Presence expires on its own.
      expect(await h.ctx.redis.pttl(PRESENCE_KEY)).toBeLessThanOrEqual(300_000);
      for (const k of await h.ctx.redis.keys("slot1:analytics:presence:path:*")) expect(await h.ctx.redis.ttl(k)).toBeLessThanOrEqual(300);
    });
  });

  describe("who may open /admin", () => {
    it("answers 404 to anonymous visitors and to signed-in non-operators", async () => {
      const someone = new Browser(h);
      await someone.signInLocal("Regular Creator");
      const id = "00000000-0000-4000-8000-000000000000";
      for (const b of [anon, someone]) {
        expect((await b.get("/api/admin/overview")).status).toBe(404);
        expect((await b.get("/api/admin/messages")).status).toBe(404);
        expect((await b.request("PATCH", `/api/admin/messages/${id}`, { json: { status: "closed" } })).status).toBe(404);
        expect((await b.request("DELETE", `/api/admin/messages/${id}`)).status).toBe(404);
      }
      const r = await operator.get("/api/admin/overview");
      expect(r.status).toBe(200);
      expect(r.headers["x-robots-tag"]).toContain("noindex");
      const o = AdminOverview.parse(r.json());
      expect(o.access).toBe("operator");
      expect(o.system.queues.length).toBeGreaterThan(0);
    });
  });

  describe("one-time admin link", () => {
    async function openLink(url: string) {
      const u = new URL(url);
      return h.app.inject({ method: "GET", url: `${u.pathname}${u.search}` });
    }
    async function useLink(url: string, origin: string = ORIGIN) {
      const token = new URL(url).searchParams.get("token")!;
      return h.app.inject({
        method: "POST",
        url: "/api/admin/link",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ token }).toString(),
      });
    }
    const adminCookie = (r: { headers: Record<string, unknown> }) => {
      const set = r.headers["set-cookie"];
      const c = (Array.isArray(set) ? set : [set]).find((x) => typeof x === "string" && x.startsWith("slot1_admin=")) as string | undefined;
      return c ?? null;
    };

    it("works once within 15 minutes, opens /admin only, and signs out", async () => {
      const { url } = await mintAdminLink(h.ctx);
      expect(url.startsWith(`${ORIGIN}/api/admin/link?token=`)).toBe(true);
      // Opening shows a confirmation page; it doesn't use the link up (link previews can't).
      const page = await openLink(url);
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain('action="/api/admin/link"');
      expect((await openLink(url)).statusCode).toBe(200);

      const r = await useLink(url);
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe("/admin");
      const cookie = adminCookie(r);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);

      const b = new Browser(h);
      await b.refreshCsrf();
      b.cookie = `${b.cookie}; ${cookie!.split(";")[0]}`;
      const o = AdminOverview.parse((await b.get("/api/admin/overview")).json());
      expect(o.access).toBe("admin_link");
      expect((await b.get("/api/admin/messages")).status).toBe(200);
      // An admin session is not an operator account: operator-only routes elsewhere stay closed.
      expect((await b.request("POST", "/api/training/datasets", { json: {} })).status).toBe(404);

      // Second use, and the confirmation page after use: expired.
      expect((await useLink(url)).statusCode).toBe(410);
      expect((await openLink(url)).statusCode).toBe(410);

      expect((await b.request("POST", "/api/admin/logout")).status).toBe(204);
      expect((await b.get("/api/admin/overview")).status).toBe(404);
    });

    it("refuses tampered, expired and cross-site uses", async () => {
      const { url } = await mintAdminLink(h.ctx);
      const tampered = url.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      expect((await openLink(tampered)).statusCode).toBe(410);
      expect((await useLink(tampered)).statusCode).toBe(410);
      expect((await useLink(url, "https://evil.example")).statusCode).toBe(403);
      // The cross-site attempt didn't use it up.
      expect((await useLink(url)).statusCode).toBe(303);

      const expired = await mintAdminLink(h.ctx, Date.now() - 16 * 60_000);
      expect((await openLink(expired.url)).statusCode).toBe(410);
      expect((await useLink(expired.url)).statusCode).toBe(410);
      expect((await h.app.inject({ method: "GET", url: "/api/admin/link?token=nonsense" })).statusCode).toBe(410);
    });

    it("the CLI prints a working link in production mode with local sign-in off", async () => {
      const env = h.ctx.config.env;
      const prod = await startHarness({ NODE_ENV: "production", SLOT1_ALLOW_LOCAL_LOGIN: "false", SLOT1_SESSION_SECRET: env.SLOT1_SESSION_SECRET!, SLOT1_TOKEN_ENCRYPTION_KEYS: env.SLOT1_TOKEN_ENCRYPTION_KEYS! });
      try {
        const { stdout } = await exec(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "apps/api/src/admin-link.ts")], {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "production",
            DATABASE_URL: env.DATABASE_URL,
            REDIS_URL: env.REDIS_URL,
            SLOT1_PUBLIC_ORIGIN: ORIGIN,
            SLOT1_SESSION_SECRET: env.SLOT1_SESSION_SECRET ?? undefined,
            SLOT1_TOKEN_ENCRYPTION_KEYS: env.SLOT1_TOKEN_ENCRYPTION_KEYS ?? undefined,
            SLOT1_ALLOW_LOCAL_LOGIN: "false",
            OCR_ENABLED: "false",
          },
          timeout: 60_000,
        });
        const last = stdout.trim().split("\n").at(-1)!;
        expect(last.startsWith(`${ORIGIN}/api/admin/link?token=`)).toBe(true);
        expect(prod.ctx.config.isProduction).toBe(true);
        const u = new URL(last);
        expect((await prod.app.inject({ method: "GET", url: `${u.pathname}${u.search}` })).statusCode).toBe(200);
        const r = await prod.app.inject({
          method: "POST",
          url: "/api/admin/link",
          headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
          payload: new URLSearchParams({ token: u.searchParams.get("token")! }).toString(),
        });
        expect(r.statusCode).toBe(303);
        // Production cookies are Secure.
        expect(adminCookie(r)).toMatch(/Secure/i);
      } finally {
        await prod.close();
      }
    });
  });

  describe("contact form and inbox", () => {
    const valid = { name: "  Ana  ", email: "ana@example.com", topic: "privacy", message: "Please delete everything about my channel." };

    it("stores a valid message (CSRF required) for operators only", async () => {
      expect((await anon.request("POST", "/api/contact", { json: valid, csrf: false })).status).toBe(403);
      const r = await anon.request("POST", "/api/contact", { json: valid, headers: { "x-forwarded-for": "198.51.100.40" } });
      expect(r.status, r.body).toBe(202);
      const list = AdminMessagesResponse.parse((await operator.get("/api/admin/messages?status=open")).json());
      expect(list.counts).toEqual({ open: 1, closed: 0 });
      expect(list.messages[0]).toMatchObject({ name: "Ana", email: "ana@example.com", topic: "privacy", status: "open", closedAt: null });
      expect((await anon.get("/api/admin/messages")).status).toBe(404);
      // No IP in the stored row or in the rate-limit counter's key.
      const { rows } = await h.ctx.db.query<{ json: string }>(`SELECT row_to_json(c)::text AS json FROM contact_messages c`);
      expect(rows[0]!.json).not.toContain("198.51.100.40");
      for (const k of await h.ctx.redis.keys("slot1:contact:*")) expect(k).not.toContain("198.51.100.40");
    });

    it("validates fields, counts characters like people do, and ignores the honeypot", async () => {
      const send = (body: object) => anon.request("POST", "/api/contact", { json: { ...valid, ...body }, headers: { "x-forwarded-for": "198.51.100.41" } });
      expect((await send({ message: "too short" })).status).toBe(400);
      expect((await send({ message: "x".repeat(5001) })).status).toBe(400);
      expect((await send({ email: "not-an-email" })).status).toBe(400);
      expect((await send({ topic: "complaints" })).status).toBe(400);
      // Ten emoji are ten characters (twenty UTF-16 units): accepted and stored.
      expect((await send({ message: "🎮".repeat(10), name: "" })).status).toBe(202);
      const honeypot = await send({ website: "https://spam.example" });
      expect(honeypot.status).toBe(202);
      const { rows } = await h.ctx.db.query<{ name: string | null; message: string }>(`SELECT name, message FROM contact_messages`);
      expect(rows).toEqual([{ name: null, message: "🎮".repeat(10) }]);
    });

    it("limits each address to 5 messages an hour", async () => {
      const from = (ip: string) => anon.request("POST", "/api/contact", { json: valid, headers: { "x-forwarded-for": ip } });
      for (let i = 0; i < 5; i++) expect((await from("198.51.100.50")).status).toBe(202);
      const sixth = await from("198.51.100.50");
      expect(sixth.status).toBe(429);
      expect(sixth.json().error.message).toMatch(/5 messages in the last hour/);
      expect((await from("198.51.100.51")).status).toBe(202);
      const keys = await h.ctx.redis.keys("slot1:contact:*");
      for (const k of keys) {
        const ttl = await h.ctx.redis.ttl(k);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(3600);
      }
    });

    it("operators close, reopen, page through and delete; old messages expire after 24 months", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await insertContactMessage(h.ctx.db, { name: null, email: `p${i}@example.com`, topic: "general", message: `Message number ${i} here`, at: new Date(Date.now() - (3 - i) * 60_000) }));
      const page1 = AdminMessagesResponse.parse((await operator.get("/api/admin/messages?status=all&limit=2")).json());
      expect(page1.messages.map((m) => m.email)).toEqual(["p2@example.com", "p1@example.com"]);
      expect(page1.nextBefore).not.toBeNull();
      const page2 = AdminMessagesResponse.parse((await operator.get(`/api/admin/messages?status=all&limit=2&before=${encodeURIComponent(page1.nextBefore!)}`)).json());
      expect(page2.messages.map((m) => m.email)).toEqual(["p0@example.com"]);
      expect(page2.nextBefore).toBeNull();

      const closed = await operator.request("PATCH", `/api/admin/messages/${ids[0]}`, { json: { status: "closed" } });
      expect(closed.status).toBe(200);
      expect(closed.json()).toMatchObject({ status: "closed" });
      expect(closed.json().closedAt).not.toBeNull();
      expect(AdminMessagesResponse.parse((await operator.get("/api/admin/messages?status=closed")).json()).messages).toHaveLength(1);
      expect((await operator.request("PATCH", `/api/admin/messages/${ids[0]}`, { json: { status: "open" } })).json()).toMatchObject({ status: "open", closedAt: null });
      expect((await operator.request("DELETE", `/api/admin/messages/${ids[1]}`)).status).toBe(204);
      expect((await operator.request("DELETE", `/api/admin/messages/${ids[1]}`)).status).toBe(404);
      expect((await operator.request("PATCH", `/api/admin/messages/not-a-uuid`, { json: { status: "open" } })).status).toBe(400);

      const old = await insertContactMessage(h.ctx.db, { name: null, email: "old@example.com", topic: "support", message: "From a long time ago", at: new Date(Date.now() - 25 * 30 * 86_400_000) });
      expect(await pruneContactMessages(h.ctx.db)).toBe(1);
      expect((await h.ctx.db.query(`SELECT 1 FROM contact_messages WHERE id = $1`, [old])).rowCount).toBe(0);
      const o = await overview(operator);
      expect(o.messages).toEqual({ open: 2, total: 2 });
    });
  });
});
