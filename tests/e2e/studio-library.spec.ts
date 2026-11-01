import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SLOT1_E2E_BASE_URL ?? "http://localhost:3000";
const PREVIEW = process.env.SLOT1_LIBRARY_PREVIEW_DIR;

async function csrf(req: APIRequestContext): Promise<string> {
  return (await (await req.get(`${BASE}/api/me`)).json()).csrfToken as string;
}

function watchConsole(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Expected: 4xx answers the UI turns into messages, and dev-server HMR noise.
    if (/Failed to load resource: the server responded with a status of 40[0-9]|\/_next\/(webpack-)?hmr/.test(t)) return;
    errors.push(t);
  });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string, locator?: Locator) {
  const project = test.info().project.name;
  const files = [path.join(HERE, "screenshots", project, `${name}.png`)];
  if (PREVIEW) {
    mkdirSync(PREVIEW, { recursive: true });
    files.push(path.join(PREVIEW, `${project}-${name}.png`));
  }
  for (const file of files) {
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file });
  }
}

/**
 * Studio → Sounds and elements: the built-in library browser (AssetLibraryPanel, browse mode) at
 * desktop and 390 px. Search, category chips, one preview at a time, favorites that survive a
 * reload, thumbnails served by the library route, keyboard tabs, and no sideways scroll.
 */
