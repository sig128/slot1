import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { startObsStandIn, type ObsStandIn } from "./support/obs-standin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SLOT1_E2E_BASE_URL ?? "http://localhost:3000";
const OBS_PASSWORD = "e2e-obs-websocket-pass";

async function csrf(req: APIRequestContext): Promise<string> {
  return (await (await req.get(`${BASE}/api/me`)).json()).csrfToken as string;
}

function watchConsole(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Expected: the API's 4xx answers the panel turns into messages, dev-server HMR noise, and
    // the browser's own line for the refused OBS connection the test provokes on purpose.
    if (/Failed to load resource: the server responded with a status of 40[0-9]|\/_next\/(webpack-)?hmr|WebSocket connection to 'ws:\/\/localhost:\d+\/' failed/.test(t)) return;
    errors.push(t);
  });
}

/** A port with nothing listening (and not one of the ports browsers refuse outright). */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`), fullPage: true });
}

/**
 * Studio → Stream setup: "Set up OBS automatically" against a stand-in OBS WebSocket v5 server
 * (not real OBS), the one Server + Key by hand, and forwarding destinations, at desktop and 390 px.
 */
test.describe("stream setup", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium");

  let ctx: BrowserContext;
  let obs: ObsStandIn;
  const errors: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    obs = await startObsStandIn({ password: OBS_PASSWORD });
    ctx = await browser.newContext({ baseURL: BASE, viewport: info.project.use.viewport ?? undefined, hasTouch: info.project.use.hasTouch });
    const res = await ctx.request.post(`${BASE}/api/auth/local`, { data: { displayName: `Stream ${info.project.name}` }, headers: { "x-slot1-csrf": await csrf(ctx.request), origin: BASE } });
    expect(res.ok(), await res.text()).toBe(true);
  });

  test.afterAll(async () => {
    await ctx?.close();
    await obs?.close();
  });

  test.beforeEach(() => {
    errors.length = 0;
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  async function open() {
    const page = await ctx.newPage();
    watchConsole(page, errors);
    await page.goto("/studio?tab=stream");
    await expect(page.getByRole("heading", { name: "Stream setup", level: 2 })).toBeVisible();
    await expect(page.getByText("Not set up yet. Start with the button below.").or(page.getByText(/Waiting for OBS/))).toBeVisible();
    return page;
  }

  test("sets up OBS in one click over OBS's WebSocket", async () => {
    const page = await open();
    await noHorizontalOverflow(page);
    await shot(page, "stream-setup");

    await page.getByLabel("OBS WebSocket password").fill(OBS_PASSWORD);
    await page.getByLabel("Port", { exact: true }).fill(String(obs.port));
    await page.getByRole("button", { name: "Set up OBS automatically" }).click();
    await expect(page.getByTestId("obs-result")).toHaveText("Done. OBS now streams to SLOT1. Click Start Streaming in OBS when you’re ready.");

    // OBS now holds SLOT1's one Server + Key, set and read back over the real protocol.
    expect(obs.identified).toBe(1);
    expect(obs.authFailures).toBe(0);
    expect(obs.requests).toEqual(["GetStreamStatus", "SetStreamServiceSettings", "GetStreamServiceSettings"]);
    const settings = obs.settings!;
    expect(settings.streamServiceType).toBe("rtmp_custom");
    const me = await (await ctx.request.get(`${BASE}/api/studio/relay`)).json();
    expect(settings.streamServiceSettings).toMatchObject({ server: me.ingest.server, use_auth: false });
    const key = String(settings.streamServiceSettings.key);
    expect(key).toMatch(/^[a-z0-9]+\?key=[A-Za-z0-9]{20,}$/);
    await expect(page.getByText(`Waiting for OBS. Your SLOT1 key ends in ${key.slice(-4)}.`)).toBeVisible();

    // The password is cleared and never kept; the key isn't shown on the page.
    await expect(page.getByLabel("OBS WebSocket password")).toHaveValue("");
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)).not.toContain(OBS_PASSWORD);
    expect(await page.content()).not.toContain(key.split("key=")[1]!);
    await noHorizontalOverflow(page);
    await page.close();
  });

  test("explains a wrong password, a closed OBS and OBS already streaming", async () => {
    const page = await open();
    const status = page.getByTestId("obs-result");
    const run = () => page.getByRole("button", { name: "Set up OBS automatically" }).click();
    const hintBefore = (await (await ctx.request.get(`${BASE}/api/studio/relay`)).json()).ingest.keyHint;

    await page.getByLabel("Port", { exact: true }).fill(String(obs.port));
    await page.getByLabel("OBS WebSocket password").fill("not-the-password");
    await run();
    await expect(status).toHaveText("OBS rejected the password. Copy it again from Tools → WebSocket Server Settings → Show Connect Info.");
    expect(obs.authFailures).toBe(1);

    await page.getByLabel("OBS WebSocket password").fill("");
    await run();
    await expect(status).toContainText("OBS asks for its WebSocket password.");

    obs.streaming = true;
    await page.getByLabel("OBS WebSocket password").fill(OBS_PASSWORD);
    await run();
    await expect(status).toHaveText("OBS is streaming right now. Click Stop Streaming in OBS, then try again.");
    obs.streaming = false;

    // Nothing reachable on the port: OBS closed, WebSocket server off, or the browser said no.
    await page.getByLabel("Port", { exact: true }).fill(String(await closedPort()));
    await run();
    await expect(status).toContainText("Couldn't reach OBS. Check that OBS is open, that Tools → WebSocket Server Settings → Enable WebSocket server is ticked");
    await expect(status).toContainText("If your browser asked to let this site connect to apps on this device, choose Allow.");

    // None of the failures replaced the creator's SLOT1 key.
    expect((await (await ctx.request.get(`${BASE}/api/studio/relay`)).json()).ingest.keyHint).toBe(hintBefore);
    await noHorizontalOverflow(page);
    await page.close();
  });

  test("shows the one Server + Key by hand, masked, with copy buttons", async () => {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    const page = await open();
    await page.getByRole("button", { name: "Show my Server and Key" }).click();
    const box = page.getByTestId("ingest-credentials");
    await expect(box).toBeVisible();
    const me = await (await ctx.request.get(`${BASE}/api/studio/relay`)).json();
    await expect(box.getByTestId("copy-server")).toHaveText(me.ingest.server);
    await expect(box.getByTestId("copy-stream-key")).toHaveText(new RegExp(`^•+${me.ingest.keyHint}$`));

    await box.getByRole("button", { name: "Copy Stream Key" }).click();
    await expect(box.getByRole("button", { name: "Copy Stream Key" })).toHaveText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`^[a-z0-9]+\\?key=[A-Za-z0-9]+${me.ingest.keyHint}$`));
    await box.getByRole("button", { name: "Show" }).click();
    await expect(box.getByTestId("copy-stream-key")).toHaveText(copied);
    await box.getByRole("button", { name: "Copy Server" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(me.ingest.server);
    await noHorizontalOverflow(page);
    await shot(page, "stream-setup-key");
    await page.close();
  });

  test("adds, switches and removes destinations without ever showing a key", async () => {
    const page = await open();
    const KICK_KEY = "sk_e2e_kick_secret_1234";
    const CUSTOM_KEY = "custom_e2e_secret_5678";

    // YouTube's secure server is filled in for the creator.
    await expect(page.getByLabel("Platform")).toHaveValue("youtube");
    await expect(page.getByLabel("Server", { exact: true })).toHaveValue("rtmps://a.rtmps.youtube.com:443/live2");

    await page.getByLabel("Platform").selectOption("kick");
    await page.getByLabel("Stream URL").fill("rtmps://198.51.100.20/app");
    await page.getByLabel("Stream key", { exact: true }).fill(KICK_KEY);
    await page.getByRole("button", { name: "Forward to Kick" }).click();
    const kick = page.getByTestId("relay-destination-kick");
    await expect(kick).toContainText("Kick · 198.51.100.20 · key ends in 1234");
    await expect(kick).toContainText("Ready");
    await expect(kick.getByRole("switch", { name: "Forward to Kick" })).toBeChecked();

    // Kick is taken now; the next form is for another platform or a custom server.
    await expect(page.getByLabel("Platform").locator("option")).toHaveText(["YouTube", "Custom RTMP server"]);
    await page.getByLabel("Platform").selectOption("custom");
    await page.getByLabel("Name").fill("Backup server");
    await page.getByLabel("Server", { exact: true }).fill("http://example.com/live");
    await page.getByLabel("Stream key", { exact: true }).fill(CUSTOM_KEY);
    await page.getByRole("button", { name: "Forward to this server" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The server address must start with rtmps:// or rtmp://." })).toBeVisible();
    await page.getByLabel("Server", { exact: true }).fill("rtmp://192.168.1.10/live");
    await page.getByRole("button", { name: "Forward to this server" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Forwarding only goes to public streaming servers." })).toBeVisible();
    await page.getByLabel("Server", { exact: true }).fill("rtmp://203.0.113.10/live");
    await page.getByRole("button", { name: "Forward to this server" }).click();
    const custom = page.getByTestId("relay-destination-custom");
    await expect(custom).toContainText("Custom server · 203.0.113.10 · key ends in 5678");

    // Keyboard: the switch toggles with Space.
    const sw = custom.getByRole("switch", { name: "Forward to Backup server" });
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).not.toBeChecked();
    await expect(custom).toContainText("Off");
    await page.keyboard.press("Space");
    await expect(sw).toBeChecked();

    expect(await page.content()).not.toContain(KICK_KEY);
    expect(await page.content()).not.toContain(CUSTOM_KEY);
    await noHorizontalOverflow(page);
    await shot(page, "stream-destinations");

    // Removing asks first, then erases the destination and its key.
    await kick.getByRole("button", { name: "Remove" }).click();
    await expect(kick).toContainText("Remove Kick? Its saved key is erased.");
    await kick.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("relay-destination-kick")).toHaveCount(0);
    await expect(page.getByLabel("Platform").locator("option")).toHaveText(["YouTube", "Kick", "Custom RTMP server"]);
    await noHorizontalOverflow(page);
    await page.close();
  });
});
