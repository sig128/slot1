import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminSettingsView, PublicStatus, SettingsRequestResult } from "@slot1/contracts";
import { hashAdminPassword, verifyAdminPassword } from "../../apps/api/src/lib/admin-password";
import { ADMIN_COOKIE, mintAdminLink } from "../../apps/api/src/lib/admin-session";
import { recordSignInEvent } from "../../apps/api/src/lib/signin-events";
import { Browser, ORIGIN, startHarness, type Harness } from "./harness";

/**
 * /admin → Settings against the real API, Redis and a state folder laid out like the server's
 * (scripts/server-setup.sh): what the API writes into inbox/, what it reads from outbox/, who may
 * do it, and the public /api/status.
 */

async function stateDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "slot1-state-"));
  await mkdir(path.join(dir, "inbox"), { mode: 0o700 });
  await mkdir(path.join(dir, "outbox"));
  return dir;
}

/** A browser holding an admin session from a one-time link, plus its own CSRF session. */
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

/** Each request file in the inbox, decoded: [verb, key, value?][]. */
async function inboxRequests(dir: string) {
  const names = (await readdir(path.join(dir, "inbox"))).filter((n) => n.endsWith(".settings"));
  return Promise.all(
    names.map(async (n) => {
      const raw = await readFile(path.join(dir, "inbox", n), "utf8");
      const [head, ...lines] = raw.trimEnd().split("\n");
      return {
        id: n.replace(/\.settings$/, ""),
        raw,
        head,
        lines: lines.map((l) => {
          const [verb, key, b64] = l.split(" ");
          return b64 === undefined ? [verb, key] : [verb, key, Buffer.from(b64, "base64").toString("utf8")];
        }),
      };
    }),
  );
}

/** The API's rate limits live in Redis and outlast a harness: start each part with fresh counters. */
async function clearRateLimits(h: Harness) {
  const keys = await h.ctx.redis.keys("slot1-api-rl:*");
  if (keys.length) await h.ctx.redis.del(...keys);
}

async function clearInbox(dir: string) {
  for (const n of await readdir(path.join(dir, "inbox"))) await rm(path.join(dir, "inbox", n));
}

