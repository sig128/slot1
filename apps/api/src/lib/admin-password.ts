import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Redis } from "ioredis";
import { sha256Hex } from "@slot1/platform";

/*
 * The admin password (docs/ADMIN.md). The server keeps only a scrypt hash, in
 * SLOT1_ADMIN_PASSWORD_HASH, encoded as scrypt$N$r$p$saltBase64$hashBase64.
 * `node dist/admin-password.js` makes one from a password piped on stdin (the server's
 * `slot1 admin-password` asks for it without showing it). Signing in with it starts the same
 * 12-hour admin session as a one-time link.
 */

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 1024;

const COST_N = 2 ** 15;
const BLOCK_R = 8;
const PARALLEL_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** N=2^15, r=8 needs 128·N·r = 32 MiB, exactly Node's default ceiling: give it headroom. */
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Length in characters as people count them (code points), after the normalization we hash. */
export function passwordLength(password: string): number {
  return [...password.normalize("NFC")].length;
}

export async function hashAdminPassword(password: string): Promise<string> {
  const length = passwordLength(password);
  if (length < ADMIN_PASSWORD_MIN_LENGTH) throw new Error(`The admin password needs at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`);
  if (length > ADMIN_PASSWORD_MAX_LENGTH) throw new Error(`The admin password can have at most ${ADMIN_PASSWORD_MAX_LENGTH} characters`);
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize("NFC"), salt, KEY_BYTES, { N: COST_N, r: BLOCK_R, p: PARALLEL_P, maxmem: MAXMEM });
  return `scrypt$${COST_N}$${BLOCK_R}$${PARALLEL_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export interface ParsedAdminPasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/** The env value without surrounding quotes (an .env file needs them because of the "$"s). */
function unquote(raw: string): string {
  const v = raw.trim();
  return /^(['"]).*\1$/s.test(v) ? v.slice(1, -1) : v;
}

/** Parse and sanity-check a stored hash. Anything malformed or out of range counts as "not set". */
export function parseAdminPasswordHash(raw: string | null | undefined): ParsedAdminPasswordHash | null {
  if (!raw) return null;
  const m = /^scrypt\$(\d{1,8})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9+/_-]+={0,2})\$([A-Za-z0-9+/_-]+={0,2})$/.exec(unquote(raw));
  if (!m) return null;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16 || 128 * N * r * p > 256 * 1024 * 1024) return null;
  const salt = Buffer.from(m[4]!, "base64");
  const key = Buffer.from(m[5]!, "base64");
  if (salt.length < 16 || key.length < 16 || key.length > 128) return null;
  return { N, r, p, salt, key };
}

export function adminPasswordConfigured(raw: string | null | undefined): boolean {
  return parseAdminPasswordHash(raw) !== null;
}

/*
 * At most two checks run at once. scrypt runs on libuv's small thread pool, which file and DNS
 * work share, so a burst of attempts waits its turn here instead of starving the rest of the API.
 */
const PARALLEL_CHECKS = 2;
let checksRunning = 0;
const checkQueue: (() => void)[] = [];

async function inCheckSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (checksRunning < PARALLEL_CHECKS) checksRunning += 1;
  else await new Promise<void>((resolve) => checkQueue.push(resolve));
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiting check, or free it.
    const next = checkQueue.shift();
    if (next) next();
    else checksRunning -= 1;
  }
}

/** Constant-time comparison of the scrypt output. False for a malformed hash or an unusable input. */
export async function verifyAdminPassword(password: unknown, raw: string | null | undefined): Promise<boolean> {
  const h = parseAdminPasswordHash(raw);
  if (!h || typeof password !== "string" || password.length === 0 || password.length > ADMIN_PASSWORD_MAX_LENGTH * 4) return false;
  const maxmem = Math.max(MAXMEM, 128 * h.N * h.r * h.p * 2);
  const key = await inCheckSlot(() => scrypt(password.normalize("NFC"), h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem }));
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

/**
 * A short, one-way tag of the configured hash, stored in every admin session. When the password
 * changes (or is set for the first time), sessions carrying the old tag stop working.
 */
export function adminPasswordFingerprint(raw: string | null | undefined): string {
  if (!adminPasswordConfigured(raw)) return "none";
  return sha256Hex(`slot1-admin-password\0${unquote(raw!)}`).slice(0, 24);
}

/* Attempt limits ------------------------------------------------------------------------- */

export const LOGIN_WINDOW_SEC = 15 * 60;
export const LOGIN_MAX_FAILURES_PER_IP = 5;
/** Failed attempts across all addresses in the window before sign-in pauses (soft lockout). */
export const LOGIN_GLOBAL_SOFT_LIMIT = 20;
/** A failed attempt is answered no sooner than this, so timing says nothing about why it failed. */
export const LOGIN_FAILURE_MIN_MS = 750;

const ipKey = (k: string) => `slot1:admin:pw:ip:${k}`;
const GLOBAL_KEY = "slot1:admin:pw:global";
const GATE_KEY = "slot1:admin:pw:gate";
const statsKey = (day: string) => `slot1:admin:pw:stats:${day}`;
const LAST_KEY = "slot1:admin:pw:last";

/** Attempts are counted per address under an HMAC of it: the address itself is never stored. */
export function loginAddressKey(secret: Buffer, ip: string): string {
  return createHmac("sha256", secret).update(`admin-login\0${ip}`).digest("base64url").slice(0, 32);
}

export interface LoginBlock {
  scope: "address" | "everyone";
  retryAfterSec: number;
}

/**
 * Called before the password is checked. The attempt is counted against the address up front, so
 * parallel requests can't slip past the limit; a correct password clears the count again.
 * Returns why sign-in is refused right now, or null to go ahead and check the password.
 */
export async function beginLoginAttempt(redis: Redis, addressKey: string, now = new Date()): Promise<LoginBlock | null> {
  const gateMs = await redis.pttl(GATE_KEY);
  if (gateMs > 0) {
    await bumpStats(redis, "blocked", now);
    return { scope: "everyone", retryAfterSec: Math.ceil(gateMs / 1000) };
  }
  const key = ipKey(addressKey);
  // SET … NX before INCR starts the 15-minute window once; INCR keeps that expiry.
  const res = await redis.multi().set(key, "0", "EX", LOGIN_WINDOW_SEC, "NX").incr(key).ttl(key).exec();
  const attempts = Number(res?.[1]?.[1] ?? 0);
  let ttl = Number(res?.[2]?.[1] ?? LOGIN_WINDOW_SEC);
  if (ttl < 0) {
    await redis.expire(key, LOGIN_WINDOW_SEC);
    ttl = LOGIN_WINDOW_SEC;
  }
  if (attempts > LOGIN_MAX_FAILURES_PER_IP) {
    await bumpStats(redis, "blocked", now);
    return { scope: "address", retryAfterSec: Math.max(1, ttl) };
  }
  return null;
}

/** Pause for everyone after many failures: 1 minute, doubling every 10 more failures, at most 15 minutes. */
export function globalPauseMs(failuresInWindow: number): number {
  if (failuresInWindow <= LOGIN_GLOBAL_SOFT_LIMIT) return 0;
  const step = Math.floor((failuresInWindow - LOGIN_GLOBAL_SOFT_LIMIT - 1) / 10);
  return Math.min(60_000 * 2 ** step, LOGIN_WINDOW_SEC * 1000);
}

/** A wrong password. The address was counted already; this counts toward the pause for everyone. */
export async function recordLoginFailure(redis: Redis, now = new Date()): Promise<void> {
  const res = await redis.multi().set(GLOBAL_KEY, "0", "EX", LOGIN_WINDOW_SEC, "NX").incr(GLOBAL_KEY).exec();
  const pause = globalPauseMs(Number(res?.[1]?.[1] ?? 0));
  if (pause > 0) await redis.set(GATE_KEY, "1", "PX", pause);
  await bumpStats(redis, "fail", now);
}

export async function recordLoginSuccess(redis: Redis, addressKey: string, now = new Date()): Promise<void> {
  await redis.del(ipKey(addressKey));
  await bumpStats(redis, "ok", now);
}

/* Sign-in counts for /admin → System (no addresses, no passwords) ------------------------- */

type StatField = "ok" | "fail" | "blocked";

async function bumpStats(redis: Redis, kind: StatField, now: Date): Promise<void> {
  const key = statsKey(now.toISOString().slice(0, 10));
  const m = redis.multi().hincrby(key, kind, 1).expire(key, 9 * 24 * 3600);
  if (kind !== "blocked") m.hset(LAST_KEY, kind === "ok" ? "okAt" : "failAt", now.toISOString());
  await m.exec();
}

export interface AdminLoginCounts {
  succeeded: number;
  failed: number;
  /** Attempts refused by the limits before the password was checked. */
  blocked: number;
}

export interface AdminLoginStats {
  today: AdminLoginCounts;
  last7d: AdminLoginCounts;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  /** Set while password sign-in is paused for everyone after many failures. */
  pausedUntil: string | null;
}

export async function adminLoginStats(redis: Redis, now = new Date()): Promise<AdminLoginStats> {
  const days = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  const [rows, last, gateMs] = await Promise.all([Promise.all(days.map((d) => redis.hgetall(statsKey(d)))), redis.hgetall(LAST_KEY), redis.pttl(GATE_KEY)]);
  const n = (v: string | undefined) => Number(v ?? 0) || 0;
  const counts = (r: Record<string, string> | undefined): AdminLoginCounts => ({ succeeded: n(r?.ok), failed: n(r?.fail), blocked: n(r?.blocked) });
  const week = rows.map(counts).reduce((a, b) => ({ succeeded: a.succeeded + b.succeeded, failed: a.failed + b.failed, blocked: a.blocked + b.blocked }));
  return {
    today: counts(rows[0]),
    last7d: week,
    lastSucceededAt: last.okAt ?? null,
    lastFailedAt: last.failAt ?? null,
    pausedUntil: gateMs > 0 ? new Date(now.getTime() + gateMs).toISOString() : null,
  };
}
