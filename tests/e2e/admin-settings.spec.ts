import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * /admin → Settings and the public /status page in a real browser, at 1440 and 390 px. The stack
 * must run with SLOT1_STATE_DIR (in .env) pointing at a folder laid out like the server's; this
 * test plays the server's part (scripts/server-setup.sh, apply-settings): it reads the request
 * the page left in inbox/ and writes the answer to outbox/.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = path.dirname(fileURLToPath(import.meta.url));

function env(name: string): string {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

const STATE = env("SLOT1_STATE_DIR");
const inbox = () => path.join(STATE, "inbox");
const outbox = () => path.join(STATE, "outbox");

function resetState() {
  rmSync(inbox(), { recursive: true, force: true });
  mkdirSync(inbox(), { recursive: true, mode: 0o700 });
  mkdirSync(outbox(), { recursive: true });
  for (const n of readdirSync(outbox())) if (n.startsWith("settings-")) rmSync(path.join(outbox(), n));
}

/** The requests waiting in inbox/, decoded. */
function requests(): { id: string; lines: string[][] }[] {
  return readdirSync(inbox())
    .filter((n) => n.endsWith(".settings"))
    .map((n) => ({
      id: n.replace(/\.settings$/, ""),
      lines: readFileSync(path.join(inbox(), n), "utf8")
        .trimEnd()
        .split("\n")
        .slice(1)
        .map((l) => {
          const [verb, key, b64] = l.split(" ");
          return b64 === undefined ? [verb!, key!] : [verb!, key!, Buffer.from(b64, "base64").toString("utf8")];
        }),
    }));
}

/** What `slot1 tick` does once it has applied a request. */
function serverApplies(id: string, detail = "restart: web") {
  rmSync(path.join(inbox(), `${id}.settings`), { force: true });
  writeFileSync(path.join(outbox(), `settings-${id}.json`), JSON.stringify({ id, ok: true, detail, at: new Date().toISOString() }));
}

/** The real CLI the server runs (`slot1 admin-link`), here with this stack's environment. */
function adminLink(): string {
  const out = execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), ["--env-file-if-exists=../../.env", "src/admin-link.ts"], { cwd: path.join(ROOT, "apps/api"), encoding: "utf8" });
  return out.trim().split("\n").at(-1)!;
}

async function openAdmin(page: Page) {
  await page.goto(adminLink());
  await page.getByRole("button", { name: "Open the admin" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Control room" })).toBeVisible();
  // Typing before React has taken over the forms would be lost.
  await expect(page.locator("[data-testid=settings-panel][data-ready]")).toBeAttached();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

const shotPath = (name: string) => path.join(HERE, "screenshots", test.info().project.name, `${name}.png`);

test.describe("admin settings", () => {
  test.skip(!STATE, "Needs SLOT1_STATE_DIR in .env (a folder laid out like the server's state folder).");
  test.beforeEach(() => resetState());

  test("saving goes to the server's inbox, checked first, and shows the server's answer", async ({ page }) => {
    await openAdmin(page);
    // Sign in with Twitch isn't set up on this stack: the dashboard says so, with the way to fix it.
    const alert = page.getByRole("alert").filter({ hasText: "Sign in with Twitch is off" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("link", { name: "Settings → Twitch app" })).toHaveAttribute("href", "#settings-twitch");

    const settings = page.locator("#settings");
    await expect(settings.getByRole("heading", { name: "Twitch app" })).toBeVisible();
    await expect(settings.getByTestId("twitch-redirect-url")).toHaveText(new URL(page.url()).origin + "/api/auth/twitch/callback");

    // A value the server would refuse is caught on the page, and nothing is sent.
    const legal = settings.locator("#settings-legal");
    await legal.getByLabel("Registered address").fill("Main street 1 $HOME");
    await legal.getByRole("button", { name: "Save legal details" }).click();
    await expect(legal.getByText("One line, up to 200 characters, without the characters")).toBeVisible();
    expect(requests()).toEqual([]);

    // A good value: one request, in the server's format.
    await legal.getByLabel("Registered address").fill("Øvre gate 1, 0150 Oslo");
    await legal.getByLabel("Business or legal name").fill("E2E Operator AS");
    await legal.getByRole("button", { name: "Save legal details" }).click();
    await expect(legal.getByTestId("settings-save-status")).toContainText("Saved. The server applies it within a minute, then restarts SLOT1 (about 30 seconds).");
    await expect.poll(() => requests().length).toBe(1);
    const [req] = requests();
    expect(req!.lines).toEqual([
      ["set", "SLOT1_LEGAL_NAME", "E2E Operator AS"],
      ["set", "SLOT1_LEGAL_ADDRESS", "Øvre gate 1, 0150 Oslo"],
    ]);
    // While it waits, the other groups can't send a second change.
    await expect(settings.getByRole("button", { name: "Save Twitch app" })).toBeDisabled();

    serverApplies(req!.id);
    await expect(legal.getByTestId("settings-save-status")).toContainText("Applied", { timeout: 20_000 });
    await expect(legal.getByLabel("Business or legal name")).toHaveValue("E2E Operator AS");
    await expect(settings.getByRole("button", { name: "Save Twitch app" })).toBeEnabled();

    // Secrets are write-only fields.
    const secret = settings.locator("#settings-twitch").getByLabel("Client Secret");
    await expect(secret).toHaveAttribute("type", "password");
    await expect(secret).toHaveValue("");

    await noHorizontalOverflow(page);
    await settings.screenshot({ path: shotPath("admin-settings") });
  });

  test("the update log and the sign-in attempts are there for the admin", async ({ page }) => {
    writeFileSync(path.join(outbox(), "deploy.json"), JSON.stringify({ state: "live", commit: "0884be8".padEnd(40, "0"), at: new Date().toISOString() }));
    writeFileSync(path.join(outbox(), "deploy.log"), "\u001b[1;95m==>\u001b[0m Getting the latest code\n    Version: 0884be8\n==> Checking that SLOT1 answers\n    API: ok\n");
    await openAdmin(page);
    const updates = page.locator("#settings-updates");
    await expect(updates.getByTestId("settings-deploy")).toContainText("Live");
    await expect(updates.getByTestId("settings-deploy")).toContainText("0884be8");
    await updates.getByText("The last update’s log").click();
    await expect(updates.getByTestId("settings-deploy-log")).toContainText("Checking that SLOT1 answers");
    await expect(updates.getByTestId("settings-deploy-log")).not.toContainText("\u001b");
    await expect(page.getByRole("heading", { name: "Recent “Sign in with Twitch” attempts" })).toBeVisible();
  });
});

test.describe("system status", () => {
  test("says in plain words what works, linked from every page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: "System status" }).click();
    await expect(page).toHaveURL(/\/status$/);
    await expect(page.getByRole("heading", { level: 1, name: "System status" })).toBeVisible();
    const list = page.getByTestId("status-list");
    for (const name of ["Website", "Accounts and live updates", "Sign in with Twitch", "Streaming to SLOT1", "AI that watches streams", "Updates"]) {
      await expect(list.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(list.locator("li").filter({ hasText: "Website" })).toContainText("Working");
    // Nothing only the server's owner should see: no setting names, no commands.
    expect(await page.locator("main").innerText()).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\bslot1 (?:twitch|ai|update|logs)\b/);
    // Crawlable like any public page.
    const robots = await (await page.request.get("/robots.txt")).text();
    expect(robots).not.toMatch(/Disallow: \/status/);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: shotPath("status"), fullPage: true });
  });
});
