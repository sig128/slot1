import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "../../apps/web/node_modules/next/server.js";
import { proxy } from "../../apps/web/proxy";

const csp = () => proxy(new NextRequest("http://localhost:3000/watch/someone")).headers.get("content-security-policy") ?? "";
const directive = (name: string) => csp().split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("content security policy", () => {
  afterEach(() => {
    delete process.env.INGEST_PUBLIC_WEBRTC_URL;
    delete process.env.SLOT1_MEDIA_ORIGINS;
  });

  it("lets the share button fetch clip files from the S3 media origin", () => {
    process.env.SLOT1_MEDIA_ORIGINS = "https://media.example.com, not a url";
    expect(directive("connect-src")).toBe("connect-src 'self' https://media.example.com");
  });

  it("only talks to this origin unless SLOT1 live video is configured", () => {
    expect(directive("connect-src")).toBe("connect-src 'self'");
  });

  it("allows exactly the MediaMTX WebRTC origin for live video", () => {
    process.env.INGEST_PUBLIC_WEBRTC_URL = "https://live.example.com/some/path";
    expect(directive("connect-src")).toBe("connect-src 'self' https://live.example.com");
  });

  it("ignores a malformed or non-http WebRTC URL", () => {
    process.env.INGEST_PUBLIC_WEBRTC_URL = "javascript:alert(1)";
    expect(directive("connect-src")).toBe("connect-src 'self'");
  });

  it("keeps frames limited to Twitch's official embeds", () => {
    expect(directive("frame-src")).toBe("frame-src https://player.twitch.tv https://clips.twitch.tv https://www.twitch.tv");
  });
});
