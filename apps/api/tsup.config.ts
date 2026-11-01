import { defineConfig } from "tsup";

// Internal @slot1/* packages are TypeScript source, so they are bundled in; third-party
// packages stay external and are installed as this app's own dependencies.
export default defineConfig({
  // admin-link.js prints a one-time admin sign-in link; admin-password.js hashes a new admin
  // password read from stdin (docs/ADMIN.md).
  entry: ["src/main.ts", "src/admin-link.ts", "src/admin-password.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@slot1\//],
  // The bundle carries its SQL migrations (resolved next to dist/main.js at runtime).
  async onSuccess() {
    const { cp } = await import("node:fs/promises");
    await cp("../../packages/db/migrations", "dist/migrations", { recursive: true });
    // The Studio library (sounds, music, ambience, visual elements), resolved next to dist/main.js.
    await cp("../../packages/analysis/studio-assets", "dist/studio-assets", { recursive: true });
  },
});
