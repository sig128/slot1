import { describe, expect, it } from "vitest";
import { addedWatchReason } from "@slot1/services";

describe("added stream watching", () => {
  it("describes a live picture when the Admin AI key is on", () => {
    expect(addedWatchReason(true, null)).toBe("Watching this stream and learning from it.");
  });

  it("still watches when the describing model is off, and says the Admin AI key is why", () => {
    expect(addedWatchReason(false, "NVIDIA_API_KEY is not set")).toContain("Watching this stream and learning from its picture");
    expect(addedWatchReason(false, "NVIDIA_API_KEY is not set")).toContain("NVIDIA_API_KEY is not set");
    expect(addedWatchReason(false, "NVIDIA_API_KEY is not set")).toContain("Admin → AI");
  });
});
