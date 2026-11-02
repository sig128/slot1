import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { startObsStandIn, type ObsStandIn } from "./support/obs-standin";

/**
 * One-click start and the pages around it, at desktop and 390 px: the home hero's "Get [money
 * bag] Soon", /setup's three video choices and its permission list, the guided OBS setup a new
 * streamer lands in after Sign in with Twitch, and plain words (no setting names) when Twitch
 * sign-in isn't open. This stack has no Twitch app: the Twitch-connected views of the guided setup
 * run on stubbed /api/studio answers, and what reaches the API (nothing before Finish) is checked
 * on the requests the page sends. tests/integration/onboarding.test.ts covers the API side.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SLOT1_E2E_BASE_URL ?? "http://localhost:3000";
const OBS_PASSWORD = "e2e-onboard-obs-pass";
const ALL_SCOPES = ["channel:bot", "clips:edit", "channel:manage:clips", "channel:read:stream_key"];
/** Setting names and server commands nobody but an operator should read. */
const SERVER_WORDS = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\bslot1 (?:twitch|ai|update|demo|logs)\b|this deployment|README/;

function watchErrors(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource: the server responded with a status of 40[0-9]|\/_next\/(webpack-)?hmr|WebSocket connection to 'ws:\/\/localhost:\d+\/' failed/.test(m.text())) return;
    errors.push(m.text());
  });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`) });
}

test.describe("home hero: Get [money bag] Soon", () => {
  const errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors.length = 0;
    watchErrors(page, errors);
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("says creator rewards are coming, never that anyone is paid, and holds still under reduced motion", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "SLOT1: Your AI sidekick for GTA." })).toBeVisible();
    await expect(page.getByText("Stream GTA. Get clips. Train the AI.")).toBeVisible();
    const tag = page.getByTestId("creator-rewards");
    await expect(tag).toBeVisible();
    await expect(tag).toHaveAttribute("title", "Creator rewards are coming. Details soon.");
    await expect(tag.getByText("Soon", { exact: true })).toBeVisible();
    await expect(tag.locator("svg.mb-bag")).toBeVisible();
    // Screen readers hear what it is, and that it isn't here yet.
    await expect(tag).toContainText("creator rewards. Creator rewards are coming. Details soon.");
    await expect(page.getByText(/\b(get paid|earn money|payouts?|cash out)\b/i)).toHaveCount(0);
    // Our own drawing: an inline SVG, no image file and no emoji.
    expect(await tag.locator("img").count()).toBe(0);
    expect(await tag.textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
    // Reduced motion (the default here): nothing moves.
    expect(await tag.locator(".mb-hop").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    await noHorizontalOverflow(page);
    await shot(page, "hero-money-bag");
  });

  test("hops and glints with motion on, and pauses off screen", async ({ browser }, info) => {
    const ctx = await browser.newContext({ baseURL: BASE, reducedMotion: "no-preference", viewport: info.project.use.viewport ?? undefined });
    const page = await ctx.newPage();
    await page.goto("/");
    const tag = page.getByTestId("creator-rewards");
    const hop = tag.locator(".mb-hop");
    expect(await hop.evaluate((el) => getComputedStyle(el).animationName)).toBe("mb-hop");
    expect(await tag.locator(".mb-glint").evaluate((el) => getComputedStyle(el).animationName)).toBe("mb-glint");
    await expect.poll(() => hop.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("running");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => hop.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("paused");
    await ctx.close();
  });
});

test.describe("/setup: video sources and what Twitch is asked for", () => {
  test("three plain choices, each honest about what the AI gets", async ({ page }) => {
    const errors: string[] = [];
    watchErrors(page, errors);
    await page.goto("/setup#sources");
    const sources = page.locator("#sources");
    await expect(sources.getByRole("heading", { level: 2, name: "Video sources" })).toBeInViewport();
    await expect(sources.getByRole("heading", { level: 3, name: /^Streaming from a PC/ })).toBeVisible();
    await expect(sources.getByRole("heading", { level: 3, name: /^Streaming from PS5 or Xbox/ })).toBeVisible();
    await expect(sources.getByRole("heading", { level: 3, name: "No PC", exact: true })).toBeVisible();
    await expect(sources.getByText(/one click puts SLOT1’s Server and Stream Key into OBS/)).toBeVisible();
    await expect(sources.getByText(/Broadcast button can only send to Twitch or YouTube, never to SLOT1/)).toBeVisible();
    await expect(sources.getByText(/A capture card is a small box between the console and your TV that feeds the picture into a computer/)).toBeVisible();
    await expect(sources.getByText("PS Remote Play or the Xbox app + OBS")).toBeVisible();
    await expect(sources.getByText(/lower quality than with a capture card/)).toBeVisible();
    await expect(sources.getByText(/the chat bot works, and SLOT1 can analyze your Twitch clips/)).toBeVisible();
    await expect(sources.getByText(/The AI can’t watch live gameplay this way/)).toBeVisible();
    await expect(sources.getByText(/stay labeled TEST \/ REPLAY/)).toBeVisible();
    await expect(sources.getByText(/revoke at any time/)).toBeVisible();
    await expect(sources.getByText(/camera|webcam/i)).toHaveCount(0);

    // Twitch: four permissions, all on connect, each with its reason; nothing "Optional".
    const twitch = page.locator("#twitch");
    await expect(twitch.getByText("All on connect, one approval")).toBeVisible();
    await expect(twitch.locator(".su-perm")).toHaveCount(4);
    for (const s of ALL_SCOPES) await expect(twitch.locator(".su-perm code", { hasText: new RegExp(`^${s}$`) })).toHaveCount(1);
    await expect(twitch.getByText("Optional", { exact: true })).toHaveCount(0);
    expect(await page.locator("article").innerText()).not.toMatch(SERVER_WORDS);

    await noHorizontalOverflow(page);
    await page.locator("#sources").scrollIntoViewIfNeeded();
    await shot(page, "setup-video-sources");
    expect(errors, "browser console errors").toEqual([]);
  });
});

test.describe("Studio: the guided setup after Sign in with Twitch", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium");

  let obs: ObsStandIn;
  test.beforeAll(async ({ browserName }, info) => {
    test.skip(browserName !== "chromium" || info.project.name === "laptop", "covered at desktop and 390 px");
    obs = await startObsStandIn({ password: OBS_PASSWORD });
  });
  test.afterAll(async () => obs?.close());

  async function creator(browser: Browser, info: TestInfo, name: string) {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: info.project.use.viewport ?? undefined, hasTouch: info.project.use.hasTouch });
    const csrf = (await (await ctx.request.get(`${BASE}/api/me`)).json()).csrfToken as string;
    const res = await ctx.request.post(`${BASE}/api/auth/local`, { data: { displayName: `${name} ${info.project.name}` }, headers: { "x-slot1-csrf": csrf, origin: BASE } });
    expect(res.ok(), await res.text()).toBe(true);
    const page = await ctx.newPage();
    const errors: string[] = [];
    watchErrors(page, errors);
    return { ctx, page, errors };
  }

  /** Present the creator as Twitch-connected, on a SLOT1 with Twitch sign-in open (this stack has none). */
  async function asTwitchCreator(page: Page, opts: { missing?: string[]; forwarding?: boolean } = {}) {
    const missing = opts.missing ?? [];
    await page.route("**/api/capabilities", async (route) => {
      const res = await route.fetch();
      const caps = await res.json();
      caps.twitch = { available: true, reason: null, detail: null, setup: null };
      await route.fulfill({ response: res, json: caps });
    });
    await page.route("**/api/studio", async (route) => {
      const res = await route.fetch();
      const o = await res.json();
      o.twitch = { ...o.twitch, linked: true, login: "e2e_crew", scopes: ALL_SCOPES.filter((s) => !missing.includes(s)), missingScopes: missing, grantStatus: "active" };
      await route.fulfill({ response: res, json: o });
    });
    const sent: [string, string, unknown][] = [];
    let destinations: Record<string, unknown>[] = [];
    await page.route("**/api/studio/relay", async (route) => {
      const res = await route.fetch();
      const o = await res.json();
      o.twitch = { connected: true, forwardingPermission: opts.forwarding ?? !missing.includes("channel:read:stream_key"), permissionUrl: null };
      o.destinations = destinations;
      await route.fulfill({ response: res, json: o });
    });
    await page.route("**/api/studio/relay/destinations**", async (route) => {
      const req = route.request();
      sent.push([req.method(), new URL(req.url()).pathname, req.postDataJSON()]);
      const id = "00000000-0000-4000-8000-000000000001";
      if (req.method() === "POST") {
        destinations = [
          { id, platform: "twitch", label: "Twitch", enabled: false, status: "disabled", statusDetail: null, lastConnectedAt: null, serverHost: "ingest.global-contribute.live-video.net", keyHint: null },
        ];
        return route.fulfill({ json: destinations[0] });
      }
      destinations = [{ ...destinations[0], enabled: true, status: "idle" }];
      return route.fulfill({ json: destinations[0] });
    });
    return sent;
  }

  test("a visitor reads that Twitch sign-in isn't open yet, in plain words", async ({ page }) => {
    const caps = await (await page.request.get("/api/capabilities")).json();
    test.skip(caps.twitch.available, "this stack has Twitch sign-in");
    await page.goto("/studio");
    const closed = page.getByTestId("twitch-signin-closed");
    await expect(closed.getByText("Twitch sign-in isn’t open yet.")).toBeVisible();
    expect(await closed.innerText()).not.toMatch(SERVER_WORDS);
    await expect(page.getByTestId("setup-fix")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "How to register a Twitch app" })).toHaveCount(0);
    await page.goto("/");
    const note = page.getByTestId("twitch-closed-note");
    if (await note.count()) {
      await expect(note).toContainText("Twitch sign-in isn’t open yet, so creators can’t connect their channels.");
      expect(await note.innerText()).not.toMatch(SERVER_WORDS);
    }
  });

  test("lands on the panel, sets up OBS in one click, and finishes", async ({ browser }, info) => {
    const { ctx, page, errors } = await creator(browser, info, "Onboard");
    await page.goto("/studio?tab=stream&onboarding=1");
    const panel = page.getByTestId("stream-onboarding");
    const title = panel.getByRole("heading", { level: 2, name: "Now set up OBS (about 1 minute)" });
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    // A local workspace has no Twitch channel: no forwarding switch, said plainly.
    await expect(panel.getByText(/This is a local workspace/)).toBeVisible();
    await expect(panel.getByRole("switch")).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Your options" })).toHaveAttribute("href", "/setup#sources");

    await panel.getByLabel("OBS WebSocket password").fill(OBS_PASSWORD);
    await panel.getByLabel("Port", { exact: true }).fill(String(obs.port));
    await panel.getByRole("button", { name: "Set up OBS automatically" }).click();
    await expect(panel.getByTestId("obs-result")).toHaveText("Done. OBS now streams to SLOT1. Click Start Streaming in OBS when you’re ready.");
    expect(obs.settings?.streamServiceType).toBe("rtmp_custom");
    await expect(panel.getByText("OBS is pointed at SLOT1.")).toBeVisible();
    // The by-hand fallback is one click away.
    await panel.getByText("Prefer to paste the Server and Key into OBS yourself?").click();
    await expect(panel.getByRole("button", { name: "Show my Server and Key" })).toBeVisible();
    await noHorizontalOverflow(page);

    await panel.getByRole("button", { name: "Finish setup" }).click();
    await expect(panel.getByRole("heading", { level: 2, name: "You’re set up" })).toBeFocused();
    await panel.getByRole("button", { name: "Show all stream settings" }).click();
    await expect(page.getByRole("heading", { name: "Stream setup", level: 2 })).toBeVisible();
    await expect(page.getByTestId("stream-onboarding")).toHaveCount(0);
    await expect(page).not.toHaveURL(/onboarding=1/);
    expect(errors, "browser console errors").toEqual([]);
    await ctx.close();
  });

  test("forwarding to Twitch is a switch that starts on, and nothing is created before Finish", async ({ browser }, info) => {
    const { ctx, page, errors } = await creator(browser, info, "Forward");
    const sent = await asTwitchCreator(page);
    await page.goto("/studio?tab=stream&onboarding=1&twitch=connected");
    const panel = page.getByTestId("stream-onboarding");
    await expect(panel.getByRole("heading", { level: 2, name: "Connected. Now set up OBS (about 1 minute)" })).toBeFocused();
    await expect(panel.getByText("twitch.tv/e2e_crew")).toBeVisible();
    const sw = panel.getByRole("switch", { name: "SLOT1 sends your stream on to Twitch" });
    await expect(sw).toBeChecked();
    await expect(panel.getByText("If SLOT1 has a problem, your stream pauses everywhere until it’s back.")).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "onboarding-panel");

    // Looking and switching it off and on again creates nothing.
    await sw.click();
    await expect(sw).not.toBeChecked();
    await expect(panel.getByText(/Off: OBS streams to SLOT1 only, so you won’t be live on Twitch/)).toBeVisible();
    await sw.click();
    await expect(sw).toBeChecked();
    expect(sent).toEqual([]);

    await panel.getByRole("button", { name: "Finish setup" }).click();
    await expect(panel.getByText(/SLOT1 sends your stream on to Twitch\. It starts a few seconds after you go live/)).toBeVisible();
    expect(sent).toEqual([
      ["POST", "/api/studio/relay/destinations", { platform: "twitch" }],
      ["PATCH", "/api/studio/relay/destinations/00000000-0000-4000-8000-000000000001", { enabled: true }],
    ]);
    expect(errors, "browser console errors").toEqual([]);
    await ctx.close();
  });

  test("an older connection gets one click to grant what's missing", async ({ browser }, info) => {
    const { ctx, page, errors } = await creator(browser, info, "Veteran");
    const sent = await asTwitchCreator(page, { missing: ["channel:manage:clips", "channel:read:stream_key"] });
    await page.goto("/studio?tab=stream&onboarding=1");
    const panel = page.getByTestId("stream-onboarding");
    const notice = panel.getByTestId("twitch-permissions");
    await expect(notice).toContainText("downloading clips for analysis and sending your stream on to Twitch");
    await expect(notice.getByRole("link", { name: "Grant the missing permissions" })).toHaveAttribute(
      "href",
      `/api/auth/twitch/start?returnTo=${encodeURIComponent("/studio?tab=stream&onboarding=1")}`,
    );
    const sw = panel.getByRole("switch", { name: "SLOT1 sends your stream on to Twitch" });
    await expect(sw).toBeDisabled();
    await expect(sw).not.toBeChecked();
    await panel.getByRole("button", { name: "Finish setup" }).click();
    await expect(panel.getByText(/Forwarding to Twitch waits for Twitch’s OK/)).toBeVisible();
    expect(sent).toEqual([]);

    // The full page says the same, and comes back to Stream setup.
    await panel.getByRole("button", { name: "Show all stream settings" }).click();
    await expect(page.getByTestId("twitch-permissions").getByRole("link", { name: "Grant the missing permissions" })).toHaveAttribute(
      "href",
      `/api/auth/twitch/start?returnTo=${encodeURIComponent("/studio?tab=stream")}`,
    );
    await noHorizontalOverflow(page);
    expect(errors, "browser console errors").toEqual([]);
    await ctx.close();
  });
});
