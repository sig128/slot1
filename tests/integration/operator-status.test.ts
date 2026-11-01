import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, MockTwitch, startHarness, type Harness } from "./harness";

/**
 * Operator status comes from SLOT1_OPERATOR_TWITCH_LOGINS as it is now, on every request: adding
 * a login and restarting the API makes someone who is already signed in an operator, and removing
 * it takes that away again, without signing in again. Each "restart" is a fresh API (new config)
 * on the same database, keeping the browser's session cookie. Against a local mock of Twitch.
 */
const OWNER = { id: "8201", login: "ownercrew", displayName: "OwnerCrew", scopes: ["channel:bot", "clips:edit", "channel:manage:clips", "channel:read:stream_key"] };

describe("operator status follows SLOT1_OPERATOR_TWITCH_LOGINS on every request", () => {
  let mock: MockTwitch;
  const harnesses: Harness[] = [];
  /** The API as it runs after a restart with this operator list. */
  const restartWith = async (logins: string) => {
    const h = await startHarness({ ...mock.env(), SLOT1_OPERATOR_TWITCH_LOGINS: logins });
    harnesses.push(h);
    return h;
  };
  /** The same browser (same session cookie) talking to that API. */
  const sameBrowser = (h: Harness, from: Browser) => Object.assign(new Browser(h), { cookie: from.cookie });
  const stored = async (h: Harness) =>
    (await h.ctx.db.query<{ is_operator: boolean }>(`SELECT is_operator FROM users WHERE twitch_user_id = $1`, [OWNER.id])).rows[0]?.is_operator;

  beforeAll(async () => {
    mock = await new MockTwitch().start();
    mock.addUser(OWNER);
  });
  afterAll(async () => {
    for (const h of harnesses) await h.close();
    await mock?.stop();
  });

  it("grants and revokes operator access without signing in again", async () => {
    // Signed in while the login isn't listed: not an operator, /admin stays hidden.
    const before = await restartWith("");
    const b = new Browser(before);
    await b.refreshCsrf();
    const start = new URL(String((await b.get("/api/auth/twitch/start")).headers.location));
    expect((await b.get(`/api/auth/twitch/callback?code=${mock.issueCode(OWNER.id)}&state=${encodeURIComponent(start.searchParams.get("state")!)}`)).status).toBe(302);
    expect((await b.refreshCsrf()).user).toMatchObject({ kind: "twitch", isOperator: false });
    expect((await b.get("/api/admin/overview")).status).toBe(404);
    expect(await stored(before)).toBe(false);

    // The login is added (any case) and the API restarted: the same session is an operator now.
    const granted = await restartWith("someoneelse, OwnerCrew");
    const g = sameBrowser(granted, b);
    expect((await g.refreshCsrf()).user).toMatchObject({ isOperator: true });
    expect((await g.get("/api/admin/overview")).status).toBe(200);
    expect(await stored(granted)).toBe(true);

    // Removed again: access ends on the next request, still without signing in again.
    const revoked = await restartWith("someoneelse");
    const r = sameBrowser(revoked, b);
    expect((await r.refreshCsrf()).user).toMatchObject({ isOperator: false });
    expect((await r.get("/api/admin/overview")).status).toBe(404);
    expect((await r.get("/api/auth/twitch/start?role=bot")).status).toBe(403);
    expect(await stored(revoked)).toBe(false);
  });
});
