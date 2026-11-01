import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminLoginStatus, AdminOverview } from "@slot1/contracts";
import { hashAdminPassword, LOGIN_FAILURE_MIN_MS } from "../../apps/api/src/lib/admin-password";
import { ADMIN_COOKIE, mintAdminLink } from "../../apps/api/src/lib/admin-session";
import { Browser, ORIGIN, startHarness, type Harness } from "./harness";

/**
 * The /admin password (docs/ADMIN.md) against the real API, Postgres and Redis: sign-in, the
 * attempt limits, CSRF, cookie flags, what is stored, and sessions ending when the password
 * changes. The harness runs behind a trusted proxy like production, so X-Forwarded-For picks
 * the client address.
 */

const PASSWORD = "correct horse battery staple";
const SECOND = "a second admin password, 2nd";
const GATE_KEY = "slot1:admin:pw:gate";
const GLOBAL_KEY = "slot1:admin:pw:global";

let lastIp = 0;
/** A fresh documentation address (TEST-NET-2) per visitor, so limits never leak between tests. */
const freshIp = () => `198.51.100.${(lastIp += 1)}`;

type Res = { status?: number; statusCode?: number; headers: Record<string, unknown> };

function adminCookie(res: Res): string | null {
  const set = res.headers["set-cookie"];
  const list = Array.isArray(set) ? set : set ? [set] : [];
  return (list.find((c) => typeof c === "string" && c.startsWith(`${ADMIN_COOKIE}=`)) as string | undefined) ?? null;
}

/** One browser (its own session and CSRF token) from one address. */
async function visitor(h: Harness, ip = freshIp()) {
  const b = new Browser(h);
  await b.refreshCsrf();
  return {
    b,
    ip,
    login(password: unknown, opts: { csrf?: boolean; origin?: string } = {}) {
      return b.request("POST", "/api/admin/login", { json: { password }, csrf: opts.csrf, headers: { "x-forwarded-for": ip, ...(opts.origin ? { origin: opts.origin } : {}) } });
    },
    /** Keep the admin cookie a response set, like the browser would (replacing an older one). */
    keep(res: Res) {
      const c = adminCookie(res);
      if (c) b.cookie = [...b.cookie.split("; ").filter((kv) => kv && !kv.startsWith(`${ADMIN_COOKIE}=`)), c.split(";")[0]!].join("; ");
      return c;
    },
    overview() {
      return b.get("/api/admin/overview");
    },
    async status() {
      return AdminLoginStatus.parse((await b.get("/api/admin/login")).json());
    },
  };
}

async function useLink(h: Harness, url: string) {
  return h.app.inject({
    method: "POST",
    url: "/api/admin/link",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ token: new URL(url).searchParams.get("token")! }).toString(),
  });
}

async function clearAdminKeys(h: Harness) {
  const keys = [...(await h.ctx.redis.keys("slot1:admin:*")), ...(await h.ctx.redis.keys("slot1-api-rl:*"))];
  if (keys.length) await h.ctx.redis.del(...keys);
}

/** Every admin key and value in Redis, as one string, to check what is (not) stored. */
async function adminRedisDump(h: Harness): Promise<string> {
  const out: string[] = [];
  for (const key of await h.ctx.redis.keys("slot1:admin:*")) {
    const type = await h.ctx.redis.type(key);
    out.push(key, type === "hash" ? JSON.stringify(await h.ctx.redis.hgetall(key)) : type === "string" ? ((await h.ctx.redis.get(key)) ?? "") : type);
  }
  return out.join("\n");
}

const setHash = (h: Harness, value: string | null) => {
  (h.ctx.config.env as { SLOT1_ADMIN_PASSWORD_HASH: string | null }).SLOT1_ADMIN_PASSWORD_HASH = value;
};

