import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ingestAvailable, startLiveCreator, type LiveCreator } from "./support/live-seed";

/**
 * /contact and /admin in a real browser at desktop and 390 px, against the dev stack:
 * - a message sent through the contact form lands in the admin inbox, is closed and deleted;
 * - non-admins get the password form at /admin (tests/e2e/admin-password.spec.ts signs in);
 * - the one-time admin link (printed by the real CLI) opens the dashboard;
 * - visits counted by the real collector, one TEST stream really published, and a viewer on its
 *   watch page show up under "Right now" and "Visitors".
 * Playwright's browser reports navigator.webdriver, so its own page views are never counted
 * (by design); visits are seeded through the collector with ordinary browser User-Agents, and a
 * few earlier days are inserted directly (and removed afterwards) so the chart has history.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_PREFIX = "e2e0";

function env(name: string): string {
  const line = readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

function psql(sql: string) {
  execFileSync("psql", [env("DATABASE_URL"), "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: "pipe" });
}

/** In dev every request comes from 127.0.0.1, so repeated runs would hit the 5-per-hour contact limit. */
function resetContactLimit() {
  execFileSync("redis-cli", ["-u", env("REDIS_URL"), "EVAL", "for _, k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1", "0", "slot1:contact:*"], { stdio: "pipe" });
}

/** The real CLI the server runs (`slot1 admin-link`), here with the dev environment. */
function adminLink(): string {
  const out = execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), ["--env-file-if-exists=../../.env", "src/admin-link.ts"], { cwd: path.join(ROOT, "apps/api"), encoding: "utf8" });
  return out.trim().split("\n").at(-1)!;
}

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
];

async function seedVisits(req: APIRequestContext, origin: string, watchPath: string | null) {
  const visits: [number, string, string | undefined][] = [
    [0, "/", "google.com"],
    [0, "/los-santos", undefined],
    [1, "/", "reddit.com"],
    [2, "/setup", undefined],
    [3, "/", "t.co"],
    [4, "/moments", undefined],
    [5, watchPath ?? "/los-santos", "google.com"],
  ];
  for (const [ua, p, r] of visits) {
    const res = await req.post("/api/analytics/collect", { headers: { origin, "user-agent": UAS[ua]!, "content-type": "text/plain;charset=UTF-8" }, data: JSON.stringify({ p, r, b: ua === 2 || ua === 3 ? "s" : "l" }) });
    expect(res.status()).toBe(204);
  }
}

/** Earlier days for the chart: tagged rows (visitor IDs start with e2e0), removed in afterAll. */
function seedHistory() {
  const rows: string[] = [];
  const paths = ["/", "/los-santos", "/setup", "/moments", "/watch/demo"];
  for (let d = 1; d <= 29; d++) {
    const visitors = 3 + ((d * 7) % 9);
    for (let v = 0; v < visitors; v++) {
      const vid = `${SEED_PREFIX}${randomBytes(14).toString("hex")}`;
      const views = 1 + ((d + v) % 3);
      for (let k = 0; k < views; k++) {
        rows.push(`(now() - interval '${d} days' + interval '${v * 7 + k} minutes', '${paths[(d + v + k) % paths.length]}', ${v % 4 === 0 ? "'google.com'" : "NULL"}, '${v % 3 === 0 ? "mobile" : "desktop"}', '${["chrome", "safari", "firefox"][v % 3]}', decode('${vid}', 'hex'))`);
      }
    }
  }
  psql(`INSERT INTO page_views (created_at, path, referrer_host, device, browser, visitor_id) VALUES ${rows.join(",")}`);
}