describe("/admin settings", () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = await stateDir();
    h = await startHarness({
      SLOT1_STATE_DIR: dir,
      SLOT1_VERSION: "abc1234",
      SLOT1_LEGAL_NAME: "Old Name AS",
      SLOT1_OPERATOR_TWITCH_LOGINS: "kechupclan",
      TWITCH_CLIENT_ID: "oldclientid000000000000000",
      TWITCH_CLIENT_SECRET: "oldsecret0000000000000000000",
      TWITCH_REDIRECT_URI: `${ORIGIN}/api/auth/twitch/callback`,
    });
  });
  afterAll(async () => {
    await h?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("is invisible to everyone but admins", async () => {
    const anon = new Browser(h);
    await anon.refreshCsrf();
    const creator = new Browser(h);
    await creator.signInLocal("Not An Admin");
    for (const b of [anon, creator]) {
      expect((await b.get("/api/admin/settings")).status).toBe(404);
      expect((await b.request("POST", "/api/admin/settings", { json: { legalName: "Hacked" } })).status).toBe(404);
      expect((await b.request("POST", "/api/admin/password", { json: { next: "a brand new password" } })).status).toBe(404);
      expect((await b.get("/api/admin/deploy-log")).status).toBe(404);
      expect((await b.get("/api/admin/signins")).status).toBe(404);
    }
    expect(await inboxRequests(dir)).toEqual([]);
  });

  it("shows what the server runs with, never a secret", async () => {
    const admin = await adminBrowser(h);
    const res = await admin.get("/api/admin/settings");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const v = res.json<AdminSettingsView>();
    expect(v.available).toBe(true);
    expect(v.values).toMatchObject({
      twitchClientId: "oldclientid000000000000000",
      twitchClientSecretSet: true,
      adminTwitchLogins: "kechupclan",
      legalName: "Old Name AS",
      anthropicApiKeySet: false,
      autodeploy: true,
      adminPasswordSet: false,
    });
    expect(v.twitchRedirectUrl).toBe(`${ORIGIN}/api/auth/twitch/callback`);
    expect(v.working).toMatchObject({ twitch: true, ai: false });
    expect(v.version).toBe("abc1234");
    expect(res.body).not.toContain("oldsecret");
  });

  it("leaves a request in the inbox in the server's exact format, and checks it first", async () => {
    const admin = await adminBrowser(h);
    await clearInbox(dir);
    const ok = await admin.request("POST", "/api/admin/settings", {
      json: {
        twitchClientSecret: "newsecret0123456789abcdefghij",
        adminTwitchLogins: " @KetchupClan ",
        legalAddress: "Øvre gate 1, 0150 Oslo",
        contactEmail: "",
      },
    });
    expect(ok.status).toBe(200);
    const { id } = ok.json<{ id: string }>();
    expect(id).toMatch(/^[a-z0-9]{8,40}$/);
    const [req, ...more] = await inboxRequests(dir);
    expect(more).toEqual([]);
    expect(req!.id).toBe(id);
    expect(req!.head).toBe("slot1-settings v1");
    expect(req!.lines).toEqual([
      ["set", "TWITCH_CLIENT_SECRET", "newsecret0123456789abcdefghij"],
      ["set", "SLOT1_OPERATOR_TWITCH_LOGINS", "ketchupclan"],
      ["clear", "SLOT1_CONTACT_EMAIL"],
      ["set", "SLOT1_LEGAL_ADDRESS", "Øvre gate 1, 0150 Oslo"],
    ]);
    // Written atomically: no half-written dot-file is left behind.
    expect((await readdir(path.join(dir, "inbox"))).filter((n) => n.startsWith("."))).toEqual([]);

    // What the server would refuse is refused here, with the field named, and nothing is written.
    await clearInbox(dir);
    const bad = await admin.request("POST", "/api/admin/settings", { json: { legalName: "a$b", twitchClientId: "" } });
    expect(bad.status).toBe(422);
    expect(bad.json().error.fields).toMatchObject({ legalName: expect.any(String), twitchClientId: expect.stringMatching(/can't be emptied/) });
    expect((await admin.request("POST", "/api/admin/settings", { json: { databasePassword: "x" } })).status).toBe(400);
    expect((await admin.request("POST", "/api/admin/settings", { json: {} })).json().error.code).toBe("nothing_to_save");
    // Without the CSRF token, nothing either.
    expect((await admin.request("POST", "/api/admin/settings", { json: { legalName: "No Token AS" }, csrf: false })).status).toBe(403);
    expect(await inboxRequests(dir)).toEqual([]);
  });

  it("follows the request to the server's answer and shows the new values right away", async () => {
    const admin = await adminBrowser(h);
    await clearInbox(dir);
    const { id } = (await admin.request("POST", "/api/admin/settings", { json: { legalName: "New Name AS", autodeploy: false } })).json<{ id: string }>();
    expect((await admin.get(`/api/admin/settings/requests/${id}`)).json<SettingsRequestResult>()).toMatchObject({ id, status: "pending" });

    // The server applies it (restarting only the website for this key), like slot1 tick does.
    await rm(path.join(dir, "inbox", `${id}.settings`));
    await writeFile(path.join(dir, "outbox", `settings-${id}.json`), JSON.stringify({ id, ok: true, detail: "restart: web", at: new Date().toISOString() }));
    expect((await admin.get(`/api/admin/settings/requests/${id}`)).json<SettingsRequestResult>()).toMatchObject({ id, status: "applied", detail: "restart: web" });
    const v = (await admin.get("/api/admin/settings")).json<AdminSettingsView>();
    expect(v.requests[0]).toMatchObject({ id, status: "applied" });
    // The API itself didn't restart, so it shows what the server now runs with from the request.
    expect(v.values.legalName).toBe("New Name AS");
    expect(v.values.autodeploy).toBe(false);

    // A refusal is reported as such.
    const { id: id2 } = (await admin.request("POST", "/api/admin/settings", { json: { governingLaw: "Norway" } })).json<{ id: string }>();
    await rm(path.join(dir, "inbox", `${id2}.settings`));
    await writeFile(path.join(dir, "outbox", `settings-${id2}.json`), JSON.stringify({ id: id2, ok: false, detail: "not accepted: SLOT1_GOVERNING_LAW", at: new Date().toISOString() }));
    expect((await admin.get(`/api/admin/settings/requests/${id2}`)).json<SettingsRequestResult>()).toMatchObject({ status: "refused", detail: "not accepted: SLOT1_GOVERNING_LAW" });
    expect((await admin.get("/api/admin/settings")).json<AdminSettingsView>().values.governingLaw).toBeNull();
    expect((await admin.get("/api/admin/settings/requests/..%2F..%2Fetc")).json<SettingsRequestResult>().status).toBe("unknown");
  });

  it("sets the first admin password, hashed, through the inbox", async () => {
    await clearRateLimits(h);
    const admin = await adminBrowser(h);
    await clearInbox(dir);
    expect((await admin.request("POST", "/api/admin/password", { json: { next: "too short" } })).status).toBe(400);
    const r = await admin.request("POST", "/api/admin/password", { json: { next: "a brand new password" } });
    expect(r.status).toBe(200);
    const [req] = await inboxRequests(dir);
    expect(req!.lines).toHaveLength(1);
    const [verb, key, hash] = req!.lines[0]!;
    expect([verb, key]).toEqual(["set", "SLOT1_ADMIN_PASSWORD_HASH"]);
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyAdminPassword("a brand new password", hash)).toBe(true);
    expect(req!.raw).not.toContain("a brand new password");
  });

  it("shows the last deploy, its log and recent sign-in attempts", async () => {
    const admin = await adminBrowser(h);
    const commit = "0884be8".padEnd(40, "0");
    await writeFile(path.join(dir, "outbox", "deploy.json"), JSON.stringify({ state: "live", commit, at: new Date().toISOString() }));
    await writeFile(path.join(dir, "outbox", "deploy.log"), ["\u001b[1;95m==>\u001b[0m Getting the latest code", ...Array.from({ length: 400 }, (_, i) => `line ${i}`)].join("\n"));
    expect((await admin.get("/api/admin/settings")).json<AdminSettingsView>().deploy).toMatchObject({ state: "live", commit });
    const log = (await admin.get("/api/admin/deploy-log")).json<{ log: string }>().log;
    expect(log.split("\n")).toHaveLength(200);
    expect(log.endsWith("line 399")).toBe(true);
    expect(log).not.toContain("\u001b");

    await recordSignInEvent(h.ctx.redis, { outcome: "error", why: "app_secret", detail: "Twitch answered 403: invalid client secret" });
    const events = (await admin.get("/api/admin/signins")).json<{ events: { why: string; detail: string }[] }>().events;
    expect(events[0]).toMatchObject({ why: "app_secret", detail: "Twitch answered 403: invalid client secret" });
  });

  it("publishes a plain status for anyone, without secrets or Twitch's words", async () => {
    const res = await new Browser(h).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=15");
    const st = res.json<PublicStatus>();
    expect(st).toMatchObject({
      version: "abc1234",
      deploy: { state: "live", commit: "0884be8" },
      services: { website: "ok", database: "ok", redis: "ok" },
      twitchSignIn: { configured: true, last: { outcome: "error", why: "app_secret" } },
      ai: { configured: false },
    });
    expect(res.body).not.toMatch(/invalid client secret|oldsecret|detail/);
  });
});

describe("/admin settings with a password set, on a server without the shared folder", () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = await stateDir();
    h = await startHarness({ SLOT1_STATE_DIR: dir, SLOT1_ADMIN_PASSWORD_HASH: await hashAdminPassword("the current admin password") });
  });
  afterAll(async () => {
    await h?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("needs the current password to set a new one", async () => {
    await clearRateLimits(h);
    const admin = await adminBrowser(h);
    const wrong = await admin.request("POST", "/api/admin/password", { json: { current: "not it at all, sorry", next: "a brand new password" } });
    expect(wrong.status).toBe(401);
    expect((await admin.request("POST", "/api/admin/password", { json: { next: "a brand new password" } })).status).toBe(401);
    expect(await inboxRequests(dir)).toEqual([]);
    const right = await admin.request("POST", "/api/admin/password", { json: { current: "the current admin password", next: "a brand new password" } });
    expect(right.status).toBe(200);
    expect(await inboxRequests(dir)).toHaveLength(1);
  });

  it("says saving isn't available when the server has no shared settings folder", async () => {
    await rm(path.join(dir, "inbox"), { recursive: true });
    const admin = await adminBrowser(h);
    const v = (await admin.get("/api/admin/settings")).json<AdminSettingsView>();
    expect(v.available).toBe(false);
    expect(v.unavailableReason).toMatch(/setup script/);
    const r = await admin.request("POST", "/api/admin/settings", { json: { legalName: "Nowhere AS" } });
    expect(r.status).toBe(409);
    expect(r.json().error.code).toBe("settings_unavailable");
  });
});
