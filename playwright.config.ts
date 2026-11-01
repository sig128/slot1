import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end journey in a real browser at three widths. Needs the full stack (Postgres, Redis,
 * API, worker, web): `bash scripts/local-services.sh start && bash scripts/dev-stack.sh start`.
 */
const BASE_URL = process.env.SLOT1_E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "tests/e2e/.results",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, reducedMotion: "reduce", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: process.env.SLOT1_E2E_BASE_URL
    ? undefined
    : { command: "bash scripts/dev-stack.sh start", url: `${BASE_URL}/api/health`, reuseExistingServer: true, timeout: 120_000 },
});
