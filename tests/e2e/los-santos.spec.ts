import { expect, test, type Page } from "@playwright/test";
import { ingestAvailable, startLiveCreator, type LiveCreator } from "./support/live-seed";

/**
 * "Los Santos right now" in a real browser at desktop and 390 px: two TEST streams really
 * published to the dev stack, the page listing them with what SLOT1 sees, and the radio-wheel
 * selector driven by keyboard and pointer.
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

test.describe("Los Santos right now", () => {
  test.describe.configure({ mode: "serial" });

  const creators: LiveCreator[] = [];
  const errors: string[] = [];

  test.beforeAll(async ({ baseURL }, info) => {
    test.setTimeout(180_000);
    test.skip(info.project.name === "laptop", "covered at desktop and 390 px");
    const ingest = await ingestAvailable(baseURL!);
    test.skip(!ingest.ok, `Needs a continuous-ingest gateway in the dev stack: ${ingest.reason}`);
    const tag = info.project.name === "narrow" ? "N" : "D";
    creators.push(...(await Promise.all([startLiveCreator(baseURL!, `Vinewood ${tag}`), startLiveCreator(baseURL!, `Del Perro ${tag}`)])));
  });
  test.afterAll(async () => {
    await Promise.all(creators.map((c) => c.dispose()));
  });
  test.beforeEach(({ page }) => {
    errors.length = 0;
    watchConsole(page, errors);
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("lists the live streams with what SLOT1 sees, and switches with the wheel", async ({ page }, info) => {
    test.setTimeout(120_000);
    const [a, b] = creators as [LiveCreator, LiveCreator];
    const narrow = info.project.name === "narrow";
    await page.goto(`/los-santos?stream=${a.login}`);
    await expect(page.getByRole("heading", { name: "Los Santos right now", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Right now" })).toHaveAttribute("aria-current", "page");
    const list = page.getByRole("complementary", { name: "Live streams" });
    await expect(list.getByRole("button", { name: new RegExp(a.displayName) })).toBeVisible({ timeout: 20_000 });
    await expect(list.getByRole("button", { name: new RegExp(b.displayName) })).toBeVisible();
    // The selected stream: its name, the TEST label (a test stream is never presented as live
    // gameplay) and what SLOT1 saw, refreshed by polling.
    const main = page.locator("#ls-activity");
    await expect(page.getByRole("link", { name: a.displayName, exact: true })).toBeVisible();
    await expect(page.getByText("TEST / REPLAY").first()).toBeVisible();
    await expect(main).not.toBeEmpty();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `tests/e2e/screenshots/${info.project.name}/los-santos.png`, fullPage: true });

    // Keyboard: Q opens the selector on the playing stream; arrows choose; Enter switches.
    await page.locator("body").press("q");
    const dialog = page.getByRole("dialog", { name: "CHOOSE A STREAM" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-wheel", narrow ? "strip" : "wheel");
    const group = dialog.getByRole("radiogroup", { name: "Live streams" });
    const checked = group.getByRole("radio", { checked: true });
    await expect(checked).toHaveAccessibleName(new RegExp(`^${a.displayName}.*now watching$`));
    await expect(checked).toBeFocused();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `tests/e2e/screenshots/${info.project.name}/los-santos-wheel.png` });
    for (let i = 0; i < 12; i++) {
      if (new RegExp(`^${b.displayName}`).test((await group.getByRole("radio", { checked: true }).getAttribute("aria-label")) ?? "")) break;
      await page.keyboard.press("ArrowRight");
    }
    await expect(group.getByRole("radio", { checked: true })).toHaveAccessibleName(new RegExp(`^${b.displayName}`));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: b.displayName, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`stream=${b.login}`));
    // Focus goes back to the button that opens the selector.
    await expect(page.getByRole("button", { name: /Choose stream/ })).toBeFocused();

    // Pointer (or touch): open with the button and pick a stream directly.
    await page.getByRole("button", { name: /Choose stream/ }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: new RegExp(`^${a.displayName}`) }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: a.displayName, exact: true })).toBeVisible();

    // Escape closes without switching.
    await page.getByRole("button", { name: /Choose stream/ }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: a.displayName, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Choose stream/ })).toBeFocused();

    // The cards switch streams too.
    await list.getByRole("button", { name: new RegExp(b.displayName) }).click();
    await expect(page.getByRole("link", { name: b.displayName, exact: true })).toBeVisible();
    await expect(list.getByRole("button", { name: new RegExp(b.displayName) })).toHaveAttribute("aria-pressed", "true");
    await noHorizontalOverflow(page);
  });
});
