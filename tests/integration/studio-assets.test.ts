import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StudioAssetsResponse, type StudioAsset } from "@slot1/contracts";
import { Browser, startHarness, type Harness } from "./harness";

/**
 * The Studio library routes against the real API: creators only, the manifest with its revision
 * and preview peaks, files with long-lived caching and byte ranges, and nothing outside the
 * library reachable however the path is spelled.
 */

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/analysis/studio-assets");

let h: Harness;
let creator: Browser;
let lib: StudioAssetsResponse;
let sfx: StudioAsset;
let sticker: StudioAsset;

beforeAll(async () => {
  h = await startHarness();
  creator = new Browser(h);
  await creator.signInLocal("Library creator");
  const res = await creator.get("/api/studio/assets");
  expect(res.status, res.body).toBe(200);
  lib = StudioAssetsResponse.parse(res.json());
  sfx = lib.assets.find((a) => a.kind === "sfx")!;
  sticker = lib.assets.find((a) => a.kind === "sticker")!;
});

afterAll(async () => {
  await h?.close();
});

describe("studio library routes", () => {
  it("requires a signed-in creator", async () => {
    const anon = new Browser(h);
    expect((await anon.get("/api/studio/assets")).status).toBe(401);
    expect((await anon.get(`/api/studio/assets/file/${sfx.id}`)).status).toBe(401);
    expect((await anon.get(`/api/studio/assets/file/${sfx.id}?v=${lib.rev}`)).status).toBe(401);
  });

  it("serves the manifest with its revision and preview peaks, cacheable", async () => {
    expect(lib.version).toBe(1);
    expect(lib.rev).toMatch(/^[0-9a-f]{12}$/);
    expect(lib.assets.length).toBeGreaterThanOrEqual(200);
    for (const a of lib.assets.filter((x) => x.kind === "sfx" || x.kind === "music" || x.kind === "ambience")) expect(lib.peaks[a.id]?.length, a.id).toBe(48);

    const res = await creator.get("/api/studio/assets");
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(res.headers.etag).toBe(`"lib-${lib.rev}"`);
    const again = await creator.request("GET", "/api/studio/assets", { headers: { "if-none-match": `"lib-${lib.rev}"` } });
    expect(again.status).toBe(304);
    expect(again.body).toBe("");
  });

  it("serves a file by id, cached for good when the revision matches", async () => {
    const bytes = readFileSync(path.join(DIR, sfx.file));
    const res = await creator.get(`/api/studio/assets/file/${sfx.id}?v=${lib.rev}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Number(res.headers["content-length"])).toBe(bytes.length);
    expect(res.raw.equals(bytes)).toBe(true);

    // Without the current revision the browser may keep it for an hour, not forever.
    const loose = await creator.get(`/api/studio/assets/file/${sfx.id}`);
    expect(loose.status).toBe(200);
    expect(loose.headers["cache-control"]).toBe("private, max-age=3600");
    const stale = await creator.get(`/api/studio/assets/file/${sfx.id}?v=000000000000`);
    expect(stale.headers["cache-control"]).toBe("private, max-age=3600");

    const png = await creator.get(`/api/studio/assets/file/${sticker.id}?v=${lib.rev}`);
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.raw.equals(readFileSync(path.join(DIR, sticker.file)))).toBe(true);
  });

  it("also answers to the manifest's file path", async () => {
    const res = await creator.get(`/api/studio/assets/file/${sfx.file}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    expect(res.raw.equals(readFileSync(path.join(DIR, sfx.file)))).toBe(true);
  });

  it("answers byte ranges so audio can seek", async () => {
    const file = path.join(DIR, sfx.file);
    const bytes = readFileSync(file);
    const size = statSync(file).size;

    const first = await creator.request("GET", `/api/studio/assets/file/${sfx.id}?v=${lib.rev}`, { headers: { range: "bytes=0-99" } });
    expect(first.status).toBe(206);
    expect(first.headers["content-range"]).toBe(`bytes 0-99/${size}`);
    expect(first.headers["content-length"]).toBe("100");
    expect(first.raw.equals(bytes.subarray(0, 100))).toBe(true);

    const tail = await creator.request("GET", `/api/studio/assets/file/${sfx.id}`, { headers: { range: "bytes=-50" } });
    expect(tail.status).toBe(206);
    expect(tail.headers["content-range"]).toBe(`bytes ${size - 50}-${size - 1}/${size}`);
    expect(tail.raw.equals(bytes.subarray(size - 50))).toBe(true);

    const open = await creator.request("GET", `/api/studio/assets/file/${sfx.id}`, { headers: { range: `bytes=${size - 10}-` } });
    expect(open.status).toBe(206);
    expect(open.raw.length).toBe(10);

    const past = await creator.request("GET", `/api/studio/assets/file/${sfx.id}`, { headers: { range: `bytes=${size}-${size + 10}` } });
    expect(past.status).toBe(416);
    expect(past.headers["content-range"]).toBe(`bytes */${size}`);
  });

  it("refuses unknown items and anything outside the library", async () => {
    const manifestJson = readFileSync(path.join(DIR, "manifest.json"), "utf8").slice(0, 40);
    const attempts = [
      "sfx/nope/missing",
      "SFX/CASH/NOPE",
      "sfx",
      "manifest.json",
      "waveforms.json",
      "sfx/../manifest.json",
      "../manifest.json",
      "..%2Fmanifest.json",
      "%2e%2e/%2e%2e/package.json",
      "sfx/%2e%2e/%2e%2e/%2e%2e/package.json",
      "..%5c..%5cpackage.json",
      "%2Fetc%2Fpasswd",
      "/etc/passwd",
      `${sfx.id}%00.png`,
      `${sfx.file}/..`,
      `${sfx.id}.m4a.bak`,
      "elements/../../../../package.json",
    ];
    for (const p of attempts) {
      const res = await creator.get(`/api/studio/assets/file/${p}`);
      expect(res.status, p).toBe(404);
      expect(res.body, p).not.toContain(manifestJson);
      expect(res.body, p).not.toMatch(/"packageManager"|root:x:0:0/);
    }
  });
});
