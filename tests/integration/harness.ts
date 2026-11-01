import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../apps/api/src/app";
import { EventHub } from "../../apps/api/src/lib/hub";
import { createPool } from "@slot1/db";
import { createRedis, loadConfig } from "@slot1/platform";
import { buildServerContext, type Enqueue, type ServerContext } from "@slot1/services";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./env";

export const ORIGIN = "http://localhost:3000";
export const EVENTSUB_SECRET = "integration-eventsub-secret-0123456789";

export interface QueuedJob {
  queue: string;
  name: string;
  data: unknown;
}

export interface Harness {
  ctx: ServerContext;
  app: Awaited<ReturnType<typeof buildApp>>;
  jobs: QueuedJob[];
  storageRoot: string;
  close(): Promise<void>;
}

/**
 * The real API (same Fastify app, routes, hooks and SQL) in-process against the test database.
 * Queued jobs are captured instead of sent to BullMQ so a test can run the worker handler it
 * wants, deterministically.
 */
export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "slot1-it-"));
  const env: Record<string, string> = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    SLOT1_PUBLIC_ORIGIN: ORIGIN,
    SLOT1_SESSION_SECRET: randomBytes(32).toString("base64url"),
    SLOT1_TOKEN_ENCRYPTION_KEYS: `it1:${randomBytes(32).toString("base64")}`,
    SLOT1_ALLOW_LOCAL_LOGIN: "true",
    STORAGE_DRIVER: "fs",
    STORAGE_FS_ROOT: path.join(storageRoot, "storage"),
    UPLOAD_TMP_DIR: path.join(storageRoot, "uploads"),
    INGEST_SEGMENT_DIR: path.join(storageRoot, "ingest"),
    VISION_PROVIDER: "none",
    OCR_ENABLED: "auto",
    TWITCH_EMBED_PARENTS: "localhost",
    ...extraEnv,
  };
  const config = loadConfig(env);
  const db = createPool(env.DATABASE_URL!, 6);
  const redis = createRedis(env.REDIS_URL!);
  const jobs: QueuedJob[] = [];
  const enqueue: Enqueue = async (queue, name, data) => {
    jobs.push({ queue, name, data });
  };
  const ctx = buildServerContext({ config, db, redis, enqueue, service: "slot1-test" });
  const hub = new EventHub(createRedis(env.REDIS_URL!));
  const app = await buildApp({ ctx, hub });
  await app.ready();
  return {
    ctx,
    app,
    jobs,
    storageRoot,
    async close() {
      await app.close();
      await hub.close();
      await redis.quit();
      await db.end();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Undecoded bytes (zip downloads and other binary responses). */
  raw: Buffer;
  json<T = any>(): T;
}

/** One browser: its own cookie jar and CSRF token, talking to the in-process API. */
export class Browser {
  cookie = "";
  csrf: string | null = null;
  constructor(private readonly h: Harness) {}

  async request(method: string, url: string, opts: { json?: unknown; body?: Buffer | string; headers?: Record<string, string>; csrf?: boolean } = {}): Promise<Res> {
    const headers: Record<string, string> = { origin: ORIGIN, ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== "GET" && opts.csrf !== false && this.csrf) headers["x-slot1-csrf"] = this.csrf;
    let payload: string | Buffer | undefined = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(opts.json);
    }
    const res = await this.h.app.inject({ method: method as "GET", url, headers, payload });
    const set = res.headers["set-cookie"];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const kv = c.split(";")[0]!;
      if (kv.startsWith("slot1_session=")) this.cookie = kv.endsWith("=") ? "" : kv;
    }
    return { status: res.statusCode, headers: res.headers as Res["headers"], body: res.body, raw: res.rawPayload, json: () => JSON.parse(res.body) };
  }

  get(url: string) {
    return this.request("GET", url);
  }

  async refreshCsrf() {
    const me = (await this.get("/api/me")).json<{ csrfToken: string; user: unknown; broadcaster: unknown }>();
    this.csrf = me.csrfToken;
    return me;
  }

  async signInLocal(displayName: string) {
    await this.refreshCsrf();
    const r = await this.request("POST", "/api/auth/local", { json: { displayName } });
    if (r.status !== 200) throw new Error(`local sign-in failed: ${r.status} ${r.body}`);
    return this.refreshCsrf();
  }
}

