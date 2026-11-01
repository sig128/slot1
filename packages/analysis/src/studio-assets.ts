import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StudioAssetManifest, type StudioAsset } from "@slot1/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Studio library folder: next to the bundle in production (copied by the api/worker tsup
 * configs), or packages/analysis/studio-assets in development. SLOT1_STUDIO_ASSETS_DIR overrides.
 */
export function studioAssetsDir(): string | null {
  const dirs = [process.env.SLOT1_STUDIO_ASSETS_DIR, path.resolve(here, "studio-assets"), path.resolve(here, "../studio-assets")].filter(
    (d): d is string => Boolean(d),
  );
  return dirs.find((d) => existsSync(path.join(d, "manifest.json"))) ?? null;
}

let cached: { dir: string; manifest: StudioAssetManifest } | null = null;

export function loadStudioAssetManifest(): StudioAssetManifest {
  const dir = studioAssetsDir();
  if (!dir) return { version: 1, assets: [] };
  if (cached?.dir === dir) return cached.manifest;
  const manifest = StudioAssetManifest.parse(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  cached = { dir, manifest };
  return manifest;
}

/** The asset and its absolute file path, or null for an unknown id or a missing file. */
export function resolveStudioAsset(id: string): { asset: StudioAsset; path: string } | null {
  const dir = studioAssetsDir();
  if (!dir) return null;
  const asset = loadStudioAssetManifest().assets.find((a) => a.id === id);
  if (!asset) return null;
  const file = path.resolve(dir, asset.file);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file)) return null;
  return { asset, path: file };
}
