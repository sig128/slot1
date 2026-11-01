import { createHash } from "node:crypto";
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

let cachedPeaks: { dir: string; peaks: Record<string, number[]> } | null = null;

/** Preview waveform peaks per audio asset id (waveforms.json, written by the generator). */
export function loadStudioAssetPeaks(): Record<string, number[]> {
  const dir = studioAssetsDir();
  if (!dir) return {};
  if (cachedPeaks?.dir === dir) return cachedPeaks.peaks;
  const file = path.join(dir, "waveforms.json");
  const peaks = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>) : {};
  cachedPeaks = { dir, peaks };
  return peaks;
}

let cachedRev: { dir: string; rev: string } | null = null;

/** Short content hash of the library's manifest and peaks: changes whenever the library changes. */
export function studioAssetsRev(): string {
  const dir = studioAssetsDir();
  if (!dir) return "none";
  if (cachedRev?.dir === dir) return cachedRev.rev;
  const h = createHash("sha256").update(readFileSync(path.join(dir, "manifest.json")));
  const peaks = path.join(dir, "waveforms.json");
  if (existsSync(peaks)) h.update(readFileSync(peaks));
  cachedRev = { dir, rev: h.digest("hex").slice(0, 12) };
  return cachedRev.rev;
}

const CONTENT_TYPES: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function studioAssetContentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A compact view of the library for AI prompts: what each item is and when to use it, without
 * file paths. Pick assets by `id`; match on `kind`, `category` and `tags`.
 */
export function studioAssetCatalog(kinds?: StudioAsset["kind"][]): Array<Pick<StudioAsset, "id" | "kind" | "category" | "name" | "tags"> & { durationMs?: number; loop?: boolean }> {
  return loadStudioAssetManifest()
    .assets.filter((a) => !kinds || kinds.includes(a.kind))
    .map((a) => ({ id: a.id, kind: a.kind, category: a.category, name: a.name, tags: a.tags, ...(a.durationMs ? { durationMs: a.durationMs } : {}), ...(a.loop ? { loop: true } : {}) }));
}
