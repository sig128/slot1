import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The clipping guides (apps/web/lib/clip-guides.ts): SEO landing pages for GTA clippers by
 * platform. They render for anyone, read well at every width, and tell search engines what they
 * are (title, description, canonical, share card, structured data, sitemap).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUIDES = [
  { path: "/gta-clips", h1: "GTA clips for TikTok, Shorts and Reels", crumbs: ["Home", "GTA clips"] },
  { path: "/gta-clips/ps5", h1: "GTA clips on PS5, ready for TikTok", crumbs: ["Home", "GTA clips", "PS5"] },
  { path: "/gta-clips/xbox", h1: "GTA clips on Xbox, ready for TikTok", crumbs: ["Home", "GTA clips", "Xbox"] },
  { path: "/gta-clips/pc", h1: "Auto-clips for GTA on PC", crumbs: ["Home", "GTA clips", "PC"] },
  { path: "/gta-6", h1: "Get ready to clip GTA 6", crumbs: ["Home", "GTA 6 clips"] },
];

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test.describe("clipping guides", () => {
  for (const g of GUIDES) {
    test(`${g.path} reads well and describes itself to search engines`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const res = await page.goto(g.path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: g.h1 })).toBeVisible();
      const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(crumbs.getByRole("listitem")).toHaveText(g.crumbs);
      await expect(crumbs.locator('[aria-current="page"]')).toHaveText(g.crumbs.at(-1)!);
      // Sign in goes straight to Twitch, then into Studio.
      await expect(page.getByRole("link", { name: "Sign in with Twitch" }).first()).toHaveAttribute("href", /^\/api\/auth\/twitch\/start\?returnTo=/);

      // Questions open in place; the answers are in the page either way.
      const first = page.locator("details.cg-q").first();
      await expect(first).not.toHaveAttribute("open");
      await first.locator("summary").click();
      await expect(first).toHaveAttribute("open", "");
      await expect(first.locator("p")).toBeVisible();

      // Search engines: a canonical address, a description, a share card and structured data.
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${g.path.replace(/\//g, "\\/")}$`));
      expect((await page.locator('meta[name="description"]').getAttribute("content"))!.length).toBeGreaterThan(100);
      await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute("content", new RegExp(`${g.path}/opengraph-image`));
      const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!) as { "@graph": { "@type": string }[] };
      const types = ld["@graph"].map((n) => n["@type"]);
      expect(types).toEqual(expect.arrayContaining(["WebPage", "BreadcrumbList", "FAQPage", "Organization", "WebSite", "WebApplication"]));
      await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);

      // Every guide links to the others.
      const more = page.getByRole("region", { name: "More guides" });
      expect(await more.getByRole("link").count()).toBeGreaterThanOrEqual(4);
      await noHorizontalOverflow(page);
      expect(errors).toEqual([]);
    });
  }

  test("the share cards are images", async ({ request }) => {
    for (const g of GUIDES) {
      const r = await request.get(`${g.path}/opengraph-image`);
      expect(r.status(), g.path).toBe(200);
      expect(r.headers()["content-type"]).toContain("image/png");
    }
  });

  test("the sitemap lists them, the footer and the home page link to them", async ({ page, request }) => {
    const sitemap = await (await request.get("/sitemap.xml")).text();
    for (const g of GUIDES) expect(sitemap).toContain(`${g.path}</loc>`);
    expect(await (await request.get("/robots.txt")).text()).not.toMatch(/Disallow: \/gta/);

    await page.goto("/");
    const footer = page.getByRole("navigation", { name: "Footer" });
    await expect(footer.getByRole("link", { name: "GTA clips for TikTok" })).toHaveAttribute("href", "/gta-clips");
    await expect(footer.getByRole("link", { name: "PS5 clips" })).toHaveAttribute("href", "/gta-clips/ps5");
    await expect(footer.getByRole("link", { name: "Xbox clips" })).toHaveAttribute("href", "/gta-clips/xbox");
    await expect(footer.getByRole("link", { name: "GTA 6 clips" })).toHaveAttribute("href", "/gta-6");
    // The home page's "Auto-clips" row (its label: "Make GTA clips for TikTok") leads to the guides.
    await expect(page.getByRole("region", { name: "What you get" }).getByRole("link", { name: "Auto-clips", exact: true })).toHaveAttribute("href", "/gta-clips");

    await page.goto("/gta-clips/ps5");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, "guide-ps5.png"), fullPage: true });
    await page.goto("/gta-clips");
    await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, "guide-hub.png"), fullPage: true });
  });
});
