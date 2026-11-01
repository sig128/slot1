import { defineConfig } from "tsup";

// Internal @slot1/* packages are TypeScript source, so they are bundled in; third-party
// packages stay external and are installed as this app's own dependencies.
export default defineConfig({
  // dist/main.js: the worker. dist/demo-broadcast.js: the demo stream generator (docs/DEMO.md).
  entry: { main: "src/main.ts", "demo-broadcast": "src/demo/broadcast.ts" },
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
    // OFL fonts for burned-in clip text (resolved next to dist/main.js by findRenderFonts).
    await cp("../../packages/analysis/fonts", "dist/fonts", { recursive: true });
  },
});
