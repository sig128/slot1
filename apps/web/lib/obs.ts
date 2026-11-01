/**
 * A minimal OBS WebSocket v5 client for "Set up OBS automatically". It runs only in the creator's
 * browser and talks to OBS on their own computer (OBS 28+ has the WebSocket server built in).
 * The OBS password is used for the handshake and never stored or sent anywhere else.
 *
 * Protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */

export type ObsErrorKind = "unreachable" | "password_required" | "auth_failed" | "timeout" | "too_old" | "streaming" | "request_failed" | "protocol";

export class ObsError extends Error {
  constructor(
    readonly kind: ObsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ObsError";
  }
}

const OP = { Hello: 0, Identify: 1, Identified: 2, Request: 6, RequestResponse: 7 } as const;
/** obs-websocket close codes we explain to the creator. */
const CLOSE_AUTH_FAILED = 4009;
const CLOSE_UNSUPPORTED_RPC = 4010;
/** RequestStatus::OutputRunning: OBS refuses to change the stream service while streaming. */
const STATUS_OUTPUT_RUNNING = 500;

export const OBS_DEFAULT_PORT = 4455;

export function obsUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ObsError("unreachable", "The port must be a number between 1 and 65535 (OBS uses 4455 unless you changed it)");
  return `ws://localhost:${port}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Authentication: base64(sha256(base64(sha256(password + salt)) + challenge))                */
/* ------------------------------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/**
 * Plain SHA-256 for pages without WebCrypto (crypto.subtle only exists on https and localhost,
 * so a dev server opened by LAN address over http still works).
 */
export function sha256Fallback(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const total = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = data.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(total - 4, bits >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + k;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle ? new Uint8Array(await subtle.digest("SHA-256", bytes)) : sha256Fallback(bytes);
  let s = "";
  for (const byte of digest) s += String.fromCharCode(byte);
  return btoa(s);
}

/** The `authentication` string OBS expects in Identify, from the salt and challenge in Hello. */
export async function obsAuthString(password: string, salt: string, challenge: string): Promise<string> {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

/* ------------------------------------------------------------------------------------------ */
/* Connection                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface ObsConnection {
  /** e.g. "5.5.2", from OBS's Hello message. */
  readonly obsWebSocketVersion: string | null;
  request<T = Record<string, unknown>>(requestType: string, requestData?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export interface ObsConnectOptions {
  url: string;
  /** Empty when the creator turned off authentication in OBS. */
  password: string;
  timeoutMs?: number;
  /** For tests. */
  WebSocketImpl?: typeof WebSocket;
}

const UNREACHABLE =
  "Couldn't reach OBS. Check that OBS is open, that Tools → WebSocket Server Settings → Enable WebSocket server is ticked, and that the port matches. " +
  "If your browser asked to let this site connect to apps on this device, choose Allow.";

interface ObsMessage {
  op: number;
  d?: {
    obsWebSocketVersion?: string;
    rpcVersion?: number;
    authentication?: { challenge?: string; salt?: string };
    requestId?: string;
    requestStatus?: { result?: boolean; code?: number; comment?: string };
    responseData?: Record<string, unknown>;
  };
}

/** Connect and identify. Resolves once OBS accepts us; rejects with a creator-readable ObsError. */
export function connectObs({ url, password, timeoutMs = 7000, WebSocketImpl = globalThis.WebSocket }: ObsConnectOptions): Promise<ObsConnection> {
  return new Promise((resolve, reject) => {
    if (!WebSocketImpl) return reject(new ObsError("unreachable", "This browser can't open a connection to OBS. Copy the Server and Key by hand instead"));
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      return reject(new ObsError("unreachable", UNREACHABLE));
    }
    let settled = false;
    let seq = 0;
    let version: string | null = null;
    const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: ObsError) => void; timer: ReturnType<typeof setTimeout> }>();

    const fail = (err: ObsError) => {
      clearTimeout(handshakeTimer);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
      if (!settled) {
        settled = true;
        reject(err);
      }
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const handshakeTimer = setTimeout(
      () => fail(new ObsError("timeout", "OBS didn't answer. Check the port, and that you use OBS 28 or newer (older versions need the obs-websocket 5 plugin)")),
      timeoutMs,
    );

    const conn: ObsConnection = {
      get obsWebSocketVersion() {
        return version;
      },
      request<T>(requestType: string, requestData?: Record<string, unknown>) {
        return new Promise<T>((res, rej) => {
          if (ws.readyState !== 1) return rej(new ObsError("unreachable", "The connection to OBS closed. Try again"));
          const requestId = `slot1-${++seq}`;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            rej(new ObsError("timeout", "OBS didn't answer in time. Try again"));
          }, timeoutMs);
          pending.set(requestId, { resolve: res as unknown as (v: Record<string, unknown>) => void, reject: rej, timer });
          ws.send(JSON.stringify({ op: OP.Request, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }));
        });
      },
      close() {
        settled = true;
        fail(new ObsError("unreachable", "Closed"));
      },
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: ObsMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ObsMessage;
      } catch {
        return fail(new ObsError("protocol", "OBS sent something SLOT1 doesn't understand. Update OBS to version 28 or newer"));
      }
      if (msg.op === OP.Hello) {
        version = msg.d?.obsWebSocketVersion ?? null;
        const auth = msg.d?.authentication;
        void (async () => {
          const d: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
          if (auth) {
            if (!password) return fail(new ObsError("password_required", "OBS asks for its WebSocket password. In OBS, open Tools → WebSocket Server Settings → Show Connect Info and copy the Server Password"));
            d.authentication = await obsAuthString(password, auth.salt ?? "", auth.challenge ?? "");
          }
          ws.send(JSON.stringify({ op: OP.Identify, d }));
        })().catch(() => fail(new ObsError("protocol", "Couldn't answer OBS's password check in this browser")));
      } else if (msg.op === OP.Identified) {
        clearTimeout(handshakeTimer);
        settled = true;
        resolve(conn);
      } else if (msg.op === OP.RequestResponse) {
        const id = msg.d?.requestId;
        const p = id ? pending.get(id) : undefined;
        if (!p || !id) return;
        pending.delete(id);
        clearTimeout(p.timer);
        const st = msg.d?.requestStatus;
        if (st?.result) p.resolve(msg.d?.responseData ?? {});
        else if (st?.code === STATUS_OUTPUT_RUNNING) p.reject(new ObsError("streaming", "OBS is streaming right now. Click Stop Streaming in OBS, then try again"));
        else p.reject(new ObsError("request_failed", `OBS refused the change${st?.comment ? `: ${st.comment}` : ""}`));
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (ev.code === CLOSE_AUTH_FAILED) return fail(new ObsError("auth_failed", "OBS rejected the password. Copy it again from Tools → WebSocket Server Settings → Show Connect Info"));
      if (ev.code === CLOSE_UNSUPPORTED_RPC) return fail(new ObsError("too_old", "This OBS is too old for automatic setup. Update to OBS 28 or newer, or copy the Server and Key by hand"));
      fail(new ObsError("unreachable", settled ? "The connection to OBS closed. Try again" : UNREACHABLE));
    };
  });
}

/**
 * Point OBS's Stream settings at a custom RTMP server and read them back to confirm. Refuses while
 * OBS is streaming, because OBS only applies new stream settings when a stream starts.
 */
export async function setObsStreamTarget(conn: ObsConnection, server: string, key: string): Promise<void> {
  await conn.request("SetStreamServiceSettings", { streamServiceType: "rtmp_custom", streamServiceSettings: { server, key, use_auth: false } });
  const check = await conn.request<{ streamServiceType?: string; streamServiceSettings?: { server?: string } }>("GetStreamServiceSettings");
  if (check.streamServiceType !== "rtmp_custom" || check.streamServiceSettings?.server !== server) {
    throw new ObsError("request_failed", "OBS didn't keep the new settings. Copy the Server and Key by hand instead");
  }
}

export async function obsIsStreaming(conn: ObsConnection): Promise<boolean> {
  const st = await conn.request<{ outputActive?: boolean }>("GetStreamStatus");
  return Boolean(st.outputActive);
}
