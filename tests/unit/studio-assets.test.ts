import { openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StudioAsset, StudioAssetManifest, StudioAssetsResponse } from "@slot1/contracts";
import {
  loadStudioAssetManifest,
  loadStudioAssetPeaks,
  resolveStudioAsset,
  studioAssetCatalog,
  studioAssetContentType,
  studioAssetsDir,
  studioAssetsRev,
} from "@slot1/analysis";

/** The Studio library (docs/ASSET_MANIFEST.md, "Studio library"): contract, files, budget, coverage. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, "packages/analysis/studio-assets");
const raw = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as { version: number; assets: Record<string, unknown>[] };
const manifest = StudioAssetManifest.parse(raw);
const peaks = JSON.parse(readFileSync(path.join(DIR, "waveforms.json"), "utf8")) as Record<string, number[]>;

const MB = 1_000_000;
const AUDIO = new Set(["sfx", "music", "ambience"]);
const VISUAL = new Set(["sticker", "overlay", "frame", "transition"]);
const of = (kind: string) => manifest.assets.filter((a) => a.kind === kind);
const sizeOf = (file: string) => statSync(path.join(DIR, file)).size;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function head(file: string, n: number): Buffer {
  const fd = openSync(path.join(DIR, file), "r");
  try {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, 0);
    return b;
  } finally {
    closeSync(fd);
  }
}

describe("Studio library manifest", () => {
  it("validates against the contract, with no fields the contract doesn't know", () => {
    expect(StudioAssetManifest.safeParse(raw).success).toBe(true);
    const known = new Set(Object.keys(StudioAsset.shape));
    for (const a of raw.assets) for (const k of Object.keys(a)) expect(known, `${String(a.id)}: unknown field ${k}`).toContain(k);
  });

  it("has unique ids and unique files", () => {
    const ids = manifest.assets.map((a) => a.id);
    const files = manifest.assets.map((a) => a.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it("labels every item Original (SLOT1) and keeps names clear of game brands", () => {
    for (const a of manifest.assets) {
      expect(a.license, a.id).toBe("Original (SLOT1)");
      expect(`${a.name} ${a.tags.join(" ")}`, a.id).not.toMatch(/rockstar|take-two|grand theft|\bgta\b|pricedown/i);
      expect(a.name.trim().length, a.id).toBeGreaterThan(1);
      expect(a.tags.length, a.id).toBeGreaterThan(1);
    }
  });

  it("covers every family with the promised depth", () => {
    expect(of("sfx").length).toBeGreaterThanOrEqual(120);
    expect(new Set(of("sfx").map((a) => a.category)).size).toBeGreaterThanOrEqual(12);
    expect(of("music").length).toBeGreaterThanOrEqual(12);
    expect(of("ambience").length).toBeGreaterThanOrEqual(6);
    const visuals = manifest.assets.filter((a) => VISUAL.has(a.kind));
    expect(visuals.length).toBeGreaterThanOrEqual(80);
    for (const k of VISUAL) expect(of(k).length, k).toBeGreaterThanOrEqual(8);
  });
});

describe("Studio library files", () => {
  it("has every file, inside the library, in the right format", () => {
    for (const a of manifest.assets) {
      expect(a.file, a.id).not.toMatch(/(^|\/)\.\.?(\/|$)|\\|^\//);
      const abs = path.resolve(DIR, a.file);
      expect(abs.startsWith(DIR + path.sep), a.id).toBe(true);
      expect(sizeOf(a.file), a.id).toBeGreaterThan(200);
      if (AUDIO.has(a.kind)) {
        expect(a.file, a.id).toMatch(/\.m4a$/);
        expect(head(a.file, 12).subarray(4, 8).toString("latin1"), `${a.id} is MP4`).toBe("ftyp");
      } else {
        expect(a.file, a.id).toMatch(/\.png$/);
        const h = head(a.file, 24);
        expect(h.subarray(1, 4).toString("latin1"), `${a.id} is PNG`).toBe("PNG");
        expect({ w: h.readUInt32BE(16), h: h.readUInt32BE(20) }, `${a.id} size matches the manifest`).toEqual({ w: a.width, h: a.height });
      }
    }
  });

  it("has nothing on disk that the manifest doesn't list", () => {
    const listed = new Set(manifest.assets.map((a) => path.join(DIR, a.file)));
    const extra = walk(DIR).filter((f) => !listed.has(f) && !["manifest.json", "waveforms.json"].includes(path.relative(DIR, f)));
    expect(extra).toEqual([]);
  });

  it("stays within its size budget", () => {
    const audio = manifest.assets.filter((a) => AUDIO.has(a.kind)).reduce((n, a) => n + sizeOf(a.file), 0);
    const total = walk(DIR).reduce((n, f) => n + statSync(f).size, 0);
    expect(audio, "audio bytes").toBeLessThan(8 * MB);
    expect(total, "library bytes").toBeLessThan(14 * MB);
    for (const a of manifest.assets) expect(sizeOf(a.file), a.id).toBeLessThan(1 * MB);
  });
});

describe("Studio library metadata", () => {
  it("gives audio durations, loop flags and preview peaks", () => {
    for (const a of manifest.assets.filter((x) => AUDIO.has(x.kind))) {
      expect(a.durationMs, a.id).toBeGreaterThan(0);
      expect(a.durationMs!, a.id).toBeLessThan(a.kind === "sfx" ? 8000 : 40_000);
      expect(a.loop, a.id).toBe(a.kind !== "sfx");
      const p = peaks[a.id];
      expect(p?.length, `${a.id} peaks`).toBe(48);
      for (const v of p!) expect(v >= 0 && v <= 1, `${a.id} peak ${v}`).toBe(true);
      expect(Math.max(...p!), `${a.id} is not silent`).toBeGreaterThan(0.05);
    }
    // Peaks only for audio that exists.
    for (const id of Object.keys(peaks)) expect(manifest.assets.some((a) => a.id === id && AUDIO.has(a.kind)), id).toBe(true);
  });

  it("sizes every visual and tells the editor how to move transitions", () => {
    for (const a of manifest.assets.filter((x) => VISUAL.has(x.kind))) {
      expect(a.width, a.id).toBeGreaterThan(0);
      expect(a.height, a.id).toBeGreaterThan(0);
      // Full-frame pieces fill a landscape (16:9) or vertical (9:16) video.
      if (a.kind !== "sticker") expect([16 / 9, 9 / 16].some((r) => Math.abs(a.width! / a.height! - r) < 0.005), `${a.id} is 16:9 or 9:16`).toBe(true);
    }
    for (const t of of("transition")) {
      expect(t.durationMs, t.id).toBeGreaterThan(0);
      expect(t.tags.find((x) => x.startsWith("motion:")), t.id).toMatch(/^motion:(fade|slide-left|slide-right|zoom|shake)$/);
    }
  });
});

describe("Studio library helpers", () => {
  it("loads the same library the route serves", () => {
    expect(studioAssetsDir()).toBe(DIR);
    expect(loadStudioAssetManifest().assets.map((a) => a.id)).toEqual(manifest.assets.map((a) => a.id));
    expect(loadStudioAssetPeaks()).toEqual(peaks);
    const rev = studioAssetsRev();
    expect(rev).toMatch(/^[0-9a-f]{12}$/);
    expect(studioAssetsRev()).toBe(rev);
    expect(StudioAssetsResponse.parse({ version: 1, assets: manifest.assets, rev, peaks }).assets.length).toBe(manifest.assets.length);
  });

  it("resolves ids to files and refuses anything else", () => {
    const a = of("sfx")[0]!;
    expect(resolveStudioAsset(a.id)?.path).toBe(path.join(DIR, a.file));
    for (const bad of ["", "nope/missing", "../manifest", "sfx/../../package", "/etc/passwd", a.file, `${a.id}/..`, "manifest.json"]) {
      expect(resolveStudioAsset(bad), bad).toBeNull();
    }
  });

  it("names content types for the files it serves", () => {
    expect(studioAssetContentType("sfx/a/b.m4a")).toBe("audio/mp4");
    expect(studioAssetContentType("elements/x.png")).toBe("image/png");
    expect(studioAssetContentType("x.bin")).toBe("application/octet-stream");
  });

  it("gives the AI a catalog by id and tags, without file paths", () => {
    const all = studioAssetCatalog();
    expect(all.length).toBe(manifest.assets.length);
    for (const c of all) expect(c).not.toHaveProperty("file");
    const audio = studioAssetCatalog(["sfx", "music"]);
    expect(audio.length).toBe(of("sfx").length + of("music").length);
    expect(audio.every((c) => c.kind === "sfx" || c.kind === "music")).toBe(true);
    expect(audio.filter((c) => c.loop).length).toBe(of("music").length);
  });
});
