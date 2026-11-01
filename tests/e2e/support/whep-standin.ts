import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from "werift";

/**
 * A stand-in for MediaMTX's WHEP endpoint, for browser tests only. ffmpeg encodes a test video
 * to H.264 RTP, werift serves it to browsers over WebRTC. It speaks the same WHEP exchange
 * SLOT1's player uses (OPTIONS, POST offer with a bearer token, 201 + answer + Location,
 * DELETE). It is NOT MediaMTX: MediaMTX itself is not exercised by these tests.
 */
export interface WhepStandIn {
  /** WHEP endpoint, e.g. http://127.0.0.1:41234/live/standin/whep */
  whepUrl: string;
  token: string;
  /** Number of WHEP sessions the server accepted. */
  accepted(): number;
  close(): Promise<void>;
}

export async function startWhepStandIn(opts: { video: string; token?: string }): Promise<WhepStandIn> {
  const token = opts.token ?? "standin-viewer-token";
  const track = new MediaStreamTrack({ kind: "video" });
  const udp: Socket = createSocket("udp4");
  udp.on("message", (msg) => track.writeRtp(msg));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", () => resolve()));
  const rtpPort = (udp.address() as AddressInfo).port;

  // Constrained-baseline H.264 (what OBS WHIP typically sends), a keyframe every second.
  const ffmpeg: ChildProcess = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", opts.video, "-an",
      "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
      "-preset", "ultrafast", "-tune", "zerolatency", "-g", "30", "-bf", "0",
      "-payload_type", "96", "-f", "rtp", `rtp://127.0.0.1:${rtpPort}?pkt_size=1200`,
    ],
    { stdio: "ignore" },
  );

  const peers = new Map<string, RTCPeerConnection>();
  let accepted = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "OPTIONS, POST, DELETE");
      res.setHeader("access-control-expose-headers", "location, link");
      const url = req.url ?? "/";
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "DELETE" && url.startsWith("/whep-session/")) {
        const pc = peers.get(url);
        peers.delete(url);
        await pc?.close();
        res.writeHead(200);
        return res.end();
      }
      if (req.method !== "POST" || url !== "/live/standin/whep") {
        res.writeHead(404);
        return res.end();
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        return res.end();
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const pc = new RTCPeerConnection({
        codecs: {
          video: [
            new RTCRtpCodecParameters({
              mimeType: "video/H264",
              clockRate: 90000,
              rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }],
              parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
            }),
          ],
          audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })],
        },
      });
      await pc.setRemoteDescription({ type: "offer", sdp: Buffer.concat(chunks).toString("utf8") });
      for (const t of pc.getTransceivers()) {
        if (t.kind !== "video") continue;
        t.setDirection("sendonly");
        await t.sender.replaceTrack(track);
      }
      await pc.setLocalDescription(await pc.createAnswer());
      // Non-trickle: wait until werift has gathered its candidates.
      for (let i = 0; i < 50 && pc.iceGatheringState !== "complete"; i++) await new Promise((r) => setTimeout(r, 20));
      accepted += 1;
      const location = `/whep-session/${accepted}`;
      peers.set(location, pc);
      res.writeHead(201, { "content-type": "application/sdp", location });
      res.end(pc.localDescription?.sdp ?? "");
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    whepUrl: `http://127.0.0.1:${port}/live/standin/whep`,
    token,
    accepted: () => accepted,
    async close() {
      ffmpeg.kill("SIGKILL");
      for (const pc of peers.values()) await pc.close().catch(() => undefined);
      udp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
