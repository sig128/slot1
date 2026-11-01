import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { openPrimaryNav } from "./support/nav";

/**
 * The home intro: a game-style loading screen that resolves into SLOT1's title card. The HUD's
 * numbers must be the real directory numbers, the tips must be the real list, and the page must
 * work with and without motion.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`) });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function liveCount(page: Page): Promise<number> {
  const res = await page.request.get("/api/channels");
  if (!res.ok()) return 0;
  const dir = (await res.json()) as { channels: { broadcast: { state: string } }[] };
  return dir.channels.filter((c) => c.broadcast.state === "live").length;
}

test.describe("home intro (reduced motion)", () => {
  test("title card, real HUD numbers and the tips", async ({ page }) => {
    const errors = watchErrors(page);
    const live = await liveCount(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1, name: "SLOT1: Your AI sidekick for GTA." })).toBeVisible();
    await expect(page.getByText(/turns them into clips, instant replays and highlights/)).toBeVisible();
    await expect(page.getByText("Stream GTA. Get clips. Train the AI.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Watch the live demo" })).toHaveAttribute("href", "/demo");
    await expect(page.getByRole("link", { name: /^(Connect my Twitch|How creators connect)$/ }).first()).toBeVisible();

    // The money-style counter shows channels live right now, from the same directory the page uses.
    await expect(page.getByText(live === 1 ? "channel live" : "channels live", { exact: true })).toBeVisible();
    await expect(page.locator(".gx-money-num")).toHaveText(String(live));
    await expect(page.locator(".gx-star-on")).toHaveCount(Math.min(5, live));

    // The training line points to the honest explanation further down.
    await expect(page.getByText(/Building the GTA AI, one stream at a time\. Next stop:/)).toBeVisible();
    await page.getByRole("link", { name: "How it learns" }).click();
    await expect(page).toHaveURL(/#gta-ai$/);
    const gtaAi = page.getByRole("region", { name: "The GTA AI we’re building together" });
    await expect(gtaAi.getByText("Opt-in only.")).toBeVisible();
    await expect(gtaAi.getByText(/It isn’t used for the log yet/)).toBeVisible();
    await expect(gtaAi.getByText(/getting ready to learn its world as soon as players stream it/)).toBeVisible();

    // "How it works": three numbered steps right after the intro (when nobody is live).
    const how = page.getByRole("region", { name: "How it works" });
    await expect(how.getByRole("listitem")).toHaveCount(3);
    await expect(how.getByRole("heading", { level: 3 }).first()).toHaveText("Step 1: Stream GTA like you always do");
    if (live === 0) {
      const order = await page.evaluate(() => {
        const intro = document.querySelector("[data-scene]");
        const steps = document.querySelector("section[aria-labelledby='how-it-works']");
        return intro?.nextElementSibling === steps;
      });
      expect(order, "How it works sits right under the intro").toBe(true);
    }

    // Seven real tips; with reduced motion the first one stays on screen.
    const tips = page.getByRole("complementary", { name: "Tips" }).getByRole("listitem");
    await expect(tips).toHaveCount(7);
    await expect(tips.first()).toContainText("!slot1 clip");
    await expect(tips.first()).toBeVisible();

    // No loading theatre without motion: the bar never shows and nothing is waiting to appear.
    expect(await page.locator(".gx-load").evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    expect(await page.locator(".gx-reveal").first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "home-intro");
    await how.scrollIntoViewIfNeeded();
    await shot(page, "home-how-it-works");
    await gtaAi.scrollIntoViewIfNeeded();
    await shot(page, "home-gta-ai");
    expect(errors, "browser console errors").toEqual([]);
  });
});

test.describe("home intro (with motion)", () => {
  test.use({ reducedMotion: "no-preference" });

  test("plays once, settles, pauses off screen and skips on the way back", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    const hero = page.locator("[data-scene]");

    // The loading screen resolves into the title card within about three seconds.
    await expect(page.getByRole("link", { name: "Watch the live demo" })).toBeVisible();
    await expect.poll(() => page.locator(".gx-reveal").first().evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 6_000 }).toBe(1);
    expect(await hero.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(10);
    await shot(page, "home-intro-motion");

    // Off screen, the artwork holds still.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(hero).toHaveAttribute("data-paused", "true");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(hero).toHaveAttribute("data-paused", "false");

    // Coming back within the app goes straight to the final frame.
    await (await openPrimaryNav(page)).getByRole("link", { name: "Setup" }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await (await openPrimaryNav(page)).getByRole("link", { name: "On Air" }).click();
    await expect(page.locator("[data-scene]")).toHaveAttribute("data-intro", "skip");
    expect(await page.locator(".gx-reveal").first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
    expect(errors, "browser console errors").toEqual([]);
  });
});