describe("admin password sign-in", () => {
  let h: Harness;
  let configured: string;

  beforeAll(async () => {
    configured = await hashAdminPassword(PASSWORD);
    // Behind Caddy in production: the client address comes from X-Forwarded-For.
    h = await startHarness({ SLOT1_TRUST_PROXY: "true", SLOT1_ADMIN_PASSWORD_HASH: configured });
  });
  afterAll(async () => {
    if (h) await clearAdminKeys(h);
    await h?.close();
  });
  beforeEach(async () => {
    setHash(h, configured);
    await clearAdminKeys(h);
  });

  it("tells the page a password is set, without caching or indexing", async () => {
    const v = await visitor(h);
    const r = await v.b.get("/api/admin/login");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(AdminLoginStatus.parse(r.json())).toEqual({ passwordSet: true, signedIn: false });
    // The dashboard API itself still answers 404 to anyone outside.
    expect((await v.overview()).status).toBe(404);
  });

  it("the right password starts the same 12-hour admin session a one-time link does", async () => {
    const v = await visitor(h);
    const r = await v.login(PASSWORD);
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true, redirect: "/admin" });
    expect(r.headers["cache-control"]).toBe("no-store");
    const cookie = v.keep(r)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(cookie).not.toMatch(/Secure/i); // plain http in development; production is below

    const o = AdminOverview.parse((await v.overview()).json());
    expect(o.access).toBe("admin_password");
    expect(o.system.adminLogin).toMatchObject({ passwordSet: true, today: { succeeded: 1, failed: 0, blocked: 0 }, pausedUntil: null });
    expect(o.system.adminLogin.lastSucceededAt).not.toBeNull();
    expect((await v.b.get("/api/admin/messages")).status).toBe(200);
    expect((await v.status()).signedIn).toBe(true);

    // One session record, kept 12 hours, exactly like a link session.
    const sessions = await h.ctx.redis.keys("slot1:admin:session:*");
    expect(sessions).toHaveLength(1);
    expect(await h.ctx.redis.ttl(sessions[0]!)).toBeGreaterThan(12 * 3600 - 60);
    expect(JSON.parse((await h.ctx.redis.get(sessions[0]!))!)).toMatchObject({ via: "password" });

    // An admin session is not an operator account: operator-only routes elsewhere stay closed.
    expect((await v.b.request("POST", "/api/training/datasets", { json: {} })).status).toBe(404);

    // Sign out ends it.
    expect((await v.b.request("POST", "/api/admin/logout")).status).toBe(204);
    expect((await v.overview()).status).toBe(404);
    expect(await h.ctx.redis.keys("slot1:admin:session:*")).toHaveLength(0);
  });

  it("a wrong password gets one generic answer, no sooner than the fixed delay, and no session", async () => {
    const v = await visitor(h);
    for (const wrong of ["correct horse battery stapl", "CORRECT HORSE BATTERY STAPLE", "x".repeat(2000)]) {
      const t0 = performance.now();
      const r = await v.login(wrong);
      const took = performance.now() - t0;
      expect(r.status).toBe(401);
      expect(r.json().error).toEqual({ code: "wrong_password", message: "That didn't work. Check the password and try again.", requirement: null });
      expect(took).toBeGreaterThanOrEqual(LOGIN_FAILURE_MIN_MS - 5);
      expect(adminCookie(r)).toBeNull();
    }
    expect((await v.overview()).status).toBe(404);
    // Not a password at all: refused before anything is counted.
    expect((await v.login("")).status).toBe(400);
    expect((await v.login(12345)).status).toBe(400);
    expect((await v.login("y".repeat(5000))).status).toBe(400);

    const { url } = await mintAdminLink(h.ctx);
    const admin = await visitor(h);
    admin.keep(await useLink(h, url));
    const o = AdminOverview.parse((await admin.overview()).json());
    expect(o.system.adminLogin.today).toEqual({ succeeded: 0, failed: 3, blocked: 0 });
    expect(o.system.adminLogin.lastFailedAt).not.toBeNull();
  });

  it("allows 5 wrong passwords per address in 15 minutes, even in parallel, then refuses that address", async () => {
    const a = await visitor(h);
    // Eight at once: the attempt is counted before the password is checked, so only five get checked.
    const burst = await Promise.all(Array.from({ length: 8 }, () => a.login("not the admin password")));
    expect(burst.filter((r) => r.status === 401)).toHaveLength(5);
    const refused = burst.filter((r) => r.status === 429);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect(r.json().error).toMatchObject({ code: "login_paused", message: "Too many wrong passwords from this connection. Try again in 15 minutes." });
      const after = Number(r.headers["retry-after"]);
      expect(after).toBeGreaterThan(890);
      expect(after).toBeLessThanOrEqual(900);
    }
    // Even the right password waits now, from that address.
    const right = await a.login(PASSWORD);
    expect(right.status).toBe(429);
    expect(adminCookie(right)).toBeNull();

    // Another address isn't affected, and its success clears only its own count.
    const b = await visitor(h);
    expect((await b.login("one wrong guess here")).status).toBe(401);
    const ok = await b.login(PASSWORD);
    expect(ok.status).toBe(200);
    b.keep(ok);
    expect((await a.login(PASSWORD)).status).toBe(429);

    const o = AdminOverview.parse((await b.overview()).json());
    expect(o.system.adminLogin.today).toEqual({ succeeded: 1, failed: 6, blocked: 5 });

    // What is stored: counters under an HMAC of the address. No address, no password.
    const dump = await adminRedisDump(h);
    expect(dump).toContain("slot1:admin:pw:ip:");
    expect(dump).not.toContain("198.51.100.");
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("not the admin password");
  });

  it("pauses sign-in for everyone after 20 failures, longer as failures continue; links still work", async () => {
    // 20 failures from four addresses: still open for everyone else.
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const v = await visitor(h);
        const rs = await Promise.all(Array.from({ length: 5 }, () => v.login("a guess from a botnet")));
        expect(rs.every((r) => r.status === 401)).toBe(true);
      }),
    );
    expect(await h.ctx.redis.pttl(GATE_KEY)).toBeLessThan(0);

    // The 21st starts a one-minute pause.
    expect((await (await visitor(h)).login("the twenty-first guess")).status).toBe(401);
    const pause = await h.ctx.redis.pttl(GATE_KEY);
    expect(pause).toBeGreaterThan(55_000);
    expect(pause).toBeLessThanOrEqual(60_000);

    // Now even the right password from a new address waits, and says why.
    const admin = await visitor(h);
    const r = await admin.login(PASSWORD);
    expect(r.status).toBe(429);
    expect(r.json().error).toMatchObject({ code: "login_paused", message: "Password sign-in is paused for everyone for a minute after many wrong passwords." });
    const after = Number(r.headers["retry-after"]);
    expect(after).toBeGreaterThan(50);
    expect(after).toBeLessThanOrEqual(60);

    // The one-time link is the way in meanwhile, and the dashboard shows the pause.
    const { url } = await mintAdminLink(h.ctx);
    admin.keep(await useLink(h, url));
    const o = AdminOverview.parse((await admin.overview()).json());
    expect(o.access).toBe("admin_link");
    expect(o.system.adminLogin.pausedUntil).not.toBeNull();
    expect(new Date(o.system.adminLogin.pausedUntil!).getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(o.system.adminLogin.today).toMatchObject({ succeeded: 0, failed: 21, blocked: 1 });

    // Backoff: once the pause is over, more failures pause longer (31st: 2 minutes).
    await h.ctx.redis.del(GATE_KEY);
    await h.ctx.redis.incrby(GLOBAL_KEY, 9);
    expect((await (await visitor(h)).login("the thirty-first guess")).status).toBe(401);
    const longer = await h.ctx.redis.pttl(GATE_KEY);
    expect(longer).toBeGreaterThan(115_000);
    expect(longer).toBeLessThanOrEqual(120_000);
  });

  it("needs the CSRF token and this site's origin; refused requests aren't counted as attempts", async () => {
    const v = await visitor(h);
    const noToken = await v.login(PASSWORD, { csrf: false });
    expect(noToken.status).toBe(403);
    expect(adminCookie(noToken)).toBeNull();
    const foreign = await v.login(PASSWORD, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(adminCookie(foreign)).toBeNull();
    // A plain form posted from another site carries no token either.
    const form = await h.app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded", cookie: v.b.cookie, "x-forwarded-for": v.ip },
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
    });
    expect(form.statusCode).toBe(403);
    expect(adminCookie(form)).toBeNull();
    expect(await h.ctx.redis.keys("slot1:admin:pw:*")).toHaveLength(0);

    // The same browser with its token signs in.
    expect((await v.login(PASSWORD)).status).toBe(200);
  });

  it("changing the password ends every admin session, from the password or from a link", async () => {
    const p = await visitor(h);
    p.keep(await p.login(PASSWORD));
    const l = await visitor(h);
    const { url } = await mintAdminLink(h.ctx);
    l.keep(await useLink(h, url));
    expect((await p.overview()).status).toBe(200);
    expect((await l.overview()).status).toBe(200);
    expect(await h.ctx.redis.keys("slot1:admin:session:*")).toHaveLength(2);

    // `slot1 admin-password` writes a new hash to .env and restarts the API: the config changes.
    setHash(h, await hashAdminPassword(SECOND));
    expect((await p.overview()).status).toBe(404);
    expect((await l.overview()).status).toBe(404);
    expect((await p.status()).signedIn).toBe(false);
    expect(await h.ctx.redis.keys("slot1:admin:session:*")).toHaveLength(0);

    // The old password stops working; the new one works.
    expect((await p.login(PASSWORD)).status).toBe(401);
    p.keep(await p.login(SECOND));
    expect(AdminOverview.parse((await p.overview()).json()).access).toBe("admin_password");

    // Hashing the same password again is a change too (new salt): everyone signs in again.
    setHash(h, await hashAdminPassword(SECOND));
    expect((await p.overview()).status).toBe(404);
  });
});

