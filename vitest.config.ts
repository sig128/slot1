import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pkgs = ["analysis", "bot", "contracts", "db", "platform", "services", "twitch", "gta-runtime"];

export default defineConfig({
  resolve: {
    // Internal packages are consumed as TypeScript source, exactly as the apps use them.
    alias: [
      { find: /^@slot1\/twitch\/url$/, replacement: r("./packages/twitch/src/url.ts") },
      ...pkgs.map((p) => ({ find: new RegExp(`^@slot1/${p}$`), replacement: r(`./packages/${p}/src/index.ts`) })),
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          // One shared test database: files run one after another.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
