import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "../fixtures/generated/sample-replay.mp4");

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

/** Seek the page's (first) video and wait until the frame is there. */
async function seekVideo(page: Page, selector: string, seconds: number) {
  await page.locator(selector).first().evaluate(
    (v: HTMLVideoElement, t) =>
      new Promise<void>((resolve) => {
        const go = () => {
          v.addEventListener("seeked", () => resolve(), { once: true });
          v.currentTime = t;
        };
        if (v.readyState >= 1) go();
        else v.addEventListener("loadedmetadata", go, { once: true });
      }),
    seconds,
  );
}

/**
 * The creator clipper in a real browser: replay → screenshot → editor (AI moments, keyboard in/out,
 * presets, text) → server render → library sharing → public profile and item page. Desktop and
 * 390 px wide; no console errors, no sideways scrolling.
 */
test.describe("creator clipper", () => {
  const errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
    });
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("screenshot, edit, render and share a clip", async ({ page }) => {
    test.skip(test.info().project.name === "laptop", "covered at desktop and 390 px");
    test.setTimeout(420_000);
    const narrow = test.info().project.name === "narrow";
    await page.goto("/studio");
    await page.getByLabel("Display name").fill(`Clipper ${test.info().project.name}`);
    await page.getByRole("button", { name: "Open local workspace" }).click();
    await expect(page.getByRole("heading", { name: "Studio", level: 1 })).toBeVisible();
    const me = await (await page.request.get("/api/me")).json();
    const login: string = me.broadcaster.login;

    // The Library tab: settings, storage and an empty library.
    await page.getByRole("tab", { name: "Library" }).click();
    await expect(page.getByRole("heading", { name: "Library", level: 2 })).toBeVisible();
    await expect(page.getByLabel("Record my SLOT1 streams")).toBeDisabled();
    await expect(page.getByText("Storage used")).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "clipper-library-empty");

    await page.getByRole("tab", { name: "Video sources" }).click();
    await page.setInputFiles("#up-file", SAMPLE);
    await page.getByLabel("Title").fill("Docks run, clipper test");
    await page.getByLabel(/I own this recording/).check();
    await page.getByRole("button", { name: "Upload and analyze" }).click();
    await page.waitForURL(/\/replay\//, { timeout: 60_000 });
    await expect(async () => {
      await page.reload();
      expect(await page.locator("button[data-rail-item]").count()).toBeGreaterThan(5);
    }).toPass({ timeout: 150_000, intervals: [3000] });

    // A frame-accurate screenshot at the playhead.
    await seekVideo(page, "video", 27.4);
    await page.getByRole("button", { name: "Screenshot", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Screenshot at 0:27.4 saved to your library" })).toBeVisible();
    await noHorizontalOverflow(page);

    // Edit a clip around the playhead.
    await page.getByRole("button", { name: "Edit clip" }).click();
    await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });
    const editUrl = page.url();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(/Docks run/);
    await expect(page.getByRole("region", { name: "Segments" })).toBeVisible();
    const preview = page.locator("video").first();
    await expect.poll(() => preview.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    // SLOT1's moments are on the timeline: jump to MISSION PASSED, then mark in and out.
    await page.getByRole("button", { name: /MISSION PASSED/ }).first().click();
    await expect(page.getByRole("slider", { name: "Playhead in the source video" })).toHaveAttribute("aria-valuenow", /^2[4-9]\d{3}$/);
    // Keyboard only from here: I, then two seconds forward (Shift+→ twice), then O.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("i");
    await expect(page.getByText(/In point set at/)).toBeAttached();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("o");
    await expect(page.getByText(/Out point set at/)).toBeAttached();
    const inMs = Number(await page.getByRole("slider", { name: "In point of the selected segment" }).getAttribute("aria-valuenow"));
    const outMs = Number(await page.getByRole("slider", { name: "Out point of the selected segment" }).getAttribute("aria-valuenow"));
    expect(outMs - inMs).toBeGreaterThanOrEqual(1900);
    expect(outMs - inMs).toBeLessThanOrEqual(2100);
    expect(inMs).toBeGreaterThan(20_000);
    // The handles are keyboard sliders too.
    await page.getByRole("slider", { name: "Out point of the selected segment" }).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.getByRole("slider", { name: "Out point of the selected segment" })).toHaveAttribute("aria-valuenow", String(outMs + 1000));

    // The multi-track timeline: split at the playhead, then undo and redo it.
    await page.getByRole("radio", { name: "Program" }).click();
    const timeline = page.getByRole("group", { name: "Edit timeline" });
    await expect(timeline.getByRole("button", { name: /^Segment 1,/ })).toBeVisible();
    await page.getByRole("slider", { name: "Playhead in the edit" }).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+k");
    await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Segments" }).getByRole("button", { name: /Segment 2/ })).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toHaveCount(0);
    // The shortcuts sheet.
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Shortcuts" })).toBeVisible();
    await page.getByRole("dialog", { name: "Shortcuts" }).getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog", { name: "Shortcuts" })).toHaveCount(0);

    // Presets and text.
    await page.getByRole("tab", { name: "Format" }).click();
    await page.getByRole("radio", { name: /Widescreen/ }).click();
    await expect(page.getByText(/Widescreen 1920×1080, /)).toBeVisible();
    await page.getByRole("radio", { name: /Vertical/ }).click();
    await page.getByRole("radio", { name: "Facecam + gameplay" }).click();
    await expect(page.getByRole("slider", { name: /Camera panel height/ })).toBeVisible();
    await page.getByRole("radio", { name: "Fill and reframe" }).click();
    await page.getByRole("tab", { name: "Look" }).click();
    await page.getByRole("radio", { name: "Vice City night" }).click();
    await expect(page.getByText(/The preview approximates the final render/)).toBeVisible();
    await page.getByRole("radio", { name: "None" }).click();
    await page.getByRole("tab", { name: "Text" }).click();
    await page.getByRole("button", { name: "Add text at playhead" }).click();
    await page.getByRole("region", { name: "Text" }).getByLabel("Text", { exact: true }).fill("DOCKS DONE");
    await expect(timeline.getByRole("button", { name: /Text “DOCKS DONE”/ })).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    await noHorizontalOverflow(page);
    await shot(page, "clipper-editor");

    // Render on the server, with progress, into the library.
    await page.getByRole("button", { name: "Render", exact: true }).click();
    const renders = page.getByRole("region", { name: "Renders" });
    await expect(renders.getByText(/Rendering|Ready/).first()).toBeVisible();
    await expect(renders.getByText("Ready", { exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(renders.getByText(/1080×1920/)).toBeVisible();

    // Share it: the channel goes public, the clip public.
    await page.goto("/studio#library");
    await page.getByRole("tab", { name: "Privacy and data" }).click();
    await page.getByLabel("Public channel").click();
    await expect(page.getByLabel("Public channel")).toBeChecked();
    await page.getByRole("tab", { name: "Library" }).click();
    const items = page.getByRole("list", { name: "Library items" });
    await expect(items.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 });
    await page.getByRole("radio", { name: "Renders" }).click();
    await expect(items.getByRole("listitem")).toHaveCount(1);
    const card = items.getByRole("listitem").first();
    await card.getByLabel(/Who can see/).selectOption("public");
    await expect(card.getByRole("button", { name: /Feature/ })).toBeVisible();
    await card.getByRole("button", { name: /Feature/ }).click();
    await expect(card.getByRole("button", { name: /Featured/ })).toHaveAttribute("aria-pressed", "true");
    await noHorizontalOverflow(page);
    await shot(page, "clipper-library");

    // The public profile, signed out.
    const visitor = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL, viewport: page.viewportSize()!, hasTouch: narrow, reducedMotion: "reduce" });
    const pub = await visitor.newPage();
    pub.on("pageerror", (e) => errors.push(`visitor pageerror: ${e.message}`));
    await pub.goto(`/c/${login}`);
    await expect(pub.getByRole("heading", { name: `Clipper ${test.info().project.name}`, level: 1 })).toBeVisible();
    await expect(pub.getByRole("heading", { name: "Featured" })).toBeVisible();
    await expect(pub.getByRole("heading", { name: "Clips" })).toBeVisible();
    // The private screenshot is not listed.
    await expect(pub.getByRole("heading", { name: "Screenshots" })).toHaveCount(0);
    expect(await pub.locator('meta[property="og:image"]').getAttribute("content")).toMatch(/\/api\/library\/[0-9a-f-]{36}\/poster$/);
    await noHorizontalOverflow(pub);
    await shot(pub, "clipper-profile");

    await pub.getByRole("link", { name: /Docks run/ }).first().click();
    await pub.waitForURL(/\/v\//);
    const player = pub.locator("video").first();
    await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    expect(await player.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([1080, 1920]);
    expect(await pub.locator('meta[property="og:type"]').getAttribute("content")).toBe("video.other");
    await noHorizontalOverflow(pub);
    await shot(pub, "clipper-item");
    // The editor stays private to its creator.
    await pub.goto(editUrl);
    await expect(pub.getByRole("heading", { name: "Sign in to edit." })).toBeVisible();
    await visitor.close();
  });
});
