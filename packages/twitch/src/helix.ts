import type { FetchLike } from "./oauth";

export class HelixError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isRateLimited() {
    return this.status === 429;
  }
}

export interface HelixUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  broadcaster_type: string;
}
export interface HelixStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
}
export interface HelixChannel {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  game_name: string;
  title: string;
}
export interface HelixClip {
  id: string;
  url: string;
  embed_url: string;
  broadcaster_id: string;
  creator_id: string;
  video_id: string;
  title: string;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  vod_offset: number | null;
}
export interface HelixClipDownload {
  clip_id: string;
  landscape_download_url: string | null;
  portrait_download_url: string | null;
}
export interface HelixVideo {
  id: string;
  stream_id: string | null;
  user_id: string;
  created_at: string;
  duration: string;
  url: string;
  type: string;
}
export interface HelixEventSubSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  created_at: string;
  transport: { method: string; callback?: string };
}
export interface SendChatResult {
  message_id: string;
  is_sent: boolean;
  drop_reason?: { code: string; message: string } | null;
}

/**
 * Thin, typed Helix client. Every call takes the token explicitly so callers decide which
 * identity (app, broadcaster, bot) is used — they are never mixed implicitly.
 */
export class HelixClient {
  /** Last observed rate-limit state, for observability. */
  rateLimit: { remaining: number | null; resetAt: number | null } = { remaining: null, resetAt: null };

