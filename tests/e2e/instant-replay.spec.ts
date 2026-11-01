import { expect, test, type Page } from "@playwright/test";
import { ingestAvailable, startLiveCreator, waitForReplayableMoment, type LiveCreator, type SeenObservation } from "./support/live-seed";

/**
 * Instant replay on the live Watch page, moment links, and `?t=` jumps, against the real dev
 * stack: a TEST stream really published to the ingest gateway, recorded and analyzed by the dev
 * worker. The viewer is anonymous: a public stream's replays are for everyone who can watch it.
 */
function watchConsole(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
  });
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
async function currentTime(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? v.currentTime : -1));
}

test.describe("instant replay and timestamps", () => {
  test.describe.configure({ mode: "serial" });

  let creator: LiveCreator | null = null;
  let moment: SeenObservation | null = null;
  const errors: string[] = [];

  test.beforeAll(async ({ baseURL }, info) => {
    test.setTimeout(240_000);
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    const ingest = await ingestAvailable(baseURL!);
    test.skip(!ingest.ok, `Needs a continuous-ingest gateway in the dev stack: ${ingest.reason}`);
    creator = await startLiveCreator(baseURL!, `Replay ${info.project.name}`, { recording: true });
    moment = await waitForReplayableMoment(creator);
    await expect(async () => {
      const st = (await (await creator!.req.get(`/api/sessions/${creator!.sessionId}/instant-replay`)).json()) as { available: boolean };
      expect(st.available).toBe(true);
    }).toPass({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await creator?.dispose();
  });

  test.beforeEach(({ page }) => {
    errors.length = 0;
    watchConsole(page, errors);
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("replays a moment beside Twitch's player, then goes back to live", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/watch/${creator!.login}`);
    const replay = page.locator(`li[data-observation-id="${moment!.id}"]`).getByRole("button", { name: /^Instant replay: / });
    await expect(replay).toBeVisible({ timeout: 30_000 });
    await replay.click();

    const pip = page.locator("section[data-instant-replay]");
    await expect(pip).toHaveAttribute("data-instant-replay", "ready", { timeout: 45_000 });
    await expect(pip.getByRole("heading", { name: /Instant replay/ })).toBeVisible();
    await expect.poll(() => currentTime(page, "section[data-instant-replay] video"), { timeout: 20_000 }).toBeGreaterThan(0.5);
    // Keyboard focus moved into the player.
    expect(await pip.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // The dev stack has no WebRTC, so the main player is Twitch's: the replay docks in SLOT1's
    // rail and never covers it.
    await expect(pip).toHaveAttribute("data-variant", "dock");
    const main = (await page.locator("[data-main-player]").boundingBox())!;
    const box = (await pip.boundingBox())!;
    expect(overlaps(main, box), `replay ${JSON.stringify(box)} over the main player ${JSON.stringify(main)}`).toBe(false);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `tests/e2e/screenshots/${test.info().project.name}/instant-replay.png` });

    await pip.getByRole("button", { name: "Pause the replay" }).click();
    await expect(pip.getByRole("button", { name: "Play the replay" })).toBeVisible();
    await pip.getByRole("button", { name: "Back to live" }).click();
    await expect(pip).toHaveCount(0);
    await expect(replay).toBeFocused();

    // Escape closes it too, and focus comes back again.
    await replay.click();
    await expect(pip).toHaveAttribute("data-instant-replay", "ready", { timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(pip).toHaveCount(0);
    await expect(replay).toBeFocused();
  });

  test("a moment link opens that moment's instant replay while the stream is live", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`/m/${moment!.id}`);
    await expect(page).toHaveURL(new RegExp(`/watch/${creator!.login}\\?moment=${moment!.id}$`));
    const pip = page.locator("section[data-instant-replay]");
    await expect(pip).toHaveAttribute("data-instant-replay", "ready", { timeout: 45_000 });
    await expect.poll(() => currentTime(page, "section[data-instant-replay] video"), { timeout: 20_000 }).toBeGreaterThan(0.5);
    await expect(page.locator(`li[data-observation-id="${moment!.id}"] button[data-rail-item]`)).toHaveAttribute("aria-pressed", "true");
  });

  test("?t= lands 3 s early on the recording and on its library page", async ({ page }) => {
    test.setTimeout(180_000);
    // The stream ends: the dev worker turns the recording into a playable file.
    creator!.stopPublishing();
    let itemId = "";
    await expect(async () => {
      const lib = (await (await creator!.req.get("/api/library")).json()) as { items: { id: string; kind: string; status: string; sessionId: string | null }[] };
      const rec = lib.items.find((i) => i.kind === "recording" && i.sessionId === creator!.sessionId && i.status === "ready");
      expect(rec).toBeTruthy();
      itemId = rec!.id;
    }).toPass({ timeout: 150_000, intervals: [3000] });
    // The recording is the creator's own until shared: watch as the creator.
    await page.context().addCookies((await creator!.req.storageState()).cookies);

    await page.goto(`/replay/${creator!.sessionId}?t=0:20`);
    await expect.poll(() => currentTime(page, "video"), { timeout: 30_000 }).toBeGreaterThan(-1);
    expect(Math.abs((await currentTime(page, "video")) - 17)).toBeLessThan(0.6);
    await noHorizontalOverflow(page);

    await page.goto(`/v/${itemId}?t=20`);
    await expect(page.locator("video")).toHaveAttribute("src", /#t=17\.0$/);
    await expect.poll(() => currentTime(page, "video"), { timeout: 30_000 }).toBeGreaterThan(-1);
    expect(Math.abs((await currentTime(page, "video")) - 17)).toBeLessThan(0.6);

    // Clickable "Play" timestamps in the log jump the recording 3 s before the entry.
    await page.goto(`/replay/${creator!.sessionId}`);
    const entry = page.locator("li[data-observation-id]").filter({ has: page.getByRole("button", { name: /^Play from / }) }).first();
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => currentTime(page, "video"), { timeout: 30_000 }).toBeGreaterThan(-1);
    const label = (await entry.getByRole("button", { name: /^Play from / }).getAttribute("aria-label"))!;
    const [, m, s] = /Play from (\d+):(\d+)/.exec(label)!;
    await entry.getByRole("button", { name: /^Play from / }).click();
    const target = Math.max(0, Number(m) * 60 + Number(s) - 3);
    await expect.poll(async () => Math.abs((await currentTime(page, "video")) - target), { timeout: 10_000 }).toBeLessThan(1.6);
  });
});
