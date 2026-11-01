import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The Studio editor as a full non-linear editor: panels, tracks, several timelines, razor and
 * ripple edits, drag from the media bin, markers and export, at 1440 and 1024 px; phones get
 * the simplified editor. Needs the full stack (see playwright.config.ts).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "../fixtures/generated/sample-replay.mp4");
const SHOTS = process.env.SLOT1_E2E_SHOTS ?? path.resolve(HERE, "screenshots");

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

/** One signed-in creator with two analysed uploads, shared by the tests in this file (uploads are rate limited). */
let shared: { cookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>; first: string; second: string } | null = null;

/** A fresh edit of the first upload; returns its URL and the second upload's session. */
async function setup(page: Page, name: string): Promise<{ url: string; second: string }> {
  await page.goto("/");
  const csrf = async () => (await (await page.request.get("/api/me")).json()).csrfToken as string;
  if (!shared) {
    expect((await page.request.post("/api/auth/local", { data: { displayName: name }, headers: { "x-slot1-csrf": await csrf() } })).ok()).toBe(true);
    const token = await csrf();
    const upload = async (title: string) => {
      const r = await page.request.post("/api/uploads", { headers: { "x-slot1-csrf": token }, multipart: { title, rightsConfirmed: "true", file: { name: "run.mp4", mimeType: "video/mp4", buffer: readFileSync(SAMPLE) } } });
      expect(r.ok(), await r.text()).toBe(true);
      return ((await r.json()) as { sessionId: string }).sessionId;
    };
    const first = await upload("Docks run");
    const second = await upload("Airport heist");
    await expect.poll(async () => ((await (await page.request.get("/api/editor/sources")).json()).sources ?? []).length, { timeout: 120_000 }).toBe(2);
    shared = { cookies: await page.context().cookies(), first, second };
  } else {
    await page.context().addCookies(shared.cookies);
  }
  const p = await page.request.post("/api/projects", { headers: { "x-slot1-csrf": await csrf() }, data: { sessionId: shared.first, inMs: 20_000, outMs: 32_000, title: "Docks run, the jump" } });
  expect(p.ok()).toBe(true);
  return { url: `/studio/edit/${((await p.json()) as { id: string }).id}`, second: shared.second };
}

