import { z } from "zod";

/**
 * The Studio's built-in library: original sounds and visual elements SLOT1 ships with
 * (listed in docs/ASSET_MANIFEST.md). EDLs reference them by `id`; the worker resolves the
 * file at render time and the API serves previews.
 */
export const StudioAssetKind = z.enum(["sfx", "music", "ambience", "sticker", "overlay", "frame", "transition"]);
export type StudioAssetKind = z.infer<typeof StudioAssetKind>;

export const StudioAsset = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/)
    .describe('Stable library id referenced from an EDL, e.g. "sfx/impacts/heavy-hit-01"'),
  kind: StudioAssetKind,
  category: z.string().describe("Library category shown in the Studio, e.g. impacts, whooshes, risers, hud"),
  name: z.string().describe("Display name"),
  tags: z.array(z.string()).default([]).describe("Search words"),
  durationMs: z.number().int().positive().optional().describe("Audio or animated assets: length"),
  loop: z.boolean().default(false).describe("Music and ambience that loop seamlessly"),
  width: z.number().int().positive().optional().describe("Visual assets: intrinsic width in px"),
  height: z.number().int().positive().optional().describe("Visual assets: intrinsic height in px"),
  file: z.string().describe("File path relative to the library folder"),
  license: z.string().describe('"Original (SLOT1)" or an open license with its attribution'),
});
export type StudioAsset = z.infer<typeof StudioAsset>;

export const StudioAssetManifest = z.object({ version: z.literal(1), assets: z.array(StudioAsset) });
export type StudioAssetManifest = z.infer<typeof StudioAssetManifest>;

/**
 * GET /api/studio/assets: the manifest plus a revision (append `?v=<rev>` to file URLs so they
 * can be cached for good) and small waveform peaks for previewing audio without downloading it.
 */
export const StudioAssetsResponse = StudioAssetManifest.extend({
  rev: z.string().describe("Changes whenever the library changes"),
  peaks: z.record(z.string(), z.array(z.number().min(0).max(1))).default({}).describe("Preview waveform peaks (0–1) per audio asset id"),
});
export type StudioAssetsResponse = z.infer<typeof StudioAssetsResponse>;
