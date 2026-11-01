import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CreateRelayDestinationInput, UpdateRelayDestinationInput } from "@slot1/contracts";
import { createLogger, sanitizeErrorMessage } from "@slot1/platform";
import {
  assertPublicRelayHost,
  isPrivateAddress,
  parseRelayServerUrl,
  RelayDestinationError,
  relayOutputUrl,
  sanitizeRelayText,
  validateStreamKey,
} from "@slot1/services";
import { relayBackoffMs, relayCaFile, relayErrorSummary, relayFfmpegArgs } from "../../apps/worker/src/live/relay";
import { obsAuthString, obsUrl, sha256Fallback } from "../../apps/web/lib/obs";
import { NextRequest } from "../../apps/web/node_modules/next/server.js";
import { proxy } from "../../apps/web/proxy";

describe("forwarding server addresses", () => {
  it("accepts rtmp:// and rtmps:// servers exactly as platforms show them", () => {
    expect(parseRelayServerUrl("rtmps://a.rtmps.youtube.com:443/live2").hostname).toBe("a.rtmps.youtube.com");
    expect(parseRelayServerUrl("  rtmp://live.example.net/app ").protocol).toBe("rtmp:");
    expect(parseRelayServerUrl("rtmps://fa723fc1b171.global-contribute.live-video.net/app/").pathname).toBe("/app/");
  });

  it("rejects anything that isn't a plain RTMP(S) server address", () => {
    for (const bad of [
      "https://a.rtmps.youtube.com/live2",
      "http://example.com/live",
      "ws://localhost:4455",
      "file:///etc/passwd",
      "srt://example.com:9000",
      "rtmp://user:secret@example.com/live",
      "rtmp://example.com/live#frag",
      "rtmp://exa mple.com/live",
      "not a url",
      "rtmp:///live",
    ]) {
      expect(() => parseRelayServerUrl(bad), bad).toThrow(RelayDestinationError);
    }
  });

  it("validates stream keys without echoing them", () => {
    expect(validateStreamKey("  abcd-efgh-ijkl-mnop ")).toBe("abcd-efgh-ijkl-mnop");
    for (const bad of ["abc", "has space", "line\nbreak", "x".repeat(301)]) {
      try {
        validateStreamKey(bad);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(RelayDestinationError);
        expect((err as Error).message).not.toContain(bad);
      }
    }
  });

  it("joins server and key the way OBS does", () => {
    expect(relayOutputUrl("rtmps://a.rtmps.youtube.com:443/live2", "k-1")).toBe("rtmps://a.rtmps.youtube.com:443/live2/k-1");
    expect(relayOutputUrl("rtmps://x.live-video.net/app/", "sk_us")).toBe("rtmps://x.live-video.net/app/sk_us");
  });

  it("keeps the create and update inputs strict", () => {
    expect(CreateRelayDestinationInput.safeParse({ platform: "twitch" }).success).toBe(true);
    expect(CreateRelayDestinationInput.safeParse({ platform: "twitch", streamKey: "pasted" }).success).toBe(false);
    expect(CreateRelayDestinationInput.safeParse({ platform: "kick", streamKey: "sk_live_1234" }).success).toBe(false);
    expect(CreateRelayDestinationInput.safeParse({ platform: "custom", streamKey: "abcd", serverUrl: "rtmp://x.example/live" }).success).toBe(false);
    expect(CreateRelayDestinationInput.safeParse({ platform: "youtube", streamKey: "abcd-efgh" }).success).toBe(true);
    expect(UpdateRelayDestinationInput.safeParse({ enabled: true, platform: "custom" }).success).toBe(false);
  });
});

describe("forwarding only to the public internet", () => {
  it("classifies private, loopback, link-local, CGNAT, multicast and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.0.8", "198.18.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "142.250.74.14", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  it("refuses private and local servers unless a deployment allows them", async () => {
    for (const raw of ["rtmp://127.0.0.1:1935/live", "rtmp://[::1]/live", "rtmp://169.254.169.254/latest", "rtmp://localhost/live", "rtmp://nas.local/live", "rtmp://db.internal/live", "rtmp://10.0.0.5/live"]) {
      await expect(assertPublicRelayHost(parseRelayServerUrl(raw), false), raw).rejects.toThrow("Forwarding only goes to public streaming servers");
    }
    await expect(assertPublicRelayHost(parseRelayServerUrl("rtmp://8.8.8.8/live"), false)).resolves.toBeUndefined();
    await expect(assertPublicRelayHost(parseRelayServerUrl("rtmp://127.0.0.1/live"), true)).resolves.toBeUndefined();
  });
});

describe("keys never reach logs or status text", () => {
  const key = "live_123456789_AbCdEfGhIjKlMnOp";

  it("removes keys and key-carrying URLs from ffmpeg output", () => {
    const line = `[rtmp @ 0x55] Server error: rtmps://ingest.global-contribute.live-video.net/app/${key}: I/O error (key=${key})`;
    const out = sanitizeRelayText(line, [key]);
    expect(out).not.toContain(key);
    expect(out).toContain("ingest.global-contribute.live-video.net");
    // Even without knowing the secret, a streaming URL keeps only its host.
    const unknown = sanitizeRelayText("Connection to rtmp://user:pw@live.example.net/app/SECRETKEY123 failed", []);
    expect(unknown).not.toMatch(/SECRETKEY123|pw@/);
    expect(unknown).toContain("live.example.net");
  });

  it("strips streaming URL paths from every sanitized error message", () => {
    const msg = sanitizeErrorMessage("Input/output error opening rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh-ijkl-mnop and srt://h.example:9000?streamid=publish:live:x:SECRET");
    expect(msg).not.toMatch(/abcd-efgh|SECRET/);
    expect(msg).toContain("rtmps://a.rtmps.youtube.com:443/[redacted]");
  });

  it("redacts stream keys and encrypted keys in structured logs", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger("relay-test", "info", sink);
    log.warn({ destination: { streamKey: key, keyEnc: "v1.k.cipher", outputUrl: `rtmps://x/app/${key}` }, creds: { stream_key: key, key_enc: "v1.k.c2", publishUrl: `rtmp://h/live/n?key=${key}` } }, "relay");
    expect(lines.join("")).not.toContain(key);
    expect(lines.join("")).not.toContain("v1.k.");
    expect(lines.join("")).toContain("[redacted]");
  });
});

