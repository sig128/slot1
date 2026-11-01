import { describe, expect, it } from "vitest";
import { chatEmbedUrl, clipEmbedUrl, liveEmbedUrl, parseTwitchUrl } from "@slot1/twitch";

describe("parseTwitchUrl", () => {
  it.each([
    ["https://www.twitch.tv/SomeStreamer", { kind: "channel", login: "somestreamer" }],
    ["twitch.tv/some_streamer", { kind: "channel", login: "some_streamer" }],
    ["https://m.twitch.tv/somestreamer/videos", { kind: "channel", login: "somestreamer" }],
    ["somestreamer", { kind: "channel", login: "somestreamer" }],
    ["https://clips.twitch.tv/FunnyClipSlug-abc123", { kind: "clip", slug: "FunnyClipSlug-abc123", login: null }],
    ["https://www.twitch.tv/somestreamer/clip/FunnyClipSlug-abc123", { kind: "clip", slug: "FunnyClipSlug-abc123", login: "somestreamer" }],
    ["https://www.twitch.tv/videos/123456789", { kind: "video", videoId: "123456789" }],
  ])("parses %s", (input, expected) => {
    expect(parseTwitchUrl(input)).toEqual(expected);
  });

  it.each([
    "https://twitch.tv.evil.example/somestreamer",
    "https://evil.example/twitch.tv/somestreamer",
    "https://user:pass@twitch.tv/somestreamer",
    "https://twitch.tv:8443/somestreamer",
    "javascript:alert(1)",
    "ftp://twitch.tv/somestreamer",
    "https://www.twitch.tv/directory",
    "https://www.twitch.tv/settings/profile",
    "https://www.twitch.tv/a",
    "https://clips.twitch.tv/",
    "https://www.twitch.tv/somestreamer/clip/../../x",
    "",
    "x".repeat(400),
  ])("rejects %s", (input) => {
    expect(parseTwitchUrl(input)).toBeNull();
  });
});

describe("embed URLs", () => {
  it("adds every parent host and encodes values", () => {
    const u = new URL(liveEmbedUrl("somestreamer", ["slot1.example", "localhost"]));
    expect(u.origin).toBe("https://player.twitch.tv");
    expect(u.searchParams.get("channel")).toBe("somestreamer");
    expect(u.searchParams.getAll("parent")).toEqual(["slot1.example", "localhost"]);
    expect(new URL(clipEmbedUrl("Slug-1", ["slot1.example"])).searchParams.get("clip")).toBe("Slug-1");
    expect(new URL(chatEmbedUrl("somestreamer", ["slot1.example"])).pathname).toBe("/embed/somestreamer/chat");
  });
});
