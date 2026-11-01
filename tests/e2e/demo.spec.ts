import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The live demo page against a stack that runs the demo broadcast (SLOT1_DEMO=true and the
 * generator publishing; see docs/DEMO.md). Everything on the page is the real pipeline reading
 * the synthetic video. Skips, saying why, against a stack without the demo.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test.describe("Live demo", () => {
  // A production build served over plain http locally: its CSP would upgrade requests to https.
  test.use({ bypassCSP: true });

  test("explains the signal path and shows what the AI sees on the live demo", async ({ page }) => {
    const info = (await (await page.request.get("/api/demo")).json()) as { enabled: boolean; onAir: boolean; reason: string | null };
    test.skip(!info.enabled || !info.onAir, `Needs a stack with the demo broadcast running: ${info.reason}`);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]/.test(m.text())) errors.push(m.text());
    });

    await page.goto("/demo");
    await expect(page.getByRole("heading", { level: 1, name: "Watch SLOT1 watch a stream" })).toBeVisible();
    await expect(page.getByText("Synthetic test video", { exact: true })).toBeVisible();
    await expect(page.getByText("On air", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "How a frame travels through SLOT1" }).getByRole("listitem")).toHaveCount(6);

    // The demo channel's own header: a TEST source, never a Twitch channel.
    await expect(page.getByRole("heading", { level: 1, name: "SLOT1 Demo" })).toBeVisible();
    await expect(page.locator("iframe[src*='twitch.tv']")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open on Twitch" })).toHaveCount(0);

    // "What the AI sees" is open: the analyzed frame, the regions OCR reads, and real readings.
    const view = page.getByTestId("ai-view");
    await expect(view).toBeVisible({ timeout: 30_000 });
    const frame = view.getByRole("img", { name: "The video frame SLOT1 analyzed" });
    await expect.poll(() => frame.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 20_000 }).toBe(640);
    for (const region of ["Subtitles and objectives", "Title cards and result screens", "Area name", "Cash readout"]) {
      await expect(view.getByText(`${region}:`, { exact: false }).first()).toBeVisible();
    }
    await expect(view.getByText(/OCR confidence \d+/).first()).toBeVisible({ timeout: 60_000 });
    await expect(view.getByText(/Paid AI vision is off for the demo/)).toBeVisible();

    // Without a WebRTC gateway the player shows the analyzed frames, and says so.
    const gateway = ((await (await page.request.get("/api/capabilities")).json()) as { liveVideo: { available: boolean } }).liveVideo.available;
    if (!gateway) await expect(page.getByText(/Frames the AI analyzed, one every/)).toBeVisible();

    // The log fills from OCR.
    await expect(page.getByRole("complementary", { name: "SLOT1 rail" }).getByText(/Rico|Vanessa|NEON PIER|PALM ROW|SUNSET DOCKS|HARBOR LIGHTS|Go to|Lose the cops|Drive to|Collect|Return to|\$1,2/).first()).toBeVisible({
      timeout: 60_000,
    });

    // The panel closes and opens again.
    await page.getByRole("button", { name: "Hide what the AI sees" }).click();
    await expect(page.getByTestId("ai-view")).toHaveCount(0);
    await page.getByRole("button", { name: "What the AI sees" }).click();
    await expect(page.getByTestId("ai-view")).toBeVisible();

    await noHorizontalOverflow(page);
    await shot(page, "demo-live");
    expect(errors, "browser console errors").toEqual([]);
  });
});
