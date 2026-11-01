import { describe, expect, it } from "vitest";
import { compareEventIds, evidenceClass, FrameBatchAnalysis, mergeEvents, Observation, toProviderJsonSchema } from "@slot1/contracts";
import { loadConfig } from "@slot1/platform";

const base = {
  id: "7f2c6a8e-2d6f-4c0e-9a51-3b1f6f0e2a11", schemaVersion: 1, broadcasterId: "b", sessionId: "s", sourceId: null,
  mediaStartMs: null, mediaEndMs: null, capturedAt: null, receivedAt: "2026-11-01T20:00:00.000Z", analyzedAt: null, publishedAt: null,
  description: "Stream went live", interpretation: "directly_visible", rawText: null, reviewStatus: "unreviewed", relatedEntities: [],
};

describe("observation schema", () => {
  it("rejects Twitch facts that carry a model confidence", () => {
    const fact = { ...base, type: "stream_online", origin: "twitch", evidence: [], model: null, modelConfidence: null };
    expect(Observation.safeParse(fact).success).toBe(true);
    expect(Observation.safeParse({ ...fact, modelConfidence: 0.9 }).success).toBe(false);
    expect(Observation.safeParse({ ...fact, model: { provider: "x", version: "1" } }).success).toBe(false);
  });

  it("rejects gameplay observations without evidence", () => {
    const g = { ...base, type: "vehicle", origin: "video", description: "A car", mediaStartMs: 0, mediaEndMs: 0, model: { provider: "p", version: "v" }, modelConfidence: 0.5 };
    expect(Observation.safeParse({ ...g, evidence: [] }).success).toBe(false);
    expect(Observation.safeParse({ ...g, evidence: [{ assetId: "a", kind: "frame", mediaPtsMs: 0 }] }).success).toBe(true);
    expect(Observation.safeParse({ ...g, evidence: [{ assetId: "a", kind: "frame", mediaPtsMs: 0 }], mediaEndMs: null, mediaStartMs: 5, }).success).toBe(true);
    expect(Observation.safeParse({ ...g, evidence: [{ assetId: "a", kind: "frame", mediaPtsMs: 0 }], mediaStartMs: 9, mediaEndMs: 3 }).success).toBe(false);
  });

  it("classifies evidence for display", () => {
    expect(evidenceClass({ origin: "twitch", interpretation: "directly_visible", type: "stream_online", rawText: null })).toBe("platform");
    expect(evidenceClass({ origin: "ocr", interpretation: "directly_visible", type: "mission_title", rawText: "X" })).toBe("visible_text");
    expect(evidenceClass({ origin: "video", interpretation: "inferred", type: "possible_collision", rawText: null })).toBe("inferred");
  });
});

describe("provider JSON schema", () => {
  it("is strict: no extra properties and every property required", () => {
    const schema = toProviderJsonSchema(FrameBatchAnalysis) as { properties: Record<string, { additionalProperties?: boolean; required?: string[] }>; additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(["findings", "scene"]);
    expect(schema.properties.scene!.additionalProperties).toBe(false);
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"maxLength"|"minimum"|"maximum"|"\$schema"/);
  });
});

describe("event ids", () => {
  it("orders numerically and merges without duplicates", () => {
    expect(compareEventIds("9", "10")).toBeLessThan(0);
    const merged = mergeEvents([{ id: "1" }, { id: "2" }], [{ id: "2" }, { id: "3" }]);
    expect(merged.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });
});

describe("configuration honesty", () => {
  it("reports exactly what is missing for each integration", () => {
    const c = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x@localhost/db", REDIS_URL: "redis://localhost:6379" });
    expect(c.capabilities.twitch.available).toBe(false);
    expect(c.capabilities.twitch.reason).toMatch(/TWITCH_CLIENT_ID/);
    expect(c.capabilities.vision.available).toBe(false);
    expect(c.capabilities.ingest.reason).toMatch(/INGEST_GATEWAY/);
  });

  it("refuses to start in production without secrets", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://x@localhost/db", REDIS_URL: "redis://localhost:6379" })).toThrow();
  });

  it("marks vision available only with a provider and key", () => {
    const c = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x@localhost/db", REDIS_URL: "redis://localhost:6379", VISION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key", ANTHROPIC_VISION_MODEL: "some-model" });
    expect(c.capabilities.vision.available).toBe(true);
    const noKey = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x@localhost/db", REDIS_URL: "redis://localhost:6379", VISION_PROVIDER: "anthropic" });
    expect(noKey.capabilities.vision).toMatchObject({ available: false, reason: "ANTHROPIC_API_KEY is not set" });
    // No default model is invented: the operator must name one.
    const noModel = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x@localhost/db", REDIS_URL: "redis://localhost:6379", VISION_PROVIDER: "openai", OPENAI_API_KEY: "k" });
    expect(noModel.capabilities.vision).toMatchObject({ available: false, reason: "OPENAI_VISION_MODEL is not set" });
  });
});
