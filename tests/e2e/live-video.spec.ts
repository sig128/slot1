import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startWhepStandIn, type WhepStandIn } from "./support/whep-standin";

/**
 * SLOT1's own live video on the Watch page. The page, the player switch and the WebRTC (WHEP)
 * client are the real ones; the WHEP server is a local stand-in (werift + ffmpeg H.264), and the
 * playback grant from /api/sessions/:id/live-video is pointed at it. The grant endpoint itself
 * and the MediaMTX auth hook are covered by tests/integration/live-video.test.ts. MediaMTX is
 * not exercised here.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");

async function csrf(request: APIRequestContext): Promise<string> {
  return ((await (await request.get("/api/me")).json()) as { csrfToken: string }).csrfToken;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test.describe("SLOT1 live video", () => {
  // The stand-in WHEP server runs on a random local port that the dev CSP doesn't list.
  test.use({ bypassCSP: true });

  let standin: WhepStandIn | null = null;
  let publisher: ChildProcess | null = null;

  test.beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    standin = await startWhepStandIn({ video: SAMPLE });
  });

  test.afterAll(async () => {
    publisher?.kill("SIGKILL");
    await standin?.close();
  });

  test("plays SLOT1's own stream with a delay estimate and can switch to Twitch's player", async ({ page, baseURL }) => {
    const caps = (await (await page.request.get("/api/capabilities")).json()) as { ingest: { available: boolean; reason: string | null } };
    test.skip(!caps.ingest.available, `Needs a continuous-ingest gateway in the dev stack: ${caps.ingest.reason}`);
    const status = execFileSync("bash", [path.join(ROOT, "scripts/ingest-gateway.sh"), "status"], { encoding: "utf8" }).trim();
    if (status !== "running") execFileSync("bash", [path.join(ROOT, "scripts/ingest-gateway.sh"), "start"], { stdio: "ignore" });

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
    });

    // A creator with a TEST source that is really publishing, so the Watch page has a live session.
    const origin = new URL(baseURL!).origin;
    let token = await csrf(page.request);
    await page.request.post("/api/auth/local", { headers: { origin, "x-slot1-csrf": token }, data: { displayName: `Live ${test.info().project.name}` } });
    token = await csrf(page.request);
    const me = (await (await page.request.get("/api/me")).json()) as { broadcaster: { login: string } };
    const created = (await (
      await page.request.post("/api/studio/sources", { headers: { origin, "x-slot1-csrf": token }, data: { name: "Capture card", label: "test" } })
    ).json()) as { source: { id: string }; publishUrl: string };
    publisher = spawn("bash", [path.join(ROOT, "scripts/publish-test-stream.sh"), created.publishUrl], { stdio: "ignore" });
    await expect(async () => {
      const studio = (await (await page.request.get("/api/studio")).json()) as { sources: { id: string; sessionId: string | null }[] };
      expect(studio.sources.find((s) => s.id === created.source.id)?.sessionId).toBeTruthy();
    }).toPass({ timeout: 45_000, intervals: [1000] });

    // Point the playback grant at the stand-in WHEP server.
    await page.route("**/api/sessions/*/live-video", (route) =>
      route.fulfill({
        json: { available: true, reason: null, whepUrl: standin!.whepUrl, token: standin!.token, expiresAt: new Date(Date.now() + 120_000).toISOString() },
      }),
    );
    await page.goto(`/watch/${me.broadcaster.login}`);

    const player = page.locator('[data-live-player="live"]');
    await expect(player).toBeVisible({ timeout: 20_000 });
    await expect(player.getByText("SLOT1 live")).toBeVisible();
    await expect(async () => {
      expect(await player.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await expect(player.locator("[data-latency-badge]")).toContainText(/(~\d+\.\d|under 0\.1) s delay, estimated/, { timeout: 10_000 });

    const unmute = player.getByRole("button", { name: "Unmute" });
    await unmute.click();
    await expect(player.getByRole("button", { name: "Mute" })).toHaveAttribute("aria-pressed", "true");
    await noHorizontalOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, "live-video.png"), fullPage: true });

    // Viewers can always go back to Twitch's player, and return.
    const accepted = standin!.accepted();
    await page.getByRole("button", { name: "Twitch player" }).click();
    await expect(page.locator("[data-live-player]")).toHaveCount(0);
    await page.getByRole("button", { name: "Switch to SLOT1 video" }).click();
    await expect(page.locator('[data-live-player="live"]')).toBeVisible({ timeout: 20_000 });
    expect(standin!.accepted()).toBeGreaterThan(accepted);

    publisher.kill("SIGINT");
    publisher = null;
    await page.request.delete(`/api/studio/sources/${created.source.id}`, { headers: { origin, "x-slot1-csrf": await csrf(page.request) } });
    expect(errors, "browser console errors").toEqual([]);
  });
});
