import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createBrowserSession,
  deleteBrowserSession,
  getBroadcasterForOwner,
  getBrowserSession,
  getUser,
  type BroadcasterRow,
  type UserRow,
} from "@slot1/db";
import { randomToken, safeEqual, sha256 } from "@slot1/platform";
import type { ServerContext, Viewer } from "@slot1/services";
import { forbidden, unauthorized } from "./errors";

export const SESSION_COOKIE = "slot1_session";
const SESSION_TTL_SEC = 30 * 24 * 3600;

export interface RequestAuth {
  viewer: Viewer;
  user: UserRow | null;
  broadcaster: BroadcasterRow | null;
  sessionIdHash: Buffer | null;
  csrfToken: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth;
  }
}

export function cookieOptions(ctx: ServerContext) {
  return {
    httpOnly: true,
    secure: ctx.config.isProduction || ctx.config.publicOrigin.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  };
}

/** Resolve the browser session from its HttpOnly cookie (only a hash is stored server-side). */
export async function loadAuth(ctx: ServerContext, req: FastifyRequest): Promise<RequestAuth> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw || raw.length > 200) return { viewer: { userId: null, broadcasterId: null, isOperator: false }, user: null, broadcaster: null, sessionIdHash: null, csrfToken: null };
  const idHash = sha256(raw);
  const s = await getBrowserSession(ctx.db, idHash);
  if (!s) return { viewer: { userId: null, broadcasterId: null, isOperator: false }, user: null, broadcaster: null, sessionIdHash: null, csrfToken: null };
  const user = s.user_id ? await getUser(ctx.db, s.user_id) : null;
  const broadcaster = user ? await getBroadcasterForOwner(ctx.db, user.id) : null;
  return {
    viewer: { userId: user?.id ?? null, broadcasterId: broadcaster?.id ?? null, isOperator: user?.is_operator ?? false },
    user,
    broadcaster,
    sessionIdHash: idHash,
    csrfToken: s.csrf_token,
  };
}

/** Ensure there is a browser session (anonymous is fine) — needed for CSRF and OAuth state binding. */
export async function ensureSession(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply): Promise<{ idHash: Buffer; csrf: string }> {
  if (req.auth.sessionIdHash && req.auth.csrfToken) return { idHash: req.auth.sessionIdHash, csrf: req.auth.csrfToken };
  const raw = randomToken(32);
  const csrf = randomToken(24);
  const idHash = sha256(raw);
  await createBrowserSession(ctx.db, idHash, csrf, SESSION_TTL_SEC, null);
  reply.setCookie(SESSION_COOKIE, raw, cookieOptions(ctx));
  req.auth = { ...req.auth, sessionIdHash: idHash, csrfToken: csrf };
  return { idHash, csrf };
}

/** Bind a user to a NEW session id (rotation prevents session fixation) and drop the old one. */
export async function signIn(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply, userId: string) {
  if (req.auth.sessionIdHash) await deleteBrowserSession(ctx.db, req.auth.sessionIdHash);
  const raw = randomToken(32);
  const csrf = randomToken(24);
  await createBrowserSession(ctx.db, sha256(raw), csrf, SESSION_TTL_SEC, userId);
  reply.setCookie(SESSION_COOKIE, raw, cookieOptions(ctx));
}

export async function signOut(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply) {
  if (req.auth.sessionIdHash) await deleteBrowserSession(ctx.db, req.auth.sessionIdHash);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for cookie-authenticated mutations: a per-session token in a custom header
 * (which cross-site forms cannot set) plus an Origin check against the single public origin.
 */
export function assertCsrf(ctx: ServerContext, req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== ctx.config.publicOrigin) throw forbidden("Cross-origin request rejected");
  const header = req.headers["x-slot1-csrf"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || !req.auth.csrfToken || !safeEqual(token, req.auth.csrfToken)) throw forbidden("Missing or invalid CSRF token — reload the page");
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.auth.user) throw unauthorized();
  return req.auth.user;
}

export function requireBroadcaster(req: FastifyRequest): BroadcasterRow {
  requireUser(req);
  if (!req.auth.broadcaster) throw forbidden("Connect a channel first");
  return req.auth.broadcaster;
}