describe("relay process", () => {
  it("copies audio and video unchanged and writes FLV to the destination", () => {
    const args = relayFfmpegArgs("rtmp://gw/live/abc?reader=pw", "rtmps://dest/app/key");
    expect(args.join(" ")).toContain("-c copy");
    expect(args).not.toContain("libx264");
    expect(args.slice(-3)).toEqual(["-f", "flv", "rtmps://dest/app/key"]);
    expect(args).toContain("-rw_timeout");
    expect(args.join(" ")).toContain("-progress pipe:1");
  });

  it("verifies RTMPS servers' certificates, which ffmpeg skips by default", () => {
    const secure = relayFfmpegArgs("rtmp://gw/live/abc?reader=pw", "rtmps://a.rtmps.youtube.com:443/live2/k", "/etc/ssl/certs/ca-certificates.crt");
    expect(secure.slice(-7)).toEqual(["-tls_verify", "1", "-ca_file", "/etc/ssl/certs/ca-certificates.crt", "-f", "flv", "rtmps://a.rtmps.youtube.com:443/live2/k"]);
    expect(relayFfmpegArgs("r", "rtmps://x/app/k").slice(-5)).toEqual(["-tls_verify", "1", "-f", "flv", "rtmps://x/app/k"]);
    expect(relayFfmpegArgs("r", "rtmp://x/app/k", "/ca.pem")).not.toContain("-tls_verify");
    expect(relayCaFile("/custom/ca.pem", () => false)).toBe("/custom/ca.pem");
    expect(relayCaFile(null, (p) => p === "/etc/pki/tls/certs/ca-bundle.crt")).toBe("/etc/pki/tls/certs/ca-bundle.crt");
    expect(relayCaFile(undefined, () => false)).toBeNull();
  });

  it("turns ffmpeg's last words into a short reason", () => {
    // Real ffmpeg 7 output for a refused connection, after key redaction.
    const refused = [
      "[out#0/flv @ 0x55f8f7803380] Error opening output rtmp://127.0.0.1:1/[redacted]: Connection refused",
      "Error opening output file rtmp://127.0.0.1:1/[redacted]",
      "Error opening output files: Connection refused",
    ];
    expect(relayErrorSummary(refused)).toBe("Connection refused");
    expect(relayErrorSummary(["[flv @ 0x1] av_interleaved_write_frame(): Broken pipe", "Conversion failed!"])).toBe("Broken pipe");
    expect(relayErrorSummary(["rtmp://gw/[redacted]: Input/output error"])).toBe("Input/output error");
    expect(relayErrorSummary(["Something odd happened"])).toBe("Something odd happened");
    // Real ffmpeg 6.1 (GnuTLS) output for an RTMPS server whose certificate isn't trusted.
    const untrusted = [
      "[tls @ 0x562139344540] Peer certificate failed verification",
      "[rtmps @ 0x5621392ff540] Cannot open connection tls://localhost:46049",
      "Error opening output files: Input/output error",
    ];
    expect(relayErrorSummary(untrusted)).toBe("The server's TLS certificate couldn't be verified");
    expect(relayErrorSummary(["", "  "])).toBeNull();
  });

  it("backs off 2 s, 4 s, 8 s … up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(relayBackoffMs)).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(relayBackoffMs(0)).toBe(2000);
  });
});

describe("OBS WebSocket v5 handshake", () => {
  const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest();

  it("computes OBS's authentication string exactly as the protocol defines it", async () => {
    const password = "supersecretpassword";
    const salt = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=";
    const challenge = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=";
    const secret = nodeSha(password + salt).toString("base64");
    const expected = nodeSha(secret + challenge).toString("base64");
    expect(await obsAuthString(password, salt, challenge)).toBe(expected);
  });

  it("has a SHA-256 fallback that matches Node's for pages without WebCrypto", () => {
    for (const s of ["", "abc", "a".repeat(55), "b".repeat(56), "c".repeat(64), "d".repeat(119), "ünïcødé 🔑", "x".repeat(1000)]) {
      const bytes = new TextEncoder().encode(s);
      expect(Buffer.from(sha256Fallback(bytes)).toString("hex"), `length ${s.length}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("lets only Studio pages open a WebSocket to OBS on localhost", () => {
    const connectSrc = (url: string) =>
      (proxy(new NextRequest(url)).headers.get("content-security-policy") ?? "").split("; ").find((d) => d.startsWith("connect-src ")) ?? "";
    expect(connectSrc("http://localhost:3000/studio")).toBe("connect-src 'self' ws://localhost:*");
    expect(connectSrc("http://localhost:3000/studio?tab=stream")).toBe("connect-src 'self' ws://localhost:*");
    expect(connectSrc("http://localhost:3000/watch/someone")).toBe("connect-src 'self'");
    expect(connectSrc("http://localhost:3000/")).toBe("connect-src 'self'");
  });

  it("only ever connects to OBS on this computer", () => {
    expect(obsUrl(4455)).toBe("ws://localhost:4455");
    expect(() => obsUrl(0)).toThrow();
    expect(() => obsUrl(70000)).toThrow();
    expect(() => obsUrl(Number.NaN)).toThrow();
  });
});
