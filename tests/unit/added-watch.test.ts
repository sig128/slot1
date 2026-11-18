import { describe, expect, it } from "vitest";
import { ADDED_WATCH_TRAINED_KEY, addedWatchReason, trainOncePerPicture } from "@slot1/services";

describe("added stream watching", () => {
  it("describes a live picture when the Admin AI key is on", () => {
    expect(addedWatchReason(true, null)).toBe("Watching this stream and learning from it.");
  });

  it("still watches when the describing model is off, and says the Admin AI key is why", () => {
    expect(addedWatchReason(false, "NVIDIA_API_KEY is not set")).toContain("Watching this stream and learning from its picture");
    expect(addedWatchReason(false, "NVIDIA_API_KEY is not set")).toContain("NVIDIA_API_KEY is not set");
    expect(addedWatchReason(false, "NVIDIA_API_KEY is not set")).toContain("Admin → AI");
  });

  it("looks at every check but puts each distinct picture into the training pool once", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
        return "OK" as const;
      },
    } as unknown as Parameters<typeof trainOncePerPicture>[0];
    const offered: number[] = [];
    const pool = async () => void offered.push(offered.length + 1);
    const a = Buffer.from("picture a");
    const b = Buffer.from("picture b");
    const input = {} as Parameters<Parameters<typeof trainOncePerPicture>[3]>[0];
    for (const pic of [a, a, a, b, b, a]) await trainOncePerPicture(redis, "vader", pic, pool)(input);
    expect(offered).toHaveLength(3);
    // Each featured entry keeps its own last picture.
    await trainOncePerPicture(redis, "kick:lazenxd", a, pool)(input);
    expect(offered).toHaveLength(4);
    expect(store.has(ADDED_WATCH_TRAINED_KEY("vader"))).toBe(true);
  });

  it("tries the same picture again when the training pool failed to take it", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
    } as unknown as Parameters<typeof trainOncePerPicture>[0];
    let tries = 0;
    const flaky = async () => {
      tries += 1;
      if (tries === 1) throw new Error("storage down");
    };
    const input = {} as Parameters<Parameters<typeof trainOncePerPicture>[3]>[0];
    const pic = Buffer.from("picture");
    await expect(trainOncePerPicture(redis, "vader", pic, flaky)(input)).rejects.toThrow("storage down");
    await trainOncePerPicture(redis, "vader", pic, flaky)(input);
    await trainOncePerPicture(redis, "vader", pic, flaky)(input);
    expect(tries).toBe(2);
  });
});
