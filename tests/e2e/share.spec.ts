import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "../fixtures/generated/sample-replay.mp4");
const BASE = process.env.SLOT1_E2E_BASE_URL ?? "http://localhost:3000";

/** Records what the page handed to the share sheet instead of opening a real one. */
const MOCK_SHARE = () => {
  const w = window as unknown as { __shared: unknown[] };
  w.__shared = [];
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: (d?: ShareData) => Boolean(d && (d.url || (d.files?.length && d.files.every((f) => f.type === "video/mp4")))),
  });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (d: ShareData) => {
      w.__shared.push({ title: d.title, text: d.text, url: d.url, files: (d.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
    },
  });
};
/** A browser without the Web Share API (most desktop browsers on Linux, older ones elsewhere). */
const NO_SHARE = () => {
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
};

async function csrf(req: APIRequestContext): Promise<string> {
  return (await (await req.get(`${BASE}/api/me`)).json()).csrfToken as string;
}
async function call(req: APIRequestContext, method: "post" | "patch", url: string, data: unknown) {
  const res = await req[method](`${BASE}${url}`, { data, headers: { "x-slot1-csrf": await csrf(req), origin: BASE } });
  expect(res.ok(), `${method.toUpperCase()} ${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

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

/**
 * Sharing finished clips without any platform API: the owner's file goes to the system share
 * sheet (mocked here), browsers without it get Download plus the upload pages, captions copy to
 * the clipboard, and other people only ever get the page link.
 */
test.describe("share a finished clip", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium");

  let owner: BrowserContext;
  let itemId = "";
  let title = "";
  const errors: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    info.setTimeout(300_000);
    owner = await browser.newContext({ baseURL: BASE, viewport: info.project.use.viewport ?? undefined });
    const req = owner.request;
    await call(req, "post", "/api/auth/local", { displayName: `Share ${info.project.name}` });

    const upload = await req.post(`${BASE}/api/uploads`, {
      headers: { "x-slot1-csrf": await csrf(req), origin: BASE },
      multipart: {
        title: "Docks run, share test",
        rightsConfirmed: "true",
        file: { name: "sample.mp4", mimeType: "video/mp4", buffer: await readFile(SAMPLE) },
      },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const { sessionId } = (await upload.json()) as { sessionId: string };

    await expect(async () => {
      const s = await (await req.get(`${BASE}/api/sessions/${sessionId}`)).json();
      expect(s.processing?.state ?? "succeeded").toBe("succeeded");
      expect(s.playback).toBeTruthy();
    }).toPass({ timeout: 150_000, intervals: [3000] });

    // A vertical clip around the MISSION PASSED moment, rendered by the worker.
    await call(req, "post", "/api/clips", {
      sessionId,
      kind: "owned_render",
      centerMs: 27_000,
      preRollMs: 3000,
      postRollMs: 3000,
      vertical: true,
      caption: "MISSION PASSED",
      idempotencyKey: `share-e2e-${info.project.name}-${Date.now()}`,
    });
    await expect(async () => {
      const lib = await (await req.get(`${BASE}/api/library?kind=clip_export`)).json();
      const item = (lib.items as { id: string; kind: string; status: string; title: string; url: string | null }[]).find((i) => i.kind === "clip_export" && i.status === "ready" && i.url);
      expect(item).toBeTruthy();
      itemId = item!.id;
      title = item!.title;
    }).toPass({ timeout: 150_000, intervals: [3000] });
  });

  test.afterAll(async () => {
    await owner?.close();
  });

  test.beforeEach(() => {
    errors.length = 0;
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("the owner sends the video file to the share sheet", async () => {
    const page = await owner.newPage();
    watchConsole(page, errors);
    await page.addInitScript(MOCK_SHARE);
    await page.goto(`/v/${itemId}`);
    const panel = page.getByRole("region", { name: `Share ${title}` });
    await expect(panel).toBeVisible();
    // Small clips are prepared on their own, so the tap that shares is the user's only tap.
    const share = panel.getByRole("button", { name: "Share", exact: true });
    await expect(share).toBeVisible({ timeout: 30_000 });
    await share.click();
    await expect(panel.getByText("Sent to the share sheet")).toBeVisible();
    const shared = (await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)) as {
      title: string;
      text: string;
      files: { name: string; type: string; size: number }[];
    }[];
    expect(shared).toHaveLength(1);
    expect(shared[0]!.files).toHaveLength(1);
    expect(shared[0]!.files[0]).toMatchObject({ type: "video/mp4", name: "MISSION-PASSED.mp4" });
    expect(shared[0]!.files[0]!.size).toBeGreaterThan(50_000);
    expect(shared[0]!.title).toBe(title);
    expect(shared[0]!.text).toContain("#MissionPassed");
    await noHorizontalOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, "share-panel.png"), fullPage: true });
    await page.close();
  });

  test("without file sharing it offers a download and the upload pages", async () => {
    const page = await owner.newPage();
    watchConsole(page, errors);
    await page.addInitScript(NO_SHARE);
    await page.goto(`/v/${itemId}`);
    const panel = page.getByRole("region", { name: `Share ${title}` });
    await expect(panel.getByText("Download the video, then upload it in the app or on the site.")).toBeVisible();
    const download = panel.getByRole("link", { name: `Download ${title}` });
    await expect(download).toHaveAttribute("download", "MISSION-PASSED.mp4");
    await expect(panel.getByRole("link", { name: /^Open TikTok/ })).toHaveAttribute("href", "https://www.tiktok.com/");
    await expect(panel.getByRole("link", { name: /^Open YouTube Studio/ })).toHaveAttribute("href", "https://studio.youtube.com/");
    await expect(panel.getByRole("link", { name: /^Open Instagram/ })).toHaveAttribute("href", "https://www.instagram.com/");
    await expect(panel.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    // Keyboard: the download is reachable and shows a focus ring.
    await download.focus();
    expect(await download.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await noHorizontalOverflow(page);
    await page.close();
  });

  test("the caption can be edited and copied", async () => {
    await owner.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    const page = await owner.newPage();
    watchConsole(page, errors);
    await page.addInitScript(NO_SHARE);
    await page.goto(`/v/${itemId}`);
    const caption = page.getByLabel("Caption");
    await expect(caption).toHaveValue("MISSION PASSED!\n\n#GTA #MissionPassed #gaming #clips");
    await caption.fill("Docks finale, first try\n\n#GTA #MissionPassed");
    await page.getByRole("button", { name: "Copy caption" }).click();
    await expect(page.getByRole("button", { name: "Caption copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Docks finale, first try\n\n#GTA #MissionPassed");
    await page.close();
  });

  test("the Library opens the same share panel", async () => {
    const page = await owner.newPage();
    watchConsole(page, errors);
    await page.addInitScript(MOCK_SHARE);
    await page.goto("/studio");
    await page.getByRole("tab", { name: "Library" }).click();
    const open = page.getByRole("button", { name: `Share ${title}` }).first();
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: `Share ${title}` }).first();
    await expect(panel.getByRole("button", { name: "Share", exact: true })).toBeVisible({ timeout: 30_000 });
    await noHorizontalOverflow(page);
    await panel.getByRole("button", { name: /^Close/ }).click();
    await expect(page.getByRole("region", { name: `Share ${title}` })).toHaveCount(0);
    await page.close();
  });

  test("other people get the page link, never the file", async ({ browser }) => {
    await call(owner.request, "patch", "/api/studio/settings", { visibility: "public" });
    await call(owner.request, "patch", `/api/library/${itemId}`, { visibility: "unlisted" });
    const viewer = await browser.newContext({ baseURL: BASE, viewport: test.info().project.use.viewport ?? undefined });
    const page = await viewer.newPage();
    watchConsole(page, errors);
    await page.addInitScript(MOCK_SHARE);
    await page.goto(`/v/${itemId}`);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: `Share ${title}` })).toHaveCount(0);
    await page.getByRole("button", { name: "Share link" }).click();
    const shared = (await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)) as { url?: string; files: unknown[] }[];
    expect(shared).toEqual([{ title, text: undefined, url: `${BASE}/v/${itemId}`, files: [] }]);
    await noHorizontalOverflow(page);

    // Private again: nobody else can open it, so there is nothing to share.
    await call(owner.request, "patch", `/api/library/${itemId}`, { visibility: "private" });
    expect((await viewer.request.get(`${BASE}/v/${itemId}`)).status()).toBe(404);
    expect((await viewer.request.get(`${BASE}/api/library/${itemId}`)).status()).toBe(404);
    await viewer.close();
  });
});
