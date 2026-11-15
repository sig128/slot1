import type { ServerContext } from "./context";

/**
 * Kick's official public API, for featured Kick channels: live state, title, category, viewers and
 * thumbnail. It needs a Kick developer app (KICK_CLIENT_ID and KICK_CLIENT_SECRET, set in
 * Admin → Settings → Kick app). Without one, Kick channels still play through Kick's own embed and
 * their live state is shown as unknown, never guessed.
 */

export interface KickChannel {
  slug: string;
  userId: number | null;
  displayName: string | null;
  avatarUrl: string | null;
  live: boolean;
  title: string | null;
  category: string | null;
  viewers: number | null;
  thumbnailUrl: string | null;
  startedAt: string | null;
  /** Active paid subscribers (Kick's public API has no follower total). */
  subscribers: number | null;
}

export class KickApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "slot1:kick:app-token";

export function kickConfigured(ctx: Pick<ServerContext, "config">): boolean {
  return Boolean(ctx.config.env.KICK_CLIENT_ID && ctx.config.env.KICK_CLIENT_SECRET);
}

/** An app access token (client credentials), cached in Redis until shortly before it expires. */
async function appToken(ctx: ServerContext, fresh = false): Promise<string> {
  if (!fresh) {
    const cached = await ctx.redis.get(TOKEN_KEY);
    if (cached) return cached;
  }
  const env = ctx.config.env;
  const res = await fetch(`${env.KICK_ID_BASE.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.KICK_CLIENT_ID ?? "", client_secret: env.KICK_CLIENT_SECRET ?? "" }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new KickApiError(`Kick refused the app's credentials (${res.status})`, res.status);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new KickApiError("Kick answered without a token", 502);
  await ctx.redis.set(TOKEN_KEY, body.access_token, "EX", Math.max(60, Math.min(86_400 * 30, (body.expires_in ?? 3600) - 120)));
  return body.access_token;
}

async function get<T>(ctx: ServerContext, path: string): Promise<T> {
  const call = async (token: string) =>
    fetch(`${ctx.config.env.KICK_API_BASE.replace(/\/$/, "")}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  let res = await call(await appToken(ctx));
  // An expired or revoked token: get a new one once.
  if (res.status === 401) res = await call(await appToken(ctx, true));
  if (!res.ok) throw new KickApiError(`Kick answered ${res.status}`, res.status);
  return (await res.json()) as T;
}

interface ApiChannel {
  broadcaster_user_id?: number;
  slug?: string;
  stream_title?: string | null;
  category?: { name?: string | null } | null;
  stream?: { is_live?: boolean; viewer_count?: number | null; thumbnail?: string | null; start_time?: string | null } | null;
  active_subscribers_count?: number | null;
}
interface ApiUser {
  user_id?: number;
  name?: string | null;
  profile_picture?: string | null;
}

const httpsOrNull = (v: string | null | undefined) => (v && /^https:\/\//.test(v) ? v : null);

/** Kick's public data for channels by slug (lower-case). A slug Kick doesn't know is left out. */
export async function kickChannels(ctx: ServerContext, slugs: string[]): Promise<Map<string, KickChannel>> {
  const out = new Map<string, KickChannel>();
  if (slugs.length === 0 || !kickConfigured(ctx)) return out;
  const q = slugs.map((s) => `slug=${encodeURIComponent(s)}`).join("&");
  const { data } = await get<{ data?: ApiChannel[] }>(ctx, `/channels?${q}`);
  const channels = (data ?? []).filter((c): c is ApiChannel & { slug: string } => typeof c.slug === "string");
  // Names and pictures come from the users endpoint; the channel still shows without them.
  const ids = channels.map((c) => c.broadcaster_user_id).filter((id): id is number => typeof id === "number");
  const users = new Map<number, ApiUser>();
  if (ids.length) {
    try {
      const r = await get<{ data?: ApiUser[] }>(ctx, `/users?${ids.map((id) => `id=${id}`).join("&")}`);
      for (const u of r.data ?? []) if (typeof u.user_id === "number") users.set(u.user_id, u);
    } catch {
      // Not every app may read users; names fall back to the slug.
    }
  }
  for (const c of channels) {
    const live = Boolean(c.stream?.is_live);
    const u = typeof c.broadcaster_user_id === "number" ? users.get(c.broadcaster_user_id) : undefined;
    out.set(c.slug.toLowerCase(), {
      slug: c.slug.toLowerCase(),
      userId: c.broadcaster_user_id ?? null,
      displayName: u?.name ?? null,
      avatarUrl: httpsOrNull(u?.profile_picture),
      live,
      title: live ? (c.stream_title ?? null) : null,
      category: live ? (c.category?.name ?? null) : null,
      viewers: live && typeof c.stream?.viewer_count === "number" ? c.stream.viewer_count : null,
      thumbnailUrl: live ? httpsOrNull(c.stream?.thumbnail) : null,
      startedAt: live ? (c.stream?.start_time ?? null) : null,
      subscribers: typeof c.active_subscribers_count === "number" ? c.active_subscribers_count : null,
    });
  }
  return out;
}
