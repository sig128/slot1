import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SLOT1_E2E_BASE_URL ?? "http://localhost:3000";
const PREVIEW = process.env.SLOT1_MASK_PREVIEW_DIR;
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

async function csrf(req: APIRequestContext): Promise<string> {
  return (await (await req.get(`${BASE}/api/me`)).json()).csrfToken as string;
}

function watchConsole(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Expected: the API's 4xx answers the panels turn into messages, and dev-server HMR noise.
    if (/Failed to load resource: the server responded with a status of 40[0-9]|\/_next\/(webpack-)?hmr/.test(t)) return;
    errors.push(t);
  });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string, locator?: ReturnType<Page["locator"]>) {
  const file = path.join(HERE, "screenshots", test.info().project.name, `${name}.png`);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  if (PREVIEW && test.info().project.name === "desktop") {
    mkdirSync(PREVIEW, { recursive: true });
    if (locator) await locator.screenshot({ path: path.join(PREVIEW, `${name}.png`) });
    else await page.screenshot({ path: path.join(PREVIEW, `${name}.png`) });
  }
}

async function signIn(ctx: BrowserContext, name: string) {
  const res = await ctx.request.post(`${BASE}/api/auth/local`, { data: { displayName: name }, headers: { "x-slot1-csrf": await csrf(ctx.request), origin: BASE } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function createSource(ctx: BrowserContext): Promise<{ id: string; publishUrl: string }> {
  const res = await ctx.request.post(`${BASE}/api/studio/sources`, { data: { name: "OBS", label: "live" }, headers: { "x-slot1-csrf": await csrf(ctx.request), origin: BASE } });
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  return { id: body.source.id, publishUrl: body.publishUrl };
}

async function savedMask(ctx: BrowserContext, sourceId: string) {
  const studio = await (await ctx.request.get(`${BASE}/api/studio`)).json();
  return studio.sources.find((s: { id: string }) => s.id === sourceId).cameraMask as { x: number; y: number; w: number; h: number }[];
}

/**
 * Studio → Stream setup → "Hide your camera from the AI": corner presets, drawing with the
 * pointer, the keyboard, removing, the three-box limit and saving, at desktop and 390 px. Then,
 * at desktop, a real test stream through the dev stack: the editor shows the live analyzed
 * frame, and "What the AI sees" shows the hidden area blacked out.
 */
test.describe("hide your camera from the AI", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium");

  let ctx: BrowserContext;
  let source = { id: "", publishUrl: "" };
  const errors: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    ctx = await browser.newContext({ baseURL: BASE, viewport: info.project.use.viewport ?? undefined, hasTouch: info.project.use.hasTouch });
    await signIn(ctx, `Mask ${info.project.name}`);
    source = await createSource(ctx);
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test.beforeEach(() => {
    errors.length = 0;
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  async function open() {
    const page = await ctx.newPage();
    watchConsole(page, errors);
    await page.goto("/studio?tab=stream");
    const heading = page.getByRole("heading", { name: "Hide your camera from the AI", level: 3 });
    await expect(heading).toBeVisible();
    return page;
  }

  test("draws, moves and saves the boxes hidden from the AI", async () => {
    const page = await open();
    const section = page.locator("#hide-camera");
    const area = page.getByTestId("camera-mask-area");
    const boxes = page.getByTestId("camera-mask-box");
    await expect(section.getByText("Your viewers still see your full stream.")).toBeVisible();
    await expect(area.getByText("No live picture right now")).toBeVisible();
    await expect(section.getByText("Nothing is hidden from the AI.")).toBeVisible();

    // A corner preset, then save.
    await section.getByRole("button", { name: "Add a box in the bottom right corner" }).click();
    await expect(boxes).toHaveCount(1);
    await expect(section.getByText("Not saved yet.")).toBeVisible();
    await section.getByRole("button", { name: "Save boxes" }).click();
    await expect(page.getByTestId("camera-mask-status")).toHaveText("Saved. SLOT1 hides this area from the AI within a few seconds.");
    expect(await savedMask(ctx, source.id)).toEqual([{ x: 0.73, y: 0.68, w: 0.26, h: 0.3 }]);

    await expect(section.getByText("1 area is hidden from the AI.")).toBeVisible();

    // Draw a second box with the pointer (hover scrolls the area into view and settles first).
    const size = (await area.boundingBox())!;
    await area.hover({ position: { x: size.width * 0.1, y: size.height * 0.1 } });
    await page.mouse.down();
    const r = (await area.boundingBox())!;
    await page.mouse.move(r.x + r.width * 0.25, r.y + r.height * 0.3, { steps: 6 });
    await page.mouse.up();
    await expect(boxes).toHaveCount(2);

    // Keyboard: move it right by 3 %, make it 2 % taller.
    const second = boxes.nth(1);
    await second.focus();
    const before = await second.getAttribute("aria-label");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    const after = await second.getAttribute("aria-label");
    expect(after).not.toBe(before);
    await expect(section.getByRole("list", { name: "Hidden areas" }).getByRole("listitem")).toHaveCount(2);

    // A third box, then the limit.
    await section.getByRole("button", { name: "Add a box in the top left corner" }).click();
    await expect(boxes).toHaveCount(3);
    await expect(section.getByRole("button", { name: "Add a box in the top right corner" })).toHaveAttribute("aria-disabled", "true");
    await noHorizontalOverflow(page);
    await shot(page, "camera-mask-editor", section);

    // Remove one, save, and the server has exactly what's shown.
    await section.getByRole("button", { name: "Remove hidden area 3" }).click();
    await expect(boxes).toHaveCount(2);
    await section.getByRole("button", { name: "Save boxes" }).click();
    await expect(page.getByTestId("camera-mask-status")).toHaveText("Saved. SLOT1 hides these areas from the AI within a few seconds.");
    const saved = await savedMask(ctx, source.id);
    expect(saved).toHaveLength(2);
    expect(saved[1]!.x).toBeGreaterThan(0.1);
    // Undo returns to what's saved; Remove all + Save clears it.
    await section.getByRole("button", { name: "Add a box in the top left corner" }).click();
    await section.getByRole("button", { name: "Undo changes" }).click();
    await expect(boxes).toHaveCount(2);
    await section.getByRole("button", { name: "Remove all" }).click();
    await section.getByRole("button", { name: "Save boxes" }).click();
    await expect(page.getByTestId("camera-mask-status")).toHaveText("Saved. Nothing is hidden from the AI now.");
    expect(await savedMask(ctx, source.id)).toEqual([]);
    await noHorizontalOverflow(page);
    await page.close();
  });

  test("shows the live picture and the hidden area in What the AI sees", async () => {
    test.skip(test.info().project.name !== "desktop", "one live run is enough");
    test.skip(!existsSync(FONT), "needs DejaVu fonts for the test picture");
    test.setTimeout(150_000);
    const page = await open();
    const work = path.join(HERE, ".results", "camera-mask");
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, "cam.txt"), "MY WEBCAM");
    writeFileSync(path.join(work, "hud.txt"), "MISSION PASSED");
    // A test picture: a "webcam" tile top left, a HUD line bottom right.
    const vf = [
      "drawbox=x=40:y=40:w=360:h=220:color=0xf2e6ff:t=fill",
      `drawtext=fontfile=${FONT}:textfile=${path.join(work, "cam.txt")}:fontsize=40:fontcolor=0x241536:x=80:y=130`,
      "drawbox=x=700:y=540:w=540:h=110:color=white:t=fill",
      `drawtext=fontfile=${FONT}:textfile=${path.join(work, "hud.txt")}:fontsize=52:fontcolor=black:x=730:y=565`,
    ].join(",");
    let publisher: ChildProcess | null = null;
    try {
      publisher = spawn(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "color=0x3f1452:s=1280x720:r=15", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-g", "15", "-pix_fmt", "yuv420p", "-f", "flv", source.publishUrl],
        { stdio: "ignore" },
      );
      const headers = async () => ({ "x-slot1-csrf": await csrf(ctx.request), origin: BASE });
      // Hide the webcam tile, then turn analysis on once frames arrive.
      const put = await ctx.request.put(`${BASE}/api/studio/sources/${source.id}/camera-mask`, { data: { boxes: [{ x: 0.025, y: 0.045, w: 0.3, h: 0.33 }] }, headers: await headers() });
      expect(put.ok(), await put.text()).toBe(true);
      await expect
        .poll(async () => (await ctx.request.post(`${BASE}/api/studio/agent`, { data: { enabled: true }, headers: await headers() })).status(), { timeout: 60_000, intervals: [2000] })
        .toBe(200);

      // Studio's editor shows the newest analyzed frame, already black where the box is.
      await page.reload();
      const section = page.locator("#hide-camera");
      await expect(section.getByText("Your newest frame.", { exact: false })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("camera-mask-box")).toHaveCount(1);
      await shot(page, "camera-mask-live", section);

      // The watch page's "What the AI sees" labels the hidden area.
      const me = await (await ctx.request.get(`${BASE}/api/me`)).json();
      const watch = await ctx.newPage();
      watchConsole(watch, errors);
      await watch.goto(`/watch/${me.broadcaster.login}`);
      await watch.getByRole("button", { name: "What the AI sees" }).click();
      const panel = watch.getByTestId("ai-view");
      await expect(panel).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByTestId("ai-view-hidden")).toHaveCount(1);
      await expect(panel.getByRole("heading", { name: "Hidden by the creator" })).toBeVisible();
      await expect(panel.getByText("Hidden by the creator", { exact: true }).first()).toBeVisible();
      await shot(watch, "camera-mask-ai-view", panel);
      await watch.close();
    } finally {
      publisher?.kill("SIGTERM");
      await ctx.request.post(`${BASE}/api/studio/agent`, { data: { enabled: false }, headers: { "x-slot1-csrf": await csrf(ctx.request), origin: BASE } }).catch(() => undefined);
      await page.close();
    }
  });
});
