import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The site's primary navigation. From 768 px it is the header's tab row; on phones it sits in the
 * full-screen menu behind the header's Menu button, which this opens first.
 */
export async function openPrimaryNav(page: Page): Promise<Locator> {
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  if (await menuButton.isVisible()) {
    await menuButton.click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  }
  return page.getByRole("navigation", { name: "Primary" });
}

/** Closes the phone menu if it is open, the way a visitor would (Escape). */
export async function closeMenu(page: Page): Promise<void> {
  const menu = page.getByRole("dialog", { name: "Menu" });
  if (await menu.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
}
