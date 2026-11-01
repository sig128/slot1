import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { randomToken, sha256Hex, signPayload, verifyPayload, type AppConfig } from "@slot1/platform";

/*
 * One-time admin links (docs/ADMIN.md). `node dist/admin-link.js`, run on the server, mints a
 * signed link that works once within 15 minutes. Opening it (and confirming) starts an admin
 * session: a random cookie whose hash is kept in Redis for 12 hours. That session opens /admin
 * and its /api/admin/* endpoints only. It is not a user account and grants no operator power
 * elsewhere (bot linking and the model registry still need a Twitch operator account).
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

const cookieOpts = (config: AppConfig) => ({
  httpOnly: true,
  secure: config.isProduction || config.publicOrigin.startsWith("https://"),
  sameSite: "lax" as const,
  path: "/",
  maxAge: ADMIN_SESSION_TTL_SEC,
});

export async function startAdminSession(deps: Deps, reply: FastifyReply): Promise<void> {
  const raw = randomToken(32);
  await deps.redis.set(sessionKey(sha256Hex(raw)), JSON.stringify({ createdAt: new Date().toISOString() }), "EX", ADMIN_SESSION_TTL_SEC);
  reply.setCookie(ADMIN_COOKIE, raw, cookieOpts(deps.config));
}

export async function hasAdminSession(redis: Redis, req: FastifyRequest): Promise<boolean> {
  const raw = req.cookies[ADMIN_COOKIE];
  if (!raw || raw.length > 200) return false;
  return (await redis.exists(sessionKey(sha256Hex(raw)))) === 1;
}

export async function endAdminSession(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[ADMIN_COOKIE];
  if (raw && raw.length <= 200) await deps.redis.del(sessionKey(sha256Hex(raw)));
  reply.clearCookie(ADMIN_COOKIE, { path: "/" });
}
