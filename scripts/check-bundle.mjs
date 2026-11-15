#!/usr/bin/env node
// Checks an app's tsup bundle before it ships (run by the Docker build, after `build`).
//
// The API and worker bundle SLOT1's own @slot1/* packages and leave third-party packages external,
// installed as the app's own dependencies (pnpm deploy). A third-party package that isn't one of
// the app's dependencies either gets bundled (and breaks if it has native parts or reads its own
// files: sharp stopped the API from starting this way) or is imported but not installed. Both fail
// here, so a broken version never replaces the running one.
//
//   node scripts/check-bundle.mjs apps/api
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const app = process.argv[2];
if (!app) {
  console.error("usage: node scripts/check-bundle.mjs <app dir>");
  process.exit(2);
}
const dist = path.join(app, "dist");
const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules);
const problems = [];

const nameOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

// 1. No third-party code bundled in (the metafile lists every input file).
const meta = JSON.parse(readFileSync(path.join(dist, "metafile-esm.json"), "utf8"));
const bundled = new Set();
for (const input of Object.keys(meta.inputs)) {
  const i = input.lastIndexOf("node_modules/");
  if (i >= 0) bundled.add(nameOf(input.slice(i + "node_modules/".length)));
}
for (const name of bundled) problems.push(`${name} is bundled into ${app}: add it to ${app}/package.json dependencies, or mark it external if this app never uses it`);

// 2. Every static import of a package resolves to one of the app's dependencies or a Node built-in.
for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(path.join(dist, file), "utf8");
  for (const m of src.matchAll(/^import\s[^;]*?from\s*"([^"./][^"]*)"/gm)) {
    const name = nameOf(m[1]);
    if (builtins.has(name) || builtins.has(name.replace(/^node:/, "")) || deps.has(name)) continue;
    problems.push(`${dist}/${file} imports ${m[1]}, which isn't a dependency of ${app}`);
  }
}

if (problems.length) {
  console.error(`check-bundle: ${app} would not start or would be missing code:\n  - ${[...new Set(problems)].join("\n  - ")}`);
  process.exit(1);
}
console.log(`check-bundle: ${app} ok (${deps.size} dependencies, nothing third-party bundled)`);