/** Build a multipart/form-data body (fields first, then the file) without extra dependencies. */
export async function multipart(fields: Record<string, string>, file: { field: string; filename: string; path: string; type: string }) {
  const boundary = `----slot1test${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(await readFile(file.path));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/* ------------------------------------------------------------------------------------------ */
/* Mock Twitch: just enough of id.twitch.tv and Helix to exercise SLOT1's real client code.     */
/* ------------------------------------------------------------------------------------------ */

export interface MockUser {
  id: string;
  login: string;
  displayName: string;
  scopes: string[];
}

export class MockTwitch {
  server: Server;
  base = "";
  users = new Map<string, MockUser>();
  /** access token → user id */
  tokens = new Map<string, string>();
  /** refresh token → user id */
  refreshTokens = new Map<string, string>();
  codes = new Map<string, string>();
  invalidAccess = new Set<string>();
  revokedRefresh = new Set<string>();
  revoked: string[] = [];
  clips = new Map<string, { id: string; broadcasterId: string; url: string }>();
  chat: { broadcasterId: string; senderId: string; message: string }[] = [];
  /** When true, Create Clip answers 403 like a channel with clipping disabled. */
  clipsDisabled = false;
  /** broadcaster id → stream key served by Get Stream Key (needs channel:read:stream_key). */
  streamKeys = new Map<string, string>();
  /** When true, Get Stream Key answers 503 like a Twitch outage. */
  streamKeyOutage = false;
  requests: string[] = [];
  /** Answers the next token requests with these errors, the way Twitch words them. */
  tokenFailures: { status: number; message: string }[] = [];
  private n = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  env(): Record<string, string> {
    return {
      TWITCH_CLIENT_ID: "mock-client-id",
      TWITCH_CLIENT_SECRET: "mock-client-secret",
      TWITCH_REDIRECT_URI: `${ORIGIN}/api/auth/twitch/callback`,
      TWITCH_EVENTSUB_CALLBACK_URL: "https://slot1.example/api/twitch/eventsub",
      TWITCH_EVENTSUB_SECRET: EVENTSUB_SECRET,
      TWITCH_ID_BASE: `${this.base}/oauth2`,
      TWITCH_API_BASE: `${this.base}/helix`,
    };
  }

  addUser(u: MockUser) {
    this.users.set(u.id, u);
    return u;
  }

  /** What Twitch would do after the user approves: issue a one-time code for this user. */
  issueCode(userId: string) {
    const code = `code-${++this.n}`;
    this.codes.set(code, userId);
    return code;
  }

  private issueTokens(userId: string) {
    const access = `access-${userId}-${++this.n}`;
    const refresh = `refresh-${userId}-${this.n}`;
    this.tokens.set(access, userId);
    this.refreshTokens.set(refresh, userId);
    return { access_token: access, refresh_token: refresh, expires_in: 14_400, scope: this.users.get(userId)?.scopes ?? [], token_type: "bearer" };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    this.requests.push(`${req.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const bearer = (req.headers.authorization ?? "").replace(/^(Bearer|OAuth) /, "");
    const tokenUser = this.tokens.get(bearer);

    if (url.pathname === "/oauth2/token" && req.method === "POST") {
      const f = new URLSearchParams(raw);
      const forced = this.tokenFailures.shift();
      if (forced) return send(forced.status, { status: forced.status, message: forced.message });
      if (f.get("client_id") !== "mock-client-id" || f.get("client_secret") !== "mock-client-secret") return send(403, { status: 403, message: "invalid client" });
      if (f.get("grant_type") === "authorization_code") {
        const uid = this.codes.get(f.get("code") ?? "");
        if (!uid || f.get("redirect_uri") !== `${ORIGIN}/api/auth/twitch/callback`) return send(400, { status: 400, message: "Invalid authorization code" });
        this.codes.delete(f.get("code")!);
        return send(200, this.issueTokens(uid));
      }
      if (f.get("grant_type") === "refresh_token") {
        const rt = f.get("refresh_token") ?? "";
        const uid = this.refreshTokens.get(rt);
        if (!uid || this.revokedRefresh.has(rt)) return send(400, { status: 400, message: "Invalid refresh token" });
        return send(200, this.issueTokens(uid));
      }
      if (f.get("grant_type") === "client_credentials") {
        const access = `app-${++this.n}`;
        this.tokens.set(access, "app");
        return send(200, { access_token: access, expires_in: 5_000_000, token_type: "bearer" });
      }
      return send(400, { status: 400, message: "unsupported grant" });
    }
    if (url.pathname === "/oauth2/validate") {
      if (!tokenUser || this.invalidAccess.has(bearer)) return send(401, { status: 401, message: "invalid access token" });
      if (tokenUser === "app") return send(200, { client_id: "mock-client-id", scopes: [], expires_in: 5_000_000 });
      const u = this.users.get(tokenUser)!;
      return send(200, { client_id: "mock-client-id", login: u.login, user_id: u.id, scopes: u.scopes, expires_in: 14_000 });
    }
    if (url.pathname === "/oauth2/revoke") {
      const t = new URLSearchParams(raw).get("token") ?? "";
      this.revoked.push(t);
      this.invalidAccess.add(t);
      this.revokedRefresh.add(t);
      return send(200, {});
    }

    // Helix requires a valid token and the client id on every call.
    if (!url.pathname.startsWith("/helix/")) return send(404, { message: "not found" });
    if (!tokenUser || this.invalidAccess.has(bearer)) return send(401, { status: 401, message: "Invalid OAuth token" });
    if (req.headers["client-id"] !== "mock-client-id") return send(401, { status: 401, message: "Client ID and OAuth token do not match" });
    const p = url.pathname.slice("/helix/".length);
    const userJson = (u: MockUser) => ({ id: u.id, login: u.login, display_name: u.displayName, profile_image_url: "", type: "", broadcaster_type: "", description: "", created_at: "2020-01-01T00:00:00Z" });

    if (p === "users" && req.method === "GET") {
      const ids = url.searchParams.getAll("id");
      const logins = url.searchParams.getAll("login").map((l) => l.toLowerCase());
      let list = [...this.users.values()];
      if (ids.length || logins.length) list = list.filter((u) => ids.includes(u.id) || logins.includes(u.login));
      else list = tokenUser === "app" ? [] : [this.users.get(tokenUser)!];
      return send(200, { data: list.map(userJson) });
    }
    if (p === "streams/key" && req.method === "GET") {
      const b = url.searchParams.get("broadcaster_id") ?? "";
      const u = this.users.get(tokenUser);
      if (this.streamKeyOutage) return send(503, { status: 503, message: "Service Unavailable" });
      if (!u || tokenUser !== b) return send(403, { status: 403, message: "The ID in broadcaster_id must match the user ID found in the request's OAuth token" });
      if (!u.scopes.includes("channel:read:stream_key")) return send(401, { status: 401, message: "Missing scope: channel:read:stream_key" });
      if (!this.streamKeys.has(b)) this.streamKeys.set(b, `live_${b}_${randomUUID().replace(/-/g, "").slice(0, 24)}`);
      return send(200, { data: [{ stream_key: this.streamKeys.get(b) }] });
    }
    if (p === "streams") return send(200, { data: [], pagination: {} });
    if (p === "clips" && req.method === "POST") {
      const b = url.searchParams.get("broadcaster_id") ?? "";
      if (tokenUser !== b || this.clipsDisabled) return send(403, { status: 403, message: "User does not have permission" });
      const id = `MockClip${++this.n}`;
      this.clips.set(id, { id, broadcasterId: b, url: `https://clips.twitch.tv/${id}` });
      return send(202, { data: [{ id, edit_url: `https://clips.twitch.tv/${id}/edit` }] });
    }
    if (p === "clips" && req.method === "GET") {
      const data = url.searchParams
        .getAll("id")
        .map((id) => this.clips.get(id))
        .filter(Boolean)
        .map((c) => ({
          id: c!.id, url: c!.url, embed_url: `https://clips.twitch.tv/embed?clip=${c!.id}`, broadcaster_id: c!.broadcasterId, broadcaster_name: "",
          creator_id: c!.broadcasterId, creator_name: "", video_id: "", game_id: "", language: "en", title: "Clip", view_count: 0,
          created_at: new Date().toISOString(), thumbnail_url: "", duration: 30, vod_offset: null, is_featured: false,
        }));
      return send(200, { data, pagination: {} });
    }
    if (p === "chat/messages" && req.method === "POST") {
      const b = JSON.parse(raw || "{}") as { broadcaster_id: string; sender_id: string; message: string };
      this.chat.push({ broadcasterId: b.broadcaster_id, senderId: b.sender_id, message: b.message });
      return send(200, { data: [{ message_id: `m${++this.n}`, is_sent: true }] });
    }
    if (p === "eventsub/subscriptions") {
      if (req.method === "GET") return send(200, { data: [], total: 0, pagination: {} });
      if (req.method === "POST") {
        const b = JSON.parse(raw || "{}") as { type: string; version: string; condition: Record<string, string>; transport: unknown };
        return send(202, { data: [{ id: randomUUID(), status: "webhook_callback_verification_pending", type: b.type, version: b.version, condition: b.condition, created_at: new Date().toISOString(), transport: b.transport, cost: 1 }] });
      }
      return send(204, {});
    }
    return send(404, { status: 404, message: `mock has no ${req.method} ${p}` });
  }
}

/** Read a server-sent-events response until `count` events arrive or the time runs out. */
export async function readSse(url: string, headers: Record<string, string>, count: number, timeoutMs = 8000): Promise<{ id: string; event: string; data: any }[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const out: { id: string; event: string; data: any }[] = [];
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev: { id: string; event: string; data: any } = { id: "", event: "message", data: null };
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) ev.id = line.slice(3).trim();
          else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
          else if (line.startsWith("data:")) ev.data = JSON.parse(line.slice(5).trim());
        }
        if (ev.id) out.push(ev);
      }
    }
    ac.abort();
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  return out;
}
