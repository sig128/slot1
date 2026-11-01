import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * A stand-in for OBS's built-in WebSocket server (obs-websocket 5, protocol rpcVersion 1), for
 * browser tests only: Hello with a SHA-256 challenge, Identify, and the three requests SLOT1's
 * "Set up OBS automatically" sends. Plain RFC 6455 framing, no dependencies. It is NOT OBS:
 * OBS itself is not exercised by these tests.
 */
export interface ObsStandIn {
  port: number;
  password: string;
  /** What SetStreamServiceSettings stored, as OBS would. */
  settings: { streamServiceType: string; streamServiceSettings: Record<string, unknown> } | null;
  /** Pretend OBS is streaming: SetStreamServiceSettings answers OutputRunning (500). */
  streaming: boolean;
  identified: number;
  authFailures: number;
  requests: string[];
  close(): Promise<void>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sha256b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126 && len < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export async function startObsStandIn(opts: { password: string }): Promise<ObsStandIn> {
  const sockets = new Set<Socket>();
  const state: ObsStandIn = {
    port: 0,
    password: opts.password,
    settings: { streamServiceType: "rtmp_common", streamServiceSettings: { service: "Twitch", server: "auto", key: "previous-key" } },
    streaming: false,
    identified: 0,
    authFailures: 0,
    requests: [],
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const server: Server = createServer((_req, res) => {
    res.writeHead(426);
    res.end("WebSocket only");
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return socket.destroy();
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const send = (msg: unknown) => socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))));
    const close = (code: number, reason: string) => {
      const p = Buffer.alloc(2 + Buffer.byteLength(reason));
      p.writeUInt16BE(code, 0);
      p.write(reason, 2);
      socket.end(frame(0x8, p));
    };

    const salt = randomBytes(32).toString("base64");
    const challenge = randomBytes(32).toString("base64");
    send({ op: 0, d: { obsWebSocketVersion: "5.5.2", rpcVersion: 1, ...(state.password ? { authentication: { challenge, salt } } : {}) } });

    const onMessage = (text: string) => {
      const msg = JSON.parse(text) as { op: number; d: Record<string, any> };
      if (msg.op === 1) {
        const expected = state.password ? sha256b64(sha256b64(state.password + salt) + challenge) : undefined;
        if (expected && msg.d.authentication !== expected) {
          state.authFailures += 1;
          return close(4009, "Authentication failed.");
        }
        state.identified += 1;
        return send({ op: 2, d: { negotiatedRpcVersion: 1 } });
      }
      if (msg.op !== 6) return;
      const { requestType, requestId, requestData } = msg.d as { requestType: string; requestId: string; requestData?: Record<string, any> };
      state.requests.push(requestType);
      const respond = (ok: boolean, responseData?: unknown, code = 100, comment?: string) =>
        send({ op: 7, d: { requestType, requestId, requestStatus: { result: ok, code, ...(comment ? { comment } : {}) }, ...(responseData ? { responseData } : {}) } });
      if (requestType === "GetStreamStatus") return respond(true, { outputActive: state.streaming, outputReconnecting: false, outputTimecode: "00:00:00.000", outputDuration: 0 });
      if (requestType === "SetStreamServiceSettings") {
        if (state.streaming) return respond(false, undefined, 500, "Streaming is active.");
        state.settings = { streamServiceType: requestData!.streamServiceType, streamServiceSettings: requestData!.streamServiceSettings };
        return respond(true);
      }
      if (requestType === "GetStreamServiceSettings") return respond(true, state.settings);
      return respond(false, undefined, 204, "Unknown request type.");
    };

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0]! & 0x0f;
        const masked = (buf[1]! & 0x80) !== 0;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskOff + (i % 4)]!;
        buf = buf.subarray(off + len);
        if (opcode === 0x8) return close(1000, "");
        if (opcode === 0x9) socket.write(frame(0xa, payload));
        else if (opcode === 0x1) onMessage(payload.toString("utf8"));
      }
    });
    socket.on("error", () => socket.destroy());
  });

  // Browsers resolve "localhost" to ::1 or 127.0.0.1: listen on both when IPv6 is available.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EAFNOSUPPORT" && err.code !== "EADDRNOTAVAIL") return reject(err);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.listen(0, "::", () => resolve());
  });
  state.port = (server.address() as AddressInfo).port;
  return state;
}
