import { defineConfig } from "tsup";

// Internal @slot1/* packages are TypeScript source and get bundled; native/third-party
// packages (onnxruntime-node, sharp, fastify, pg…) stay external as this app's own dependencies.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@slot1\//],
});
