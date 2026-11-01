import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/** /setup ("How SLOT1 works"): the overview first, details on demand, and every old anchor still lands. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`), fullPage: true });
}

test.describe("How SLOT1 works", () => {
  const errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
    });
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("leads with the overview: routes, setup steps and what each mode sees", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "How SLOT1 works", level: 1 })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "On this page" });
    await expect(tabs.getByRole("link")).toHaveCount(9);
    await expect(tabs.getByRole("link", { name: "Brief" })).toHaveAttribute("aria-current", "location");

    // The routes: a map on wide screens, the same routes as a list on narrow ones.
    if ((page.viewportSize()?.width ?? 0) >= 1024) await expect(page.getByRole("img", { name: "How the video travels" })).toBeVisible();
    else await expect(page.getByRole("region", { name: "Console only" })).toBeVisible();
    await expect(page.locator(".su-objective")).toHaveCount(4);
    for (const m of ["Watch", "Chat only", "Clip analysis", "Continuous analysis", "Replay"])
      await expect(page.getByRole("heading", { level: 3, name: m, exact: true })).toBeVisible();

    // Honesty points stay visible without opening anything.
    await expect(page.getByText(/Nothing is installed on your PS5/)).toBeVisible();
    await expect(page.getByText(/hasn.t been verified on a console yet/)).toBeVisible();
    await expect(page.getByText(/Hide your camera from the AI/)).toBeVisible();

    // Details open on demand.
    const watch = page.locator(".su-mode").filter({ has: page.getByRole("heading", { name: "Watch", exact: true }) });
    await expect(watch.getByText("Nothing. Works for any public channel.")).toBeHidden();
    await watch.getByText("How it works").click();
    await expect(watch.getByText("Nothing. Works for any public channel.")).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
    await shot(page, "setup-overview");
  });

  test("links from Studio, the API and the home page land on their section, and the tab follows", async ({ page }) => {
    await page.goto("/setup#bot");
    await expect(page.getByRole("heading", { name: "The chat bot", level: 2 })).toBeInViewport();
    await expect(page.getByRole("navigation", { name: "On this page" }).getByRole("link", { name: "Chat bot" })).toHaveAttribute("aria-current", "location");
    for (const id of ["ps5", "modes", "twitch", "bot", "sources", "stream", "ai", "console-test", "limits"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
  });

  test("chat commands copy with one tap", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/setup#bot");
    const copy = page.getByRole("button", { name: "Copy !slot1 now" });
    await copy.click();
    await expect(copy).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("!slot1 now");
  });
});
