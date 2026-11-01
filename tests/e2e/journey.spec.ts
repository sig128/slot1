import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "../fixtures/generated/sample-replay.mp4");
async function shot(page: Page, name: string) {
  // Full-page captures: start from the top so the sticky header sits where a visitor sees it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test.describe("SLOT1 journey", () => {
  const errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      // Expected 401/403/404 API answers and the dev server's hot-reload socket are not app errors.
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
    });
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("On Air is honest about what this deployment can do", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("link", { name: "On Air" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/independent and not affiliated with Rockstar Games/)).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "on-air");
  });

  test("a pasted channel link opens watch-only with no analysis", async ({ page }) => {
    await page.goto("/watch/someone_else");
    await expect(page.getByText("Not analyzed").first()).toBeVisible();
    // The official Twitch player where it fits (≥400×300), otherwise a plain link to Twitch.
    const embed = page.locator('iframe[src^="https://player.twitch.tv/"]');
    const fallback = page.getByRole("link", { name: /Watch on Twitch/ });
    await expect(embed.or(fallback).first()).toBeVisible();
    await expect(page.getByText("Twitch chat", { exact: true })).toBeVisible();
    if (await embed.count()) {
      const src = new URL((await embed.first().getAttribute("src"))!);
      expect(src.searchParams.get("channel")).toBe("someone_else");
      expect(src.searchParams.getAll("parent")).toContain("localhost");
    }
    await noHorizontalOverflow(page);
    await shot(page, "watch-only");
  });

  test("creator uploads a replay, inspects evidence and saves a moment", async ({ page }) => {
    await page.goto("/studio");
    await page.getByLabel("Display name").fill(`E2E ${test.info().project.name}`);
    await page.getByRole("button", { name: "Open local workspace" }).click();
    await expect(page.getByRole("heading", { name: "Studio", level: 1 })).toBeVisible();

    // The readiness sequence, in order.
    const steps = page.getByRole("list", { name: "Readiness" }).getByRole("listitem");
    await expect(steps).toHaveCount(5);
    const labels = ["Twitch connected", "Bot ready", "Clip permissions ready", "Video source ready", "Agent enabled"];
    for (const [i, label] of labels.entries()) await expect(steps.nth(i)).toContainText(label);
    await noHorizontalOverflow(page);
    await shot(page, "studio");

    await page.getByRole("tab", { name: "Video sources" }).click();
    await page.setInputFiles("#up-file", SAMPLE);
    await page.getByLabel("Title").fill("Docks run, synthetic test");
    await page.getByLabel(/I own this recording/).check();
    await page.getByRole("button", { name: "Upload and analyze" }).click();
    await page.waitForURL(/\/replay\//, { timeout: 60_000 });

    await expect(page.getByText("Replay").first()).toBeVisible();
    await expect(async () => {
      await page.reload();
      expect(await page.locator("button[data-rail-item]").count()).toBeGreaterThan(5);
    }).toPass({ timeout: 120_000, intervals: [3000] });

    await page.locator("button[data-rail-item]").filter({ hasText: "MISSION PASSED" }).first().click();
    const evidence = page.getByRole("img", { name: /Evidence frame at/ }).first();
    await expect(evidence).toBeVisible();
    expect(await evidence.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
    await expect(page.getByText("Visible text").first()).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "replay-evidence");

    await page.getByRole("button", { name: "Save moment" }).first().click();
    const form = page.locator("form").filter({ has: page.getByLabel("Moment title") });
    await form.getByLabel("Moment title").fill("Mission passed at the docks");
    await form.getByRole("button", { name: "Save moment" }).click();
    await expect(form.getByRole("button", { name: "Saved to Moments" })).toBeVisible();

    await page.goto("/moments");
    await expect(page.getByText("Mission passed at the docks").first()).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "moments");
  });

  test("setup explains PS5 broadcasting honestly", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "How SLOT1 works", level: 1 })).toBeVisible();
    await expect(page.getByText(/Nothing is installed on your PS5/)).toBeVisible();
    await expect(page.getByText(/hasn.t been verified on a console yet/)).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "setup");
  });

  test("keyboard users can skip to content and reach the navigation", async ({ page }) => {
    await page.goto("/setup");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "SLOT1 home" })).toBeFocused();
    await page.keyboard.press("Tab");
    const onAir = page.getByRole("link", { name: "On Air" });
    await expect(onAir).toBeFocused();
    // A visible focus ring, not the browser default removed.
    expect(await onAir.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/);
  });

  test("the design demo is labeled as fixtures", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByText(/fixture/i).first()).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "demo");
  });
});
