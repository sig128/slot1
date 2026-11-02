import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The header on phones: a compact bar (wordmark, sign-in, Menu) and the full-screen pause menu the
 * Menu button opens. Runs in the 390 px project; the desktop widths keep the tab row (journey.spec).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(HERE, "screenshots", "narrow", `${name}.png`) });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function sideways(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function rootOverflow(page: Page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).overflow);
}

/** How much of the screen, through the element's centre, a tap on it lands on (pseudo-element padding included). */
async function tapArea(target: Locator) {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("a, button") === el;
    let top = cy;
    let bottom = cy;
    let left = cx;
    let right = cx;
    while (hits(cx, top - 1)) top--;
    while (hits(cx, bottom + 1)) bottom++;
    while (hits(left - 1, cy)) left--;
    while (hits(right + 1, cy)) right++;
    return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, height: bottom - top + 1, width: right - left + 1 };
  });
}

async function expectTapTargets(targets: Locator) {
  for (const target of await targets.all()) {
    const area = await tapArea(target);
    expect(area.height, `${area.name}: tap height`).toBeGreaterThanOrEqual(44);
    expect(area.width, `${area.name}: tap width`).toBeGreaterThanOrEqual(44);
  }
}

test.describe("phone header and menu", () => {
  test.skip(({ viewport }) => (viewport?.width ?? Infinity) > 430, "the phone header is covered in the 390 px project");

  test("opens, navigates, closes with Escape and gives focus back", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: "Menu", exact: true });
    const menu = page.getByRole("dialog", { name: "Menu" });
    const header = page.locator("header");

    // The bar: the wordmark, the sign-in action and a labelled Menu button; the tab row is tucked away.
    await expect(header.getByRole("link", { name: "SLOT1 home" })).toBeVisible();
    // Sign in goes straight to Twitch, then back into Studio.
    await expect(header.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/api/auth/twitch/start?returnTo=%2Fstudio");
    await expect(menuButton).toBeVisible();
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await expect(menuButton).toHaveAttribute("aria-haspopup", "dialog");
    await expect(menuButton).toHaveAttribute("aria-controls", "site-menu");
    await expect(page.locator("#site-menu")).toBeAttached();
    await expect(menu).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(65);
    await expectTapTargets(header.locator("a, button").filter({ visible: true }));
    expect(await sideways(page), "page scrolls sideways").toBeLessThanOrEqual(1);
    await shot(page, "menu-closed");

    // Open: focus moves to the first page in the menu, the current one is on the selection bar,
    // and the wordmark and the Close button sit exactly where the wordmark and Menu were.
    const markBefore = await header.getByRole("link", { name: "SLOT1 home" }).boundingBox();
    const buttonBefore = await menuButton.boundingBox();
    const mainBefore = await page.locator("#main").boundingBox();
    await menuButton.click();
    await expect(menu).toBeVisible();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(await menu.evaluate((el) => getComputedStyle(el).animationName), "no motion with reduced motion").toBe("none");
    const nav = menu.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link")).toHaveText(["On Air", "Right now", "Moments", "Studio", "Setup"].map((n) => new RegExp(`^${n}`)));
    const onAir = nav.getByRole("link", { name: "On Air" });
    await expect(onAir).toBeFocused();
    await expect(onAir).toHaveAttribute("aria-current", "page");
    await expect(onAir).toHaveAccessibleDescription("Live channels and what SLOT1 logs");
    await expect(nav.getByRole("link", { name: "Right now" })).not.toHaveAttribute("aria-current");
    await expect(menu.getByRole("link", { name: "Sign in with Twitch" })).toHaveAttribute("href", "/api/auth/twitch/start?returnTo=%2Fstudio");
    const more = menu.getByRole("navigation", { name: "More" });
    await expect(more.getByRole("link", { name: /demo/i })).toHaveCount(0);
    for (const [name, href] of [
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["Contact", "/contact"],
      ["System status", "/status"],
    ] as const) {
      await expect(more.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    const markAfter = await menu.getByRole("link", { name: "SLOT1 home" }).boundingBox();
    const closeAfter = await menu.getByRole("button", { name: "Close" }).boundingBox();
    expect(markAfter?.x).toBeCloseTo(markBefore!.x, 0);
    expect(markAfter?.y).toBeCloseTo(markBefore!.y, 0);
    expect(closeAfter?.x).toBeCloseTo(buttonBefore!.x, 0);
    expect(closeAfter?.y).toBeCloseTo(buttonBefore!.y, 0);
    await expectTapTargets(menu.locator("a, button"));

    // The page behind doesn't scroll while the menu is open.
    expect(await rootOverflow(page)).toBe("hidden");
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(195, 640);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.scrollY), "page scrolled behind the menu").toBe(scrollBefore);
    expect(await sideways(page), "page scrolls sideways").toBeLessThanOrEqual(1);
    await shot(page, "menu-open");

    // Escape closes it and puts focus back on the Menu button; nothing moved underneath.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await expect(menuButton).toBeFocused();
    await expect.poll(() => rootOverflow(page), { message: "scroll lock released" }).not.toBe("hidden");
    const mainAfter = await page.locator("#main").boundingBox();
    expect({ x: mainAfter?.x, y: mainAfter?.y, width: mainAfter?.width }, "the page moved under the menu").toEqual({ x: mainBefore?.x, y: mainBefore?.y, width: mainBefore?.width });

    // Navigating closes it, and the new page is the current one.
    await menuButton.click();
    await nav.getByRole("link", { name: "Moments" }).click();
    await expect(page).toHaveURL(/\/moments$/);
    await expect(menu).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Moments" })).toBeVisible();
    await expect.poll(() => rootOverflow(page), { message: "scroll lock released" }).not.toBe("hidden");
    await menuButton.click();
    await expect(nav.getByRole("link", { name: "Moments" })).toHaveAttribute("aria-current", "page");
    await expect(onAir).not.toHaveAttribute("aria-current");

    // Any route change closes it, the browser's Back button included.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(menu).toBeHidden();

    // The Close button does what Escape does.
    await menuButton.click();
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Close" }).click();
    await expect(menu).toBeHidden();
    await expect(menuButton).toBeFocused();
    expect(errors, "browser console errors").toEqual([]);
  });

  test("keyboard: Tab reaches Menu, focus stays in the open menu, Escape returns", async ({ page }) => {
    await page.goto("/setup");
    const menuButton = page.getByRole("button", { name: "Menu", exact: true });
    const menu = page.getByRole("dialog", { name: "Menu" });
    // Skip link, wordmark, sign-in, then the Menu button.
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    await expect(menuButton).toBeFocused();
    expect(await menuButton.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    const onAir = menu.getByRole("link", { name: "On Air" });
    await expect(onAir).toBeFocused();
    expect(await onAir.evaluate((el) => getComputedStyle(el).outlineStyle), "visible focus").not.toBe("none");
    await expect(menu.getByRole("link", { name: "Setup" })).toHaveAttribute("aria-current", "page");

    // A full lap of Tab never reaches the page behind the menu.
    const stops = await menu.locator("a, button").count();
    for (let i = 0; i < stops + 2; i++) {
      await page.keyboard.press("Tab");
      const where = await page.evaluate(() => (document.activeElement?.closest("#site-menu") ? "menu" : document.activeElement === document.body ? "body" : "page"));
      expect(where, `Tab ${i + 1} left the menu`).not.toBe("page");
    }
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(menuButton).toBeFocused();
  });

  test("fits from 320 to 430 px, open or closed; tablets get the tab row", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: "Menu", exact: true });
    const menu = page.getByRole("dialog", { name: "Menu" });
    for (const width of [320, 340, 360, 375, 390, 414, 430]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(menuButton).toBeVisible();
      expect(await sideways(page), `${width} px: page scrolls sideways`).toBeLessThanOrEqual(1);
      const box = (await menuButton.boundingBox())!;
      expect(box.x + box.width, `${width} px: Menu button inside the screen`).toBeLessThanOrEqual(width);
      await menuButton.click();
      await expect(menu).toBeVisible();
      expect(await sideways(page), `${width} px open: page scrolls sideways`).toBeLessThanOrEqual(1);
      expect(await menu.evaluate((el) => el.scrollWidth - el.clientWidth), `${width} px: menu scrolls sideways`).toBeLessThanOrEqual(0);
      if (width === 320) await shot(page, "menu-open-320");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
    // Tablets in portrait and up: the tab row and the account are back in the header.
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "On Air" })).toHaveAttribute("aria-current", "page");
    await expect(menuButton).toBeHidden();
    expect(await sideways(page), "768 px: page scrolls sideways").toBeLessThanOrEqual(1);
    expect(errors, "browser console errors").toEqual([]);
  });

  test("signed in: the avatar in the bar and the account in the menu", async ({ page }) => {
    // A stand-in identity, so the shared stack's sessions are untouched.
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: {
          user: { id: "e2e-user", displayName: "Night Shift", kind: "twitch", isOperator: false },
          broadcaster: { id: "e2e-broadcaster", login: "night_shift_e2e", displayName: "Night Shift", avatarUrl: null, kind: "twitch" },
          csrfToken: "e2e",
        },
      }),
    );
    await page.goto("/");
    const header = page.locator("header");
    const avatar = header.getByRole("link", { name: "Night Shift" });
    await expect(avatar).toHaveAttribute("href", "/studio");
    await expect(header.getByRole("link", { name: /^Sign in/ })).toHaveCount(0);
    await expectTapTargets(avatar);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const account = page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Night Shift" });
    await expect(account).toHaveAttribute("href", "/studio");
    await expect(account).toHaveAccessibleDescription("Signed in with Twitch");
    expect(await sideways(page), "page scrolls sideways").toBeLessThanOrEqual(1);
    await shot(page, "menu-open-signed-in");
  });

  test.describe("with motion", () => {
    test.use({ reducedMotion: "no-preference" });

    test("fades in and out, and still closes on navigation", async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto("/setup");
      const menuButton = page.getByRole("button", { name: "Menu", exact: true });
      const menu = page.getByRole("dialog", { name: "Menu" });
      await menuButton.click();
      await expect(menu).toBeVisible();
      expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toBe("sh-menu-in");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(menuButton).toBeFocused();
      await menuButton.click();
      await menu.getByRole("link", { name: "On Air" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(menu).toBeHidden();
      await expect.poll(() => rootOverflow(page), { message: "scroll lock released" }).not.toBe("hidden");
      expect(errors, "browser console errors").toEqual([]);
    });
  });
});