function watchConsole(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
  });
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test.describe("Contact and admin", () => {
  test.describe.configure({ mode: "serial" });
  const errors: string[] = [];
  let req: APIRequestContext;
  let creator: LiveCreator | null = null;
  let email = "";

  test.beforeAll(async ({ baseURL }, info) => {
    test.setTimeout(150_000);
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    req = await request.newContext({ baseURL });
    email = `fan-${info.project.name}-${randomBytes(3).toString("hex")}@example.com`;
    const ingest = await ingestAvailable(baseURL!);
    if (ingest.ok) creator = await startLiveCreator(baseURL!, `Admin view ${info.project.name === "narrow" ? "N" : "D"}`);
    psql(`DELETE FROM page_views WHERE encode(visitor_id, 'hex') LIKE '${SEED_PREFIX}%'`);
    seedHistory();
    await seedVisits(req, new URL(baseURL!).origin, creator ? `/watch/${creator.login}` : null);
  });
  test.afterAll(async () => {
    psql(`DELETE FROM page_views WHERE encode(visitor_id, 'hex') LIKE '${SEED_PREFIX}%'`);
    await creator?.dispose();
    await req?.dispose();
  });
  test.beforeEach(({ page }) => {
    errors.length = 0;
    watchConsole(page, errors);
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("the contact form checks the fields and sends the message", async ({ page }, info) => {
    resetContactLimit();
    await page.goto("/contact?topic=privacy");
    await expect(page.getByRole("heading", { name: "Contact", level: 1 })).toBeVisible();
    const topic = page.getByLabel("What it's about");
    await expect(topic).toHaveValue("privacy");
    await expect(page.getByText(/Say which Twitch account or channel/)).toBeVisible();

    // Nothing filled in: the errors show and focus goes to the first problem.
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await expect(page.getByLabel("Email for our reply")).toBeFocused();
    await expect(page.getByText("Write at least 10 characters")).toBeVisible();

    await page.getByLabel("Your name (optional)").fill("Test Fan");
    await page.getByLabel("Email for our reply").fill(email);
    await page.getByLabel("Message").fill("Please send me a copy of the data you keep about my channel. Thank you!");
    await expect(page.getByText(/\d+ \/ 5,000/)).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `tests/e2e/screenshots/${info.project.name}/contact.png`, fullPage: true });

    await page.getByRole("button", { name: "Send message" }).click();
    const sent = page.getByRole("status").filter({ hasText: "Message sent" });
    await expect(sent).toBeVisible();
    await expect(sent).toContainText(email);
    await expect(sent).toBeFocused();
  });

  test("a non-admin gets the admin password form at /admin, never the dashboard", async ({ page }) => {
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Staff only.", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Control room" })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect((await req.get("/api/admin/overview")).status()).toBe(404);
  });

  test("the one-time link opens the dashboard with real counts, and the inbox works", async ({ page, baseURL }, info) => {
    test.setTimeout(120_000);
    const narrow = info.project.name === "narrow";
    // A viewer on the live stream's watch page (counted by the collector, like a real browser).
    if (creator) {
      await req.post("/api/analytics/ping", {
        headers: { origin: new URL(baseURL!).origin, "user-agent": UAS[1]!, "content-type": "text/plain;charset=UTF-8" },
        data: JSON.stringify({ p: `/watch/${creator.login}` }),
      });
    }
    const link = adminLink();
    expect(link).toContain("/api/admin/link?token=");
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.getByRole("heading", { name: "Open the SLOT1 admin" })).toBeVisible();
    await page.getByRole("button", { name: "Open the admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Control room", level: 1 })).toBeVisible();
    await expect(page.getByText("Signed in with a one-time admin link.")).toBeVisible();

    // Used once: opening the same link again says it expired.
    const again = await req.get(link.replace(/^https?:\/\/[^/]+/, ""));
    expect(again.status()).toBe(410);

    const now = page.getByRole("region", { name: "Right now" });
    await expect(now.getByText("ON THE SITE")).toBeVisible();
    if (creator) {
      const row = now.getByRole("listitem").filter({ hasText: creator.displayName });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.getByText("TEST", { exact: true })).toBeVisible();
      await expect(row).toContainText("Video reaches SLOT1");
    }
    const visitors = page.getByRole("region", { name: "Visitors" });
    await expect(visitors.getByRole("img", { name: /Visitors and page views per day/ })).toBeVisible();
    await expect(visitors.getByRole("cell", { name: "/los-santos" }).first()).toBeVisible();
    await expect(visitors.getByRole("cell", { name: "google.com" })).toBeVisible();

    // Range filter: the chart and lists switch to 7 days.
    await visitors.getByRole("button", { name: "Last 7 days" }).click();
    await expect(visitors.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true");
    await expect(visitors.getByRole("img", { name: /per day, 7 days/ })).toBeVisible();
    await visitors.getByRole("button", { name: "Last 30 days" }).click();
    await expect(visitors.getByRole("img", { name: /per day, 30 days/ })).toBeVisible();

    // Keyboard reading of the chart.
    const chart = visitors.getByRole("img", { name: /Visitors and page views per day/ });
    await chart.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("[aria-live=polite]").filter({ hasText: /visitors, \d+ page views/ })).toHaveCount(1);

    await expect(page.getByRole("region", { name: "Platform" }).getByText("Accounts")).toBeVisible();
    await expect(page.getByRole("region", { name: "AI" }).getByText("Screen text (OCR)")).toBeVisible();
    await expect(page.getByRole("region", { name: "System" }).getByRole("table", { name: "Job queues" })).toBeVisible();

    await noHorizontalOverflow(page);
    if (!narrow) {
      await chart.hover({ position: { x: 300, y: 120 } });
      await expect(page.locator(".admin-viz").getByText(/page views$/).first()).toBeVisible();
    }
    await page.screenshot({ path: `tests/e2e/screenshots/${info.project.name}/admin.png`, fullPage: true });

    // The message from the contact page is in the inbox: close it, then delete it.
    const inbox = page.getByRole("region", { name: "Messages" });
    const msg = inbox.getByRole("article").filter({ hasText: email });
    await expect(msg).toBeVisible();
    await expect(msg).toContainText("Privacy or my data");
    await expect(msg).toContainText("Test Fan");
    await msg.getByRole("button", { name: "Close" }).click();
    await expect(msg).toBeHidden();
    await inbox.getByRole("tab", { name: /Closed/ }).click();
    const closed = inbox.getByRole("article").filter({ hasText: email });
    await expect(closed).toBeVisible();
    await closed.getByRole("button", { name: "Delete" }).click();
    await closed.getByRole("button", { name: "Delete for good" }).click();
    await expect(closed).toBeHidden();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `tests/e2e/screenshots/${info.project.name}/admin-inbox.png` });
  });
});
