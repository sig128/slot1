#!/usr/bin/env node
// Copies ONNX Runtime Web's WebAssembly file into public/ort/<version>/ so the AI overlay's object
// finder can load it from this site (the content security policy allows nothing else). Runs before
// `next build` and `next dev`; public/ort/ isn't committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const require = createRequire(path.join(web, "package.json"));
const file = "ort-wasm-simd-threaded.wasm";
const from = require.resolve(`onnxruntime-web/${file}`);
const { version } = JSON.parse(readFileSync(path.join(path.dirname(from), "..", "package.json"), "utf8"));
const dir = path.join(web, "public", "ort", version);
if (!existsSync(from)) {
  console.error(`copy-ort: ${from} is missing; is onnxruntime-web installed?`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
copyFileSync(from, path.join(dir, file));
console.log(`copy-ort: public/ort/${version}/${file}`);
