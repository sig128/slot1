import { createHash, randomBytes } from "node:crypto";
import type { ServerContext } from "./context";

/**
 * Kick's official public API (docs.kick.com): live state, title, category, viewers and thumbnail
 * for Kick channels, and "Sign in with Kick" (OAuth 2.1 with PKCE on id.kick.com). It needs a Kick
 * developer app (KICK_CLIENT_ID and KICK_CLIENT_SECRET, set in Admin → Settings → Kick app). Without
 * one, Kick channels still play through Kick's own embed and their live state is shown as unknown,
 * never guessed.
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

const CHANNEL_KEY = (slug: string) => `slot1:kick:channel:${slug}`;
const CHANNEL_TTL_SEC = 5;

/**
 * Kick's public data for channels by slug (lower-case), cached 5 s per channel. A slug Kick
 * doesn't know is left out.
 */
export async function kickChannels(ctx: ServerContext, slugs: string[]): Promise<Map<string, KickChannel>> {
  const out = new Map<string, KickChannel>();
  if (slugs.length === 0 || !kickConfigured(ctx)) return out;
  const missing: string[] = [];
  for (const slug of slugs) {
    const raw = await ctx.redis.get(CHANNEL_KEY(slug)).catch(() => null);
    if (raw) out.set(slug, JSON.parse(raw) as KickChannel);
    else missing.push(slug);
  }
  if (missing.length === 0) return out;
  const fresh = await fetchKickChannels(ctx, missing);
  for (const [slug, c] of fresh) {
    out.set(slug, c);
    await ctx.redis.set(CHANNEL_KEY(slug), JSON.stringify(c), "EX", CHANNEL_TTL_SEC).catch(() => undefined);
  }
  return out;
}

async function fetchKickChannels(ctx: ServerContext, slugs: string[]): Promise<Map<string, KickChannel>> {
  const out = new Map<string, KickChannel>();
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

/* ------------------------------------------------------------------------------------------ */
/* Sign in with Kick (OAuth 2.1, authorization code with PKCE)                                */
/* ------------------------------------------------------------------------------------------ */

/** Signing in to chat: who you are on Kick, nothing else. */
export const KICK_VIEWER_SCOPES = ["user:read"];
/** Connecting a Kick channel: who you are and which channel is yours. */
export const KICK_CREATOR_SCOPES = ["user:read", "channel:read"];

/** Where Kick sends people back. Register exactly this as the Kick app's Redirect URL. */
export function kickRedirectUri(ctx: Pick<ServerContext, "config">): string {
  return `${ctx.config.publicOrigin}/api/auth/kick/callback`;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** A fresh PKCE pair: a 86-character verifier and its S256 challenge (RFC 7636). */
export function kickPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function kickAuthorizeUrl(ctx: Pick<ServerContext, "config">, input: { scopes: string[]; state: string; challenge: string }): string {
  const env = ctx.config.env;
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.KICK_CLIENT_ID ?? "",
    redirect_uri: kickRedirectUri(ctx),
    scope: input.scopes.join(" "),
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  return `${env.KICK_ID_BASE.replace(/\/$/, "")}/oauth/authorize?${q.toString()}`;
}

export interface KickUserTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Exchanges the authorization code (with the PKCE verifier) for a user token. */
export async function kickExchangeCode(ctx: ServerContext, input: { code: string; verifier: string; redirectUri: string }): Promise<KickUserTokens> {
  const env = ctx.config.env;
  const res = await fetch(`${env.KICK_ID_BASE.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.KICK_CLIENT_ID ?? "",
      client_secret: env.KICK_CLIENT_SECRET ?? "",
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      code: input.code,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const said = await res.text().catch(() => "");
    throw new KickApiError(`Kick refused the sign-in code (${res.status}): ${said.slice(0, 200)}`, res.status);
  }
  const body = (await res.json()) as Partial<KickUserTokens>;
  if (!body.access_token) throw new KickApiError("Kick answered without a token", 502);
  return body as KickUserTokens;
}

async function userGet<T>(ctx: ServerContext, token: string, path: string): Promise<T> {
  const res = await fetch(`${ctx.config.env.KICK_API_BASE.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new KickApiError(`Kick answered ${res.status}`, res.status);
  return (await res.json()) as T;
}

/** The signed-in Kick account (user:read). Kick also returns an email; SLOT1 doesn't keep it. */
export async function kickTokenUser(ctx: ServerContext, token: string): Promise<{ userId: string; name: string; avatarUrl: string | null }> {
  const { data } = await userGet<{ data?: ApiUser[] }>(ctx, token, "/users");
  const u = data?.[0];
  if (!u || typeof u.user_id !== "number") throw new KickApiError("Kick named no account for this sign-in", 502);
  return { userId: String(u.user_id), name: (u.name ?? "").trim() || `kick_${u.user_id}`, avatarUrl: httpsOrNull(u.profile_picture) };
}

/** The signed-in account's own Kick channel (channel:read), or null when Kick returns none. */
export async function kickTokenChannel(ctx: ServerContext, token: string): Promise<{ slug: string; userId: string | null } | null> {
  const { data } = await userGet<{ data?: ApiChannel[] }>(ctx, token, "/channels");
  const c = data?.[0];
  if (!c || typeof c.slug !== "string" || !/^[A-Za-z0-9_-]{1,25}$/.test(c.slug)) return null;
  return { slug: c.slug.toLowerCase(), userId: typeof c.broadcaster_user_id === "number" ? String(c.broadcaster_user_id) : null };
}

/** SLOT1 keeps no Kick token: after sign-in it is revoked (best effort). */
export async function kickRevoke(ctx: ServerContext, token: string): Promise<void> {
  const q = new URLSearchParams({ token, token_hint_type: "access_token" });
  await fetch(`${ctx.config.env.KICK_ID_BASE.replace(/\/$/, "")}/oauth/revoke?${q.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
}