test.describe("studio library", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium");

  let ctx: BrowserContext;
  let page: Page;
  const errors: string[] = [];
  const panel = () => page.getByRole("region", { name: "Sounds and elements library" });
  const list = (label: string) => panel().getByRole("list", { name: new RegExp(`^${label}, \\d+ results?$`) });

  test.beforeAll(async ({ browser }, info) => {
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    ctx = await browser.newContext({ baseURL: BASE, viewport: info.project.use.viewport ?? undefined, hasTouch: info.project.use.hasTouch, reducedMotion: "reduce" });
    const res = await ctx.request.post(`${BASE}/api/auth/local`, { data: { displayName: "Library tester" }, headers: { "x-slot1-csrf": await csrf(ctx.request), origin: BASE } });
    expect(res.ok(), await res.text()).toBe(true);
    page = await ctx.newPage();
    watchConsole(page, errors);
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test.beforeEach(() => {
    errors.length = 0;
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("opens from Studio with every family", async () => {
    await page.goto("/studio#sounds");
    await expect(page.getByRole("heading", { name: "Sounds and elements" })).toBeVisible();
    await expect(panel().getByText(/^\d+ items, all made for SLOT1$/)).toBeVisible();
    for (const t of ["Sounds", "Music", "Ambience", "Elements", "Frames", "Transitions"]) {
      await expect(panel().getByRole("tab", { name: t, exact: true })).toBeAttached();
    }
    await expect(panel().getByRole("tab", { name: "Sounds", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(await list("Sounds").getByRole("listitem").count()).toBeGreaterThanOrEqual(120);
    // Browse mode: listen and star, nothing to add.
    await expect(panel().getByRole("button", { name: /^Add / })).toHaveCount(0);
    await noHorizontalOverflow(page);
  });

  test("search and category chips narrow the list", async () => {
    const search = panel().getByRole("searchbox", { name: "Search sounds" });
    await search.fill("siren");
    const rows = list("Sounds").getByRole("listitem");
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(40);
    for (const name of await rows.locator(".alib-name").allTextContents()) expect(name.length).toBeGreaterThan(0);

    await search.fill("zzzz nothing");
    await expect(panel().getByText("No sounds match “zzzz nothing”. Try another word, or clear the filters.")).toBeVisible();
    await panel().getByRole("button", { name: "Clear filters" }).click();
    await expect(search).toHaveValue("");

    const cash = panel().getByRole("button", { name: "Cash", exact: true });
    await cash.click();
    await expect(cash).toHaveAttribute("aria-pressed", "true");
    const cats = await list("Sounds").locator(".alib-cat").allTextContents();
    expect(cats.length).toBeGreaterThan(2);
    expect(new Set(cats)).toEqual(new Set(["Cash"]));
    await panel().getByRole("button", { name: "All", exact: true }).click();
    await expect(cash).toHaveAttribute("aria-pressed", "false");
  });

  test("a sound effect plays and stops on its own", async () => {
    const row = list("Sounds").getByRole("listitem").first();
    const file = page.waitForResponse((r) => r.url().includes("/api/studio/assets/file/") && r.request().method() === "GET");
    await row.getByRole("button", { name: /^Play / }).click();
    const res = await file;
    expect([200, 206]).toContain(res.status());
    expect(res.headers()["content-type"]).toBe("audio/mp4");
    expect(res.headers()["cache-control"]).toContain("immutable");
    // A one-shot under a second: it ends by itself and the row goes back to Play.
    await expect(row.getByRole("button", { name: /^Play / })).toBeVisible();
    await expect(row).not.toHaveAttribute("data-state", /.+/);
  });

  test("music plays one loop at a time until stopped", async () => {
    await panel().getByRole("tab", { name: "Music", exact: true }).click();
    const rows = list("Music").getByRole("listitem");
    expect(await rows.count()).toBeGreaterThanOrEqual(12);
    const first = rows.nth(0);
    const second = rows.nth(1);
    await expect(first.getByText("Loops,", { exact: false })).toBeAttached();
    await first.getByRole("button", { name: /^Play / }).click();
    await expect(first).toHaveAttribute("data-state", "playing");
    await expect(first.getByRole("button", { name: /^Stop / })).toBeVisible();
    await shot(page, "studio-library-playing", panel());

    // Starting another loop stops the first.
    await second.getByRole("button", { name: /^Play / }).click();
    await expect(second).toHaveAttribute("data-state", "playing");
    await expect(first).not.toHaveAttribute("data-state", /.+/);
    await expect(panel().getByRole("button", { name: /^Stop / })).toHaveCount(1);
    await second.getByRole("button", { name: /^Stop / }).click();
    await expect(panel().getByRole("button", { name: /^Stop / })).toHaveCount(0);

    // Switching sections stops a preview too.
    await first.getByRole("button", { name: /^Play / }).click();
    await expect(first).toHaveAttribute("data-state", "playing");
    await panel().getByRole("tab", { name: "Ambience", exact: true }).click();
    expect(await list("Ambience").getByRole("listitem").count()).toBeGreaterThanOrEqual(6);
    await expect(panel().getByRole("button", { name: /^Stop / })).toHaveCount(0);
  });

  test("favorites survive a reload and filter the list", async () => {
    await panel().getByRole("tab", { name: "Sounds", exact: true }).click();
    const row = list("Sounds").getByRole("listitem").nth(3);
    const name = (await row.locator(".alib-name").textContent()) ?? "";
    const star = row.getByRole("button", { name: `Favorite ${name}` });
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(panel().getByRole("tab", { name: "Sounds", exact: true })).toBeVisible();
    await expect(panel().getByRole("button", { name: `Favorite ${name}` })).toHaveAttribute("aria-pressed", "true");
    const favChip = panel().getByRole("button", { name: "Favorites", exact: true });
    await favChip.click();
    await expect(list("Sounds").getByRole("listitem")).toHaveCount(1);
    await expect(list("Sounds").locator(".alib-name")).toHaveText(name);
    await shot(page, "studio-library-favorites", panel());

    // Unstarring empties the filter and says how to fill it.
    await panel().getByRole("button", { name: `Favorite ${name}` }).click();
    await expect(panel().getByText("You haven't starred any sounds yet. Star one and it shows up here.")).toBeVisible();
    await favChip.click();
    await expect(favChip).toHaveAttribute("aria-pressed", "false");
  });

  test("elements, frames and transitions show thumbnails", async () => {
    await panel().getByRole("tab", { name: "Elements", exact: true }).click();
    const tiles = list("Elements").getByRole("listitem");
    expect(await tiles.count()).toBeGreaterThanOrEqual(60);
    const imgs = list("Elements").locator("img");
    await expect
      .poll(async () => imgs.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: "first thumbnail loads" })
      .toBe(true);
    await noHorizontalOverflow(page);
    await shot(page, "studio-library-elements", panel());

    await panel().getByRole("tab", { name: "Frames", exact: true }).click();
    expect(await list("Frames").getByRole("listitem").count()).toBeGreaterThanOrEqual(8);

    await panel().getByRole("tab", { name: "Transitions", exact: true }).click();
    const t = list("Transitions").getByRole("listitem");
    expect(await t.count()).toBeGreaterThanOrEqual(8);
    await expect.poll(async () => t.first().locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    await shot(page, "studio-library-transitions", panel());
  });

  test("tabs work from the keyboard", async () => {
    const sounds = panel().getByRole("tab", { name: "Sounds", exact: true });
    await sounds.click();
    await sounds.focus();
    await page.keyboard.press("ArrowRight");
    await expect(panel().getByRole("tab", { name: "Music", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel().getByRole("tab", { name: "Music", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel().getByRole("button", { name: "Favorites", exact: true })).toBeFocused();
    await noHorizontalOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "studio-library-page");
  });
});
