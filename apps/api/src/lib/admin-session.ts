import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { randomToken, sha256Hex, signPayload, verifyPayload, type AppConfig } from "@slot1/platform";
import { adminPasswordFingerprint } from "./admin-password";

/*
 * Admin sessions (docs/ADMIN.md). Two ways start one: the admin password (POST /api/admin/login)
 * and a one-time link (`node dist/admin-link.js`, run on the server, mints a signed link that
 * works once within 15 minutes; opening it and confirming starts the session). Either way the
 * session is a random cookie whose hash is kept in Redis for 12 hours. It opens /admin and its
 * /api/admin/* endpoints only. It is not a user account and grants no operator power elsewhere
 * (bot linking and the model registry still need a Twitch operator account). Every session
 * carries a tag of the admin password hash at the time: changing the password ends them all.
 */

export const ADMIN_COOKIE = "slot1_admin";
export const ADMIN_SESSION_TTL_SEC = 12 * 3600;
export const ADMIN_LINK_TTL_SEC = 15 * 60;

const linkKey = (nonce: string) => `slot1:admin:link:${nonce}`;
const sessionKey = (hash: string) => `slot1:admin:session:${hash}`;

interface LinkClaims extends Record<string, unknown> {
  t: "admin-link";
  n: string;
  exp: number;
}

interface Deps {
  config: AppConfig;
  redis: Redis;
}

export type AdminSessionVia = "link" | "password";

interface StoredSession {
  createdAt: string;
  via?: AdminSessionVia;
  /** adminPasswordFingerprint() when the session started; missing on sessions from before passwords. */
  pw?: string;
}

/**
 * Where the current password hash comes from, per Redis connection. The admin routes register
 * their live config, so callers that only have Redis (hasAdminSession) still check sessions
 * against the current password. Unregistered, no password counts as set.
 */
const passwordHashSources = new WeakMap<Redis, () => string | null | undefined>();
export function trackAdminPasswordHash(redis: Redis, source: () => string | null | undefined) {
  passwordHashSources.set(redis, source);
}

/** Create a single-use sign-in link. The nonce is what makes it single-use; the HMAC makes it unforgeable. */
export async function mintAdminLink(deps: Deps, nowMs = Date.now()): Promise<{ url: string; expiresAt: string }> {
  const nonce = randomToken(18);
  const exp = Math.floor(nowMs / 1000) + ADMIN_LINK_TTL_SEC;
  await deps.redis.set(linkKey(nonce), "1", "EX", ADMIN_LINK_TTL_SEC);
  const token = signPayload(deps.config.sessionSecret, { t: "admin-link", n: nonce, exp } satisfies LinkClaims);
  return { url: `${deps.config.publicOrigin}/api/admin/link?token=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Signature, type and expiry. Says nothing about whether the link was already used. */
export function readLinkToken(config: AppConfig, token: string | undefined, nowMs = Date.now()): string | null {
  if (!token || token.length > 1000) return null;
  const v = verifyPayload<LinkClaims>(config.sessionSecret, token, nowMs);
  if (!v.ok || v.payload.t !== "admin-link" || typeof v.payload.n !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(v.payload.n)) return null;
  return v.payload.n;
}

export async function linkUnused(redis: Redis, nonce: string): Promise<boolean> {
  return (await redis.exists(linkKey(nonce))) === 1;
}

/** Atomically use the link up: only the first caller gets true. */
export async function consumeLink(redis: Redis, nonce: string): Promise<boolean> {
  return (await redis.del(linkKey(nonce))) === 1;
}

// SameSite=Strict: the admin cookie is never sent on requests that start on another site.
const cookieOpts = (config: AppConfig) => ({
  httpOnly: true,
  secure: config.isProduction || config.publicOrigin.startsWith("https://"),
  sameSite: "strict" as const,
  path: "/",
  maxAge: ADMIN_SESSION_TTL_SEC,
});

export async function startAdminSession(deps: Deps, reply: FastifyReply, via: AdminSessionVia = "link"): Promise<void> {
  const raw = randomToken(32);
  const session: StoredSession = { createdAt: new Date().toISOString(), via, pw: adminPasswordFingerprint(deps.config.env.SLOT1_ADMIN_PASSWORD_HASH) };
  await deps.redis.set(sessionKey(sha256Hex(raw)), JSON.stringify(session), "EX", ADMIN_SESSION_TTL_SEC);
  reply.setCookie(ADMIN_COOKIE, raw, cookieOpts(deps.config));
}

/** The valid admin session behind this request's cookie, or null. A session from before the current password is deleted. */
export async function readAdminSession(redis: Redis, req: FastifyRequest): Promise<{ via: AdminSessionVia } | null> {
  const raw = req.cookies[ADMIN_COOKIE];
  if (!raw || raw.length > 200) return null;
  const key = sessionKey(sha256Hex(raw));
  const stored = await redis.get(key);
  if (!stored) return null;
  let session: StoredSession;
  try {
    session = JSON.parse(stored) as StoredSession;
  } catch {
    return null;
  }
  if ((session.pw ?? "none") !== adminPasswordFingerprint(passwordHashSources.get(redis)?.())) {
    await redis.del(key);
    return null;
  }
  return { via: session.via === "password" ? "password" : "link" };
}

export async function hasAdminSession(redis: Redis, req: FastifyRequest): Promise<boolean> {
  return (await readAdminSession(redis, req)) !== null;
}

export async function endAdminSession(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[ADMIN_COOKIE];
  if (raw && raw.length <= 200) await deps.redis.del(sessionKey(sha256Hex(raw)));
  reply.clearCookie(ADMIN_COOKIE, { path: "/" });
}