for (const width of [1440, 1024]) {
  test.describe(`full editor at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : 768 } });

    test("tracks, timelines, razor, ripple, the media bin, markers and export", async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "Runs once, at its own sizes");
      test.setTimeout(420_000);
      const { url, second } = await setup(page, `Editor ${width}`);
      await page.goto(url);
      const timeline = page.getByRole("group", { name: "Edit timeline" });
      await expect(timeline.getByRole("button", { name: /^Segment 1,/ })).toBeVisible({ timeout: 60_000 });

      // A full-screen workspace: the site header and footer make room for it.
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      await expect(page.getByRole("region", { name: "Media" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Viewer" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Inspector" })).toBeVisible();
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Docks run, the jump");
      await page.getByRole("radio", { name: "Program" }).click();

      // Tracks: a video, a text and a music track.
      for (const kind of ["Add video track", "Add text track", "Add music track"]) {
        await page.getByRole("button", { name: "+ Track" }).click();
        await page.getByRole("menuitem", { name: kind }).click();
      }
      await expect(page.getByRole("button", { name: "V2 track menu" })).toBeVisible();
      await expect(page.getByRole("button", { name: "T1 track menu" })).toBeVisible();
      await expect(page.getByRole("button", { name: "A2 track menu" })).toBeVisible();
      await page.getByRole("button", { name: "Lock V2 Video 2" }).click();
      await expect(page.getByRole("button", { name: "Unlock V2 Video 2" })).toHaveAttribute("aria-pressed", "true");

      // Razor (C) on the V1 clip, then back to Select (V).
      await page.keyboard.press("c");
      await expect(page.getByRole("radio", { name: "Razor (C)" })).toHaveAttribute("aria-checked", "true");
      const clip1 = timeline.getByRole("button", { name: /^Segment 1,/ });
      const box = (await clip1.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
      await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toBeVisible();
      await page.keyboard.press("v");

      // Ripple delete the second half, undo it, then cut every track at the playhead.
      await timeline.getByRole("button", { name: /^Segment 2,/ }).click();
      await page.keyboard.press("Shift+Delete");
      await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(timeline.getByRole("button", { name: /^Segment 2,/ })).toBeVisible();

      // Markers (M) and the in/out range.
      await page.getByRole("slider", { name: "Playhead in the edit" }).click({ position: { x: 60, y: 8 } });
      await page.keyboard.press("m");
      await expect(timeline.getByRole("button", { name: /^Marker at/ })).toHaveCount(1);

      // The media bin: drag the other recording onto V1.
      await page.getByRole("tab", { name: "Recordings" }).click();
      const item = page.getByRole("button", { name: /^Airport heist,/ });
      await expect(item).toBeVisible();
      const v1 = page.locator('[data-lane="v1"]');
      await item.dragTo(v1, { targetPosition: { x: 20, y: 20 } });
      await expect(timeline.getByRole("button", { name: /^Segment 3,/ })).toBeVisible();
      await expect.poll(async () => (await (await page.request.get(`/api${url.replace("/studio/edit", "/projects")}`)).json()).edl.segments.map((s: { sessionId: string }) => s.sessionId), { timeout: 15_000 }).toContain(second);

      // Another timeline: a 16:9 version with the same clips.
      await page.getByRole("button", { name: "+ Add timeline" }).click();
      await page.getByRole("menuitem", { name: "New 16:9 version" }).click();
      const tabs = page.getByRole("tablist", { name: "Timelines" });
      await expect(tabs.getByRole("tab", { selected: true })).toContainText("Main 16:9");
      await expect(page.getByText(/Widescreen 1920×1080, /)).toBeVisible();
      await expect(timeline.getByRole("button", { name: /^Segment 3,/ })).toBeVisible();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });
      await noHorizontalOverflow(page);
      await shot(page, `editor-nle-${width}`);

      // Export the widescreen timeline from the pause-menu dialog.
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Export" });
      await expect(dialog).toBeVisible();
      const timelines = dialog.getByRole("group", { name: "Timelines" });
      await expect(timelines.getByRole("checkbox")).toHaveCount(2);
      await expect(timelines.getByRole("checkbox", { name: /Main 16:9/ })).toBeChecked();
      await expect(timelines.getByRole("checkbox", { name: "Main (9:16)" })).not.toBeChecked();
      if (width === 1440) {
        await dialog.getByRole("button", { name: "Export", exact: true }).click();
        const renders = dialog.getByRole("region", { name: "Renders" });
        await expect(renders.getByText("Ready", { exact: true })).toBeVisible({ timeout: 240_000 });
        await expect(renders.getByText(/1920×1080/)).toBeVisible();
      }
      await shot(page, `editor-nle-export-${width}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // The shortcuts sheet.
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: "Shortcuts" })).toBeVisible();
      await page.getByRole("dialog", { name: "Shortcuts" }).getByRole("button", { name: "Close" }).click();
    });
  });
}

test.describe("phones", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("get the simplified editor: watch, trim, captions and export", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Runs once, at its own size");
    test.setTimeout(240_000);
    const { url } = await setup(page, "Editor phone");
    await page.goto(url);
    await expect(page.getByText(/The full editor \(tracks, timelines, effects\) opens on screens at least 1024 px wide/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("group", { name: "Edit timeline" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Segments" })).toBeVisible();
    await page.getByRole("tab", { name: "Captions" }).click();
    await expect(page.getByRole("button", { name: "Add caption at playhead" })).toBeVisible();
    await page.getByRole("tab", { name: "Export" }).click();
    await expect(page.getByRole("region", { name: "Renders" })).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "editor-nle-phone");
  });
});