describe("admin password not configured", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ SLOT1_TRUST_PROXY: "true" });
    await clearAdminKeys(h);
  });
  afterAll(async () => {
    if (h) await clearAdminKeys(h);
    await h?.close();
  });

  it("says so, refuses sign-in plainly, keeps the link, and setting one ends older sessions", async () => {
    const v = await visitor(h);
    expect(await v.status()).toEqual({ passwordSet: false, signedIn: false });
    const r = await v.login("whatever the password might be");
    expect(r.status).toBe(409);
    expect(r.json().error).toMatchObject({ code: "conflict", message: "No admin password is set on this server yet." });
    expect(adminCookie(r)).toBeNull();
    expect(await h.ctx.redis.keys("slot1:admin:pw:*")).toHaveLength(0);

    // The one-time link still opens the dashboard, which says no password is set.
    const { url } = await mintAdminLink(h.ctx);
    const l = await visitor(h);
    l.keep(await useLink(h, url));
    const o = AdminOverview.parse((await l.overview()).json());
    expect(o.access).toBe("admin_link");
    expect(o.system.adminLogin.passwordSet).toBe(false);

    // A malformed value counts as no password (and doesn't end sessions).
    setHash(h, "scrypt$not-a-real-hash");
    expect((await v.status()).passwordSet).toBe(false);
    expect((await v.login("whatever the password might be")).status).toBe(409);
    expect((await l.overview()).status).toBe(200);

    // Setting the first password is a change as well: the link session from before ends.
    setHash(h, await hashAdminPassword(PASSWORD));
    expect((await l.overview()).status).toBe(404);
    expect((await v.login(PASSWORD)).status).toBe(200);
  });
});

describe("admin password in production", () => {
  it("sets a Secure, HttpOnly, SameSite=Strict cookie", async () => {
    const prod = await startHarness({ NODE_ENV: "production", SLOT1_ALLOW_LOCAL_LOGIN: "false", SLOT1_TRUST_PROXY: "true", SLOT1_ADMIN_PASSWORD_HASH: await hashAdminPassword(PASSWORD) });
    try {
      await clearAdminKeys(prod);
      expect(prod.ctx.config.isProduction).toBe(true);
      const v = await visitor(prod);
      const r = await v.login(PASSWORD);
      expect(r.status).toBe(200);
      const cookie = adminCookie(r)!;
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      v.keep(r);
      expect(AdminOverview.parse((await v.overview()).json()).access).toBe("admin_password");
    } finally {
      await clearAdminKeys(prod);
      await prod.close();
    }
  });
});