  constructor(
    private readonly clientId: string,
    private readonly base = "https://api.twitch.tv/helix",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(
    token: string,
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    query: [string, string][] = [],
    body?: unknown,
    attempt = 0,
  ): Promise<{ status: number; json: T | null }> {
    const q = new URLSearchParams(query);
    const url = `${this.base.replace(/\/$/, "")}/${path}${query.length ? `?${q.toString()}` : ""}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          "client-id": this.clientId,
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new HelixError(`Helix ${path} request failed: ${(err as Error).message}`, 0, path);
    }
    const remaining = res.headers.get("ratelimit-remaining");
    const reset = res.headers.get("ratelimit-reset");
    this.rateLimit = { remaining: remaining ? Number(remaining) : null, resetAt: reset ? Number(reset) * 1000 : null };
    if (res.status === 429) {
      const waitMs = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) : 1000;
      if (attempt === 0 && waitMs <= 5000) {
        await new Promise((r) => setTimeout(r, waitMs + 50));
        return this.request<T>(token, method, path, query, body, attempt + 1);
      }
      throw new HelixError(`Helix rate limit reached for ${path}`, 429, path, waitMs);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        /* raw */
      }
      throw new HelixError(`Helix ${method} ${path} → ${res.status}: ${message}`, res.status, path);
    }
    return { status: res.status, json: text ? (JSON.parse(text) as T) : null };
  }

  async getUsers(token: string, by: { ids?: string[]; logins?: string[] }): Promise<HelixUser[]> {
    const q: [string, string][] = [...(by.ids ?? []).map((id) => ["id", id] as [string, string]), ...(by.logins ?? []).map((l) => ["login", l] as [string, string])];
    const r = await this.request<{ data: HelixUser[] }>(token, "GET", "users", q);
    return r.json?.data ?? [];
  }

  /** Token owner (user tokens only). */
  async getTokenUser(token: string): Promise<HelixUser | null> {
    const r = await this.request<{ data: HelixUser[] }>(token, "GET", "users");
    return r.json?.data[0] ?? null;
  }

  async getStreams(token: string, by: { userIds?: string[]; userLogins?: string[] }): Promise<HelixStream[]> {
    const q: [string, string][] = [
      ...(by.userIds ?? []).map((id) => ["user_id", id] as [string, string]),
      ...(by.userLogins ?? []).map((l) => ["user_login", l] as [string, string]),
      ["first", "100"],
    ];
    const r = await this.request<{ data: HelixStream[] }>(token, "GET", "streams", q);
    return r.json?.data ?? [];
  }

  async getChannels(token: string, broadcasterIds: string[]): Promise<HelixChannel[]> {
    if (broadcasterIds.length === 0) return [];
    const r = await this.request<{ data: HelixChannel[] }>(token, "GET", "channels", broadcasterIds.map((id) => ["broadcaster_id", id] as [string, string]));
    return r.json?.data ?? [];
  }

  /** Create Clip (live). Requires a user token with clips:edit. Asynchronous: poll getClips. */
  async createClip(userToken: string, broadcasterId: string, hasDelay = false): Promise<{ id: string; edit_url: string }> {
    const r = await this.request<{ data: { id: string; edit_url: string }[] }>(userToken, "POST", "clips", [
      ["broadcaster_id", broadcasterId],
      ["has_delay", String(hasDelay)],
    ]);
    const d = r.json?.data[0];
    if (!d) throw new HelixError("Create Clip returned no clip", r.status, "clips");
    return d;
  }

  /** Get Stream Key. Requires the broadcaster's token with channel:read:stream_key. */
  async getStreamKey(userToken: string, broadcasterId: string): Promise<string> {
    const r = await this.request<{ data: { stream_key: string }[] }>(userToken, "GET", "streams/key", [["broadcaster_id", broadcasterId]]);
    const key = r.json?.data[0]?.stream_key;
    if (!key) throw new HelixError("Get Stream Key returned no key", r.status, "streams/key");
    return key;
  }

  async getClips(token: string, ids: string[]): Promise<HelixClip[]> {
    if (ids.length === 0) return [];
    const r = await this.request<{ data: HelixClip[] }>(token, "GET", "clips", ids.map((id) => ["id", id] as [string, string]));
    return r.json?.data ?? [];
  }

  /** Get Clips Download. Requires channel:manage:clips (broadcaster) or editor:manage:clips (editor). */
  async getClipsDownload(userToken: string, input: { editorId: string; broadcasterId: string; clipIds: string[] }): Promise<HelixClipDownload[]> {
    const q: [string, string][] = [
      ["editor_id", input.editorId],
      ["broadcaster_id", input.broadcasterId],
      ...input.clipIds.slice(0, 10).map((id) => ["clip_id", id] as [string, string]),
    ];
    const r = await this.request<{ data: HelixClipDownload[] }>(userToken, "GET", "clips/downloads", q);
    return r.json?.data ?? [];
  }

  /** Create Clip From VOD. vod_offset marks where the clip ENDS; it must be >= duration. */
  async createClipFromVod(
    userToken: string,
    input: { editorId: string; broadcasterId: string; vodId: string; vodOffsetSec: number; durationSec: number; title: string },
  ): Promise<{ id: string; edit_url: string }> {
    const r = await this.request<{ data: { id: string; edit_url: string }[] }>(userToken, "POST", "videos/clips", [
      ["editor_id", input.editorId],
      ["broadcaster_id", input.broadcasterId],
      ["vod_id", input.vodId],
      ["vod_offset", String(Math.max(Math.ceil(input.durationSec), Math.round(input.vodOffsetSec)))],
      ["duration", input.durationSec.toFixed(1)],
      ["title", input.title.slice(0, 100)],
    ]);
    const d = r.json?.data[0];
    if (!d) throw new HelixError("Create Clip From VOD returned no clip", r.status, "videos/clips");
    return d;
  }

  async getArchiveVideos(token: string, userId: string, first = 5): Promise<HelixVideo[]> {
    const r = await this.request<{ data: HelixVideo[] }>(token, "GET", "videos", [
      ["user_id", userId],
      ["type", "archive"],
      ["first", String(first)],
    ]);
    return r.json?.data ?? [];
  }

  async sendChatMessage(token: string, input: { broadcasterId: string; senderId: string; message: string; replyParentMessageId?: string | null }): Promise<SendChatResult> {
    const body: Record<string, string> = { broadcaster_id: input.broadcasterId, sender_id: input.senderId, message: input.message.slice(0, 500) };
    if (input.replyParentMessageId) body.reply_parent_message_id = input.replyParentMessageId;
    const r = await this.request<{ data: SendChatResult[] }>(token, "POST", "chat/messages", [], body);
    const d = r.json?.data[0];
    if (!d) throw new HelixError("Send Chat Message returned no result", r.status, "chat/messages");
    return d;
  }

  async createEventSubSubscription(
    appToken: string,
    input: { type: string; version: string; condition: Record<string, string>; callback: string; secret: string },
  ): Promise<HelixEventSubSubscription> {
    const r = await this.request<{ data: HelixEventSubSubscription[] }>(appToken, "POST", "eventsub/subscriptions", [], {
      type: input.type,
      version: input.version,
      condition: input.condition,
      transport: { method: "webhook", callback: input.callback, secret: input.secret },
    });
    const d = r.json?.data[0];
    if (!d) throw new HelixError("EventSub create returned no subscription", r.status, "eventsub/subscriptions");
    return d;
  }

  async listEventSubSubscriptions(appToken: string, filter: { userId?: string } = {}): Promise<HelixEventSubSubscription[]> {
    const out: HelixEventSubSubscription[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q: [string, string][] = [];
      if (filter.userId) q.push(["user_id", filter.userId]);
      if (cursor) q.push(["after", cursor]);
      const r = await this.request<{ data: HelixEventSubSubscription[]; pagination?: { cursor?: string } }>(appToken, "GET", "eventsub/subscriptions", q);
      out.push(...(r.json?.data ?? []));
      cursor = r.json?.pagination?.cursor;
      if (!cursor) break;
    }
    return out;
  }

  async deleteEventSubSubscription(appToken: string, id: string): Promise<void> {
    try {
      await this.request(appToken, "DELETE", "eventsub/subscriptions", [["id", id]]);
    } catch (err) {
      if (err instanceof HelixError && err.status === 404) return;
      throw err;
    }
  }
}

/** Twitch thumbnail URLs contain {width}x{height} placeholders. */
export function sizeThumbnail(url: string, width = 640, height = 360): string {
  return url.replace("{width}", String(width)).replace("{height}", String(height));
}
