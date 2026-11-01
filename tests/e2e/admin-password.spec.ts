import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * The /admin password form in a real browser at each width (docs/ADMIN.md):
 * - the form, a wrong password and its honest error, the per-connection limit;
 * - signing in opens the dashboard, which counts the sign-in; signing out returns to the form;
 * - a link from another site arrives without the SameSite=Strict cookie, and the page still
 *   opens the dashboard for a browser that is signed in;
 * - with no password configured, the page says so and shows the server command.
 *
 * Needs a stack whose API has SLOT1_ADMIN_PASSWORD_HASH set, and the password in
 * SLOT1_E2E_ADMIN_PASSWORD; against an API without a hash, only the last test runs.
 * SLOT1_E2E_REDIS_URL lets it reset the attempt limits between tests; SLOT1_E2E_SHOTS is
 * where screenshots go (default: the test's output folder).
 */
const PASSWORD = process.env.SLOT1_E2E_ADMIN_PASSWORD ?? "";
const REDIS_URL = process.env.SLOT1_E2E_REDIS_URL ?? "";
const WRONG = "definitely not the admin password";

function resetLoginLimits() {
  if (!REDIS_URL) return;
  execFileSync("redis-cli", ["-u", REDIS_URL, "EVAL", "for _, k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1", "0", "slot1:admin:pw:*"], { stdio: "pipe" });
}

function shot(info: TestInfo, name: string): string {
  const dir = process.env.SLOT1_E2E_SHOTS;
  return dir ? path.join(dir, `${info.project.name}-${name}.png`) : info.outputPath(`${name}.png`);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

/** Submit the form and wait until the page has handled the answer. */
async function submit(page: Page, password: string) {
  const field = page.getByLabel("Admin password");
  await field.fill(password);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/admin/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await answer;
  if (!res.ok()) {
    // A refused password is cleared from the field and the button comes back.
    await expect(field).toHaveValue("");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  }
  return res;
}

async function passwordSet(page: Page): Promise<boolean> {
  const r = await page.request.get("/api/admin/login");
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { passwordSet: boolean }).passwordSet;
}

test.describe("Admin password", () => {
  test.describe.configure({ mode: "serial" });
  const errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    resetLoginLimits();
    page.on("pageerror", (e) => errors.push(e.message));
  });
  test.afterEach(() => {
    expect(errors, "uncaught page errors").toEqual([]);
    errors.length = 0;
  });

  test("the form: a wrong password gets an honest error, then the limit says how long to wait", async ({ page }, info) => {
    await page.goto("/admin");
    test.skip(!(await passwordSet(page)) || !PASSWORD || !REDIS_URL, "needs an API with SLOT1_ADMIN_PASSWORD_HASH, SLOT1_E2E_ADMIN_PASSWORD and SLOT1_E2E_REDIS_URL");
    await expect(page.getByRole("heading", { name: "Staff only.", level: 1 })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const field = page.getByLabel("Admin password");
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toHaveAttribute("autocomplete", "current-password");
    await expect(field).toBeFocused();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("slot1 admin-link")).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot(info, "admin-login"), fullPage: true });

    // Empty: said right here, nothing sent. (Next's route announcer is an alert too: look in the form.)
    const alert = page.locator("form").getByRole("alert");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert).toHaveText("Enter the admin password.");

    await field.fill(WRONG);
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/admin/login") && r.request().method() === "POST");
    await field.press("Enter");
    expect((await answer).status()).toBe(401);
    await expect(alert).toHaveText("That didn't work. Check the password and try again.");
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("heading", { name: "Control room" })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot(info, "admin-login-wrong"), fullPage: true });

    // Four more wrong passwords use up this connection's five; then even the right one waits.
    for (let i = 0; i < 4; i += 1) expect((await submit(page, `${WRONG} ${i}`)).status()).toBe(401);
    const limited = await submit(page, PASSWORD);
    expect(limited.status()).toBe(429);
    await expect(alert).toHaveText(/^Too many wrong passwords from this connection\. Try again in (15|14) minutes\.$/);
    await expect(page.getByRole("heading", { name: "Control room" })).toHaveCount(0);
    await page.screenshot({ path: shot(info, "admin-login-limited"), fullPage: true });
  });

  test("the right password opens the dashboard; sign out returns to the form", async ({ page }, info) => {
    await page.goto("/admin");
    test.skip(!(await passwordSet(page)) || !PASSWORD, "needs an API with SLOT1_ADMIN_PASSWORD_HASH and SLOT1_E2E_ADMIN_PASSWORD");
    expect((await submit(page, PASSWORD)).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Control room", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText("Signed in with the admin password.")).toBeVisible();

    const cookie = (await page.context().cookies()).find((c) => c.name === "slot1_admin");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });

    const system = page.getByRole("region", { name: "System" });
    const signIns = system.getByRole("heading", { name: "Admin sign-ins" });
    await signIns.scrollIntoViewIfNeeded();
    await expect(signIns).toBeVisible();
    await expect(system.getByText("· last 7 days")).toBeVisible();
    await expect(system.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(system.getByText("Changing it signs everyone out")).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot(info, "admin-signed-in"), fullPage: false });

    // A link to /admin from another site: the Strict cookie isn't sent with that navigation,
    // so the server renders the form; the page checks from the site itself and opens the dashboard.
    // localhost and 127.0.0.1 are different sites, and both stay on this machine.
    const origin = new URL(page.url()).origin;
    const elsewhere = origin.includes("//localhost") ? `${origin.replace("//localhost", "//127.0.0.1")}/elsewhere` : "http://elsewhere.test/";
    await page.route(elsewhere, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Elsewhere</title><a href="${origin}/admin">Open SLOT1 admin</a>` }));
    await page.goto(elsewhere);
    const doc = page.waitForResponse((r) => r.url() === `${origin}/admin` && r.request().resourceType() === "document");
    await page.getByRole("link", { name: "Open SLOT1 admin" }).click();
    expect(await (await doc).text()).toContain("Staff only.");
    await expect(page.getByRole("heading", { name: "Control room", level: 1 })).toBeVisible();
    await expect(page.getByText("Signed in with the admin password.")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Staff only.", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Admin password")).toBeVisible();
    expect((await page.request.get("/api/admin/overview")).status()).toBe(404);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Staff only.", level: 1 })).toBeVisible();
  });

  test("with no password set, the page says so and shows the server command", async ({ page }, info) => {
    await page.goto("/admin");
    test.skip(await passwordSet(page), "needs an API without SLOT1_ADMIN_PASSWORD_HASH");
    await expect(page.getByRole("heading", { name: "Staff only.", level: 1 })).toBeVisible();
    await expect(page.getByText("No admin password is set on this server yet.")).toBeVisible();
    await expect(page.getByText("slot1 admin-password", { exact: true })).toBeVisible();
    await expect(page.getByText("slot1 admin-link", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Admin password")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shot(info, "admin-no-password"), fullPage: true });
  });
});
