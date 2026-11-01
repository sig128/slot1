import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(HERE, "screenshots", test.info().project.name, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

/** JSON-LD blocks on the page, parsed. */
async function structuredData(page: Page): Promise<Record<string, unknown>[]> {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.map((b) => JSON.parse(b) as Record<string, unknown>);
}

test.describe("legal pages and search", () => {
  const errors: string[] = [];
  test.beforeEach(({ page }, testInfo) => {
    // Only the phone and desktop widths: these pages have no layout in between worth a third run.
    test.skip(testInfo.project.name === "laptop", "covered by desktop and narrow");
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 40[134]|\/_next\/(webpack-)?hmr/.test(m.text())) errors.push(m.text());
    });
  });
  test.afterEach(() => expect(errors, "browser console errors").toEqual([]));

  test("the Privacy Policy is complete, navigable and honest about the AI services in use", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    await expect(page.getByText("Last updated: 1 November 2026")).toBeVisible();
    const contents = page.getByRole("navigation", { name: "Contents" });
    for (const s of ["Who is responsible", "What we collect and why", "Cookies and similar technologies", "Who processes your information", "Your rights", "Children"])
      await expect(contents.getByRole("link", { name: new RegExp(s) })).toBeVisible();
    // The contents links jump to their sections.
    await contents.getByRole("link", { name: /Your rights/ }).click();
    await expect(page).toHaveURL(/#rights$/);
    await expect(page.getByRole("heading", { level: 2, name: /Your rights/ })).toBeInViewport();
    // The cookie it names is the one SLOT1 really sets, and the analytics design is spelled out.
    await expect(page.getByRole("heading", { name: "slot1_session" })).toBeVisible();
    await expect(page.getByText(/Do Not Track or Global Privacy Control/)).toBeVisible();
    await expect(page.getByText(/Hetzner Online GmbH/)).toBeVisible();
    // The dev stack has no AI provider configured: the page says so instead of naming one.
    await expect(page.getByText(/None is switched on right now/)).toBeVisible();
    // Every contact route works without an email address.
    await expect(page.locator('a[href="/contact?topic=privacy"]').first()).toBeVisible();
    // A private tool and an analytics script must never be what makes this page work.
    expect(await page.locator('meta[name="robots"][content*="noindex"]').count()).toBe(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/privacy$/);
    await noHorizontalOverflow(page);
    await shot(page, "privacy");
  });

  test("the Terms of Service cover the agreed topics", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
    for (const s of ["The licence SLOT1 needs", "AI output", "Forwarding your stream", "Copyright complaints", "Limitation of liability", "Governing law and disputes", "Trademarks and affiliation"])
      await expect(page.getByRole("heading", { level: 2, name: new RegExp(s) })).toBeVisible();
    await expect(page.getByText(/laws of the place where the operator of SLOT1 is established/)).toBeVisible();
    await expect(page.locator('a[href="/contact?topic=copyright"]').first()).toBeVisible();
    await noHorizontalOverflow(page);
    await shot(page, "terms");
  });

  test("the footer links to both documents", async ({ page }) => {
    await page.goto("/setup");
    const footer = page.getByRole("navigation", { name: "Footer" });
    await footer.getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });

  test("the home page explains SLOT1 to search engines and new visitors", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 2, name: "A broadcast companion that shows its evidence." })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "What’s in SLOT1" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Instant replay" })).toBeVisible();
    // The FAQ opens like a disclosure and its answers are in the page for crawlers.
    const q = page.getByText("Does SLOT1 work with a PS5?");
    await q.click();
    await expect(page.getByText(/A PS5 on its own can only stream to Twitch or YouTube/)).toBeVisible();

    const data = await structuredData(page);
    const graph = data.find((d) => Array.isArray(d["@graph"]))?.["@graph"] as { "@type": string; mainEntity?: { name: string }[] }[];
    expect(graph.map((n) => n["@type"])).toEqual(["Organization", "WebSite", "WebApplication", "FAQPage"]);
    expect(graph[3]!.mainEntity!.map((m) => m.name)).toContain("Does SLOT1 work with a PS5?");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/opengraph-image/);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
    await noHorizontalOverflow(page);
    await shot(page, "home-landing");
  });

  test("robots.txt, the sitemap and share images are served", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toMatch(/Disallow: \/admin/);
    expect(robots).toMatch(/Disallow: \/studio/);
    expect(robots).toMatch(/Allow: \/api\/library\/\*\/poster/);
    expect(robots).toMatch(/Sitemap: https?:\/\/[^/\s]+\/sitemap\.xml/);
    const sitemap = await (await request.get("/sitemap.xml")).text();
    for (const p of ["/privacy", "/terms", "/los-santos", "/setup"]) expect(sitemap).toContain(`${p}</loc>`);
    expect(sitemap).not.toMatch(/\/(admin|studio|demo)</);
    for (const p of ["/opengraph-image", "/twitter-image", "/apple-icon", "/watch/someone_else/opengraph-image"]) {
      const r = await request.get(p);
      expect(r.status(), p).toBe(200);
      expect(r.headers()["content-type"], p).toBe("image/png");
    }
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "SLOT1", start_url: "/", theme_color: "#101014" });
  });

  test("watch-only pages of other channels stay out of search results", async ({ page }) => {
    await page.goto("/watch/someone_else");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await page.goto("/studio");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
});
