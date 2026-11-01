import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { makeClipAiVideo } from "../fixtures/clip-ai-video";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Extra copies of the screenshots for review outside the repo, when set. */
const PREVIEW_DIR = process.env.SLOT1_E2E_PREVIEW_DIR ?? null;

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const project = test.info().project.name;
  await page.screenshot({ path: path.join(HERE, "screenshots", project, `${name}.png`), fullPage: true });
  if (PREVIEW_DIR) {
    mkdirSync(PREVIEW_DIR, { recursive: true });
    await page.screenshot({ path: path.join(PREVIEW_DIR, `${name}-${project}.png`), fullPage: true });
  }
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

/**
 * AI clip tools in a real browser, on a synthetic replay with a black screen, a loud tone,
 * silence and a MISSION PASSED card (tests/fixtures/clip-ai-video.ts): rank the best moments,
 * see the reasons and the loud moment join after the audio pass, open a moment and a best-of
 * reel in the editor, and use the editor's AI panel. No AI key: the tools that need one say so.
 */
test.describe("AI clip tools", () => {
  const errors: string[] = [];
  /** Errors on the editor page itself (the editor is its own feature, covered by clipper.spec.ts). */
  const editorErrors: string[] = [];
  let onEditor = false;
  let video = "";
  test.beforeAll(() => {
    video = makeClipAiVideo();
  });
  test.beforeEach(({ page }) => {
    errors.length = 0;
    editorErrors.length = 0;
    onEditor = false;
    const add = (msg: string) => (onEditor ? editorErrors : errors).push(msg);
    page.on("pageerror", (e) => add(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) add(m.text());
    });
  });
  test.afterEach(() => {
    if (editorErrors.length) test.info().annotations.push({ type: "editor errors (outside the AI tools)", description: [...new Set(editorErrors)].join(" | ").slice(0, 400) });
    expect(errors, "browser console errors").toEqual([]);
  });

  test("rank a replay's best moments and open them as edits", async ({ page }) => {
    test.skip(test.info().project.name === "laptop", "covered at desktop and 390 px");
    test.setTimeout(420_000);
    const project = test.info().project.name;
    await page.goto("/studio");
    await page.getByLabel("Display name").fill(`Clip AI ${project}`);
    await page.getByRole("button", { name: "Open local workspace" }).click();
    await expect(page.getByRole("heading", { name: "Studio", level: 1 })).toBeVisible();

    // An empty channel gets a way forward.
    await page.getByRole("tab", { name: "AI clip tools" }).click();
    await expect(page.getByRole("heading", { name: "AI clip tools", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No sessions yet" })).toBeVisible();
    await expect(page.getByText("AI writing off")).toBeVisible();
    await shot(page, "clip-ai-empty");

    // The empty state's own button (the readiness route offers the same action when ingest is set up).
    await page.getByRole("tabpanel", { name: "AI clip tools" }).getByRole("button", { name: "Add a video source" }).click();
    await page.setInputFiles("#up-file", video);
    await page.getByLabel("Title").fill(`Docks run ${project}`);
    await page.getByLabel(/I own this recording/).check();
    await page.getByRole("button", { name: "Upload and analyze" }).click();
    await page.waitForURL(/\/replay\//, { timeout: 60_000 });
    const sessionId = page.url().split("/replay/")[1]!.split(/[?#]/)[0]!;
    // Analysis done far enough that SLOT1 has read the result screen.
    await expect(async () => {
      const r = await (await page.request.get(`/api/clip-ai/sessions/${sessionId}/moments`)).json();
      expect(r.session.media.available).toBe(true);
      expect(r.candidates.some((c: { big: string | null }) => c.big === "MISSION PASSED")).toBe(true);
    }).toPass({ timeout: 240_000, intervals: [3000] });

    await page.goto("/studio");
    await page.getByRole("tab", { name: "AI clip tools" }).click();
    const sessions = page.getByRole("group", { name: "Sessions" });
    await expect(sessions.getByRole("button", { name: new RegExp(`Docks run ${project}`) })).toHaveAttribute("aria-pressed", "true");
    const moments = page.getByRole("list", { name: "Moments, best first" });
    await expect(moments.getByText("MISSION PASSED", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(moments.getByText(/^MISSION PASSED read on screen at 00:(2[7-9]|3\d)$/).first()).toBeVisible();

    // Opening the session started the audio pass; the loud tone joins the ranking when it's done.
    await expect(moments.getByText(/^Audio spike \+\d+ dB at 00:1[67]$/).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("img", { name: /of 5 stars/ }).first()).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "clip-ai-moments");

    // A best-of reel from two moments: one edit, in time order.
    const ticks = moments.getByRole("checkbox", { name: "Add to reel" });
    expect(await ticks.count()).toBeGreaterThanOrEqual(2);
    await ticks.nth(0).check();
    await ticks.nth(1).check();
    await page.getByRole("radio", { name: "Widescreen" }).click();
    onEditor = true;
    await page.getByRole("button", { name: "Make a best-of reel (2)" }).click();
    await page.waitForURL(/\/studio\/edit\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const reelId = page.url().split("/").pop()!;
    const reel = await (await page.request.get(`/api/projects/${reelId}`)).json();
    expect(reel.title).toBe(`Best of Docks run ${project}`);
    expect(reel.edl.aspect).toBe("16:9");
    expect(reel.edl.segments).toHaveLength(2);
    expect(reel.edl.segments[0].inMs).toBeLessThan(reel.edl.segments[1].inMs);

    // One moment as its own edit.
    await page.goto("/studio");
    onEditor = false;
    await page.getByRole("tab", { name: "AI clip tools" }).click();
    onEditor = true;
    await moments.getByRole("button", { name: "Clip it" }).first().click();
    await page.waitForURL(/\/studio\/edit\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const clip = await (await page.request.get(`/api/projects/${page.url().split("/").pop()}`)).json();
    expect(clip.edl.segments).toHaveLength(1);
    expect(clip.edl.aspect).toBe("9:16"); // the section opens on vertical again
    await page.waitForLoadState("networkidle");
    await shot(page, "clip-ai-editor");

    // The editor's AI panel, when the editor shows it.
    const panel = page.getByRole("region", { name: "AI assistant" });
    if ((await panel.count()) === 0) {
      test.info().annotations.push({ type: "note", description: "The editor doesn't show the AI panel yet; panel steps skipped" });
      return;
    }
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.getByRole("tab", { name: "Sounds & effects" })).toHaveAttribute("aria-selected", "true");
    await panel.getByRole("tab", { name: "Edit it for me" }).click();
    await expect(panel.getByText("Editing on request needs an AI model on this server.")).toBeVisible();
    await expect(panel.getByText("No AI key is set on this server. On the server, run: slot1 ai")).toBeVisible();

    await panel.getByRole("tab", { name: "Cut the boring parts" }).click();
    await panel.getByRole("button", { name: "Find the boring parts" }).click();
    await expect(panel.getByRole("button", { name: /^(Check again|Checking…)$/ })).toBeVisible();
    await shot(page, "clip-ai-panel-boring");

    await panel.getByRole("tab", { name: "Sounds & effects" }).click();
    await panel.getByRole("button", { name: "Preview the changes" }).click();
    await expect(panel.getByRole("button", { name: /^(Add to my edit|Preview the changes)$/ }).first()).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "clip-ai-panel-polish");

    await panel.getByRole("tab", { name: "Write my post" }).click();
    await expect(panel.getByText("Writing posts needs an AI model on this server.")).toBeVisible();
  });
});
