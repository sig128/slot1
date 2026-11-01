import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { BrowserFamily, DeviceType, ViewportBucket } from "@slot1/contracts";

/*
 * Cookieless visitor counting (docs/ADMIN.md). Nothing here sets or reads a cookie. A visitor is
 * identified for one UTC day only, by SHA-256(daily salt + IP + User-Agent + site host) cut to
 * 16 bytes. The salt is random, lives only in Redis and expires after 48 hours, so yesterday's
 * IDs can't be recomputed and two days can't be linked. The IP and the User-Agent are never stored.
 */

const SALT_KEY = (day: string) => `slot1:analytics:salt:${day}`;
export const SALT_TTL_SEC = 48 * 3600;
export const PRESENCE_KEY = "slot1:analytics:presence";
const PRESENCE_PATH_KEY = (visitor: string) => `slot1:analytics:presence:path:${visitor}`;
/** Presence entries disappear 5 minutes after a visitor's last page view or heartbeat. */
export const PRESENCE_TTL_SEC = 300;
/** "On the site now": seen within this window (heartbeats come every 30 s from visible tabs). */
export const ONLINE_WINDOW_SEC = 65;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let saltCache: { day: string; salt: Buffer; fetchedAt: number } | null = null;

/** Today's (UTC) salt, created on first use. Cached in memory for a minute only. */
export async function dailySalt(redis: Redis, nowMs = Date.now()): Promise<Buffer> {
  const day = utcDay(nowMs);
  if (saltCache && saltCache.day === day && Date.now() - saltCache.fetchedAt < 60_000) return saltCache.salt;
  const key = SALT_KEY(day);
  let salt = await redis.getBuffer(key);
  if (!salt) {
    await redis.set(key, randomBytes(32), "EX", SALT_TTL_SEC, "NX");
    salt = await redis.getBuffer(key);
  }
  if (!salt || salt.length !== 32) throw new Error("Analytics salt unavailable");
  saltCache = { day, salt, fetchedAt: Date.now() };
  return salt;
}

/** Forget the in-memory salt (tests that move the clock). */
export function resetSaltCache() {
  saltCache = null;
}

export function visitorId(salt: Buffer, ip: string, userAgent: string, siteHost: string): Buffer {
  return createHash("sha256").update(salt).update("\0").update(ip).update("\0").update(userAgent).update("\0").update(siteHost).digest().subarray(0, 16);
}

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|curl\/|wget\/|python|httpx|aiohttp|axios|node-fetch|undici|go-http-client|java\/|okhttp|libwww|perl|ruby|php\/|monitor|uptime|pingdom|statuscake|playwright|puppeteer|phantomjs|selenium/i;

export function isBot(userAgent: string): boolean {
  return !userAgent || userAgent.length < 10 || BOT_UA.test(userAgent);
}

export function browserFamily(ua: string): BrowserFamily {
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\b|OPX\//.test(ua)) return "opera";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "firefox";
  if (/\bChrome\/|\bCriOS\//.test(ua)) return "chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "safari";
  return "other";
}

/** Device class: the User-Agent's own mobile/tablet signal first, the viewport bucket otherwise. */
export function deviceType(ua: string, bucket: ViewportBucket | undefined): DeviceType {
  if (/\biPad\b|\bTablet\b|\bKindle\b|\bSilk\//.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua))) return "tablet";
  if (/\bMobi|\biPhone\b|\biPod\b|\bAndroid.+Mobile\b/.test(ua)) return "mobile";
  if (bucket === "s") return "mobile";
  if (bucket === "m") return "tablet";
  return "desktop";
}

/** Path only: no query string, no hash, no repeated or trailing slashes. Null = not countable. */
export function normalizePath(raw: string): string | null {
  let p = raw.split(/[?#]/, 1)[0] ?? "";
  if (!p.startsWith("/") || /\s/.test(p) || [...p].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return null;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p.length > 300) return null;
  return p;
}

/** The operator dashboard and machine endpoints are never counted. */
export function isExcludedPath(p: string): boolean {
  return p === "/admin" || p.startsWith("/admin/") || p === "/api" || p.startsWith("/api/") || p.startsWith("/_next/");
}

/** Host name only (no "www."), or null for internal navigation, IP literals and junk. */
export function referrerHost(raw: string | undefined, ownHostname: string): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  if (/[/:]/.test(host)) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || !/[a-z]/.test(host)) return null;
  if (host === ownHostname.replace(/^www\./, "").toLowerCase()) return null;
  return host;
}

/** Do Not Track or Global Privacy Control: the visit is not counted at all. */
export function optedOut(req: FastifyRequest): boolean {
  return req.headers.dnt === "1" || req.headers["sec-gpc"] === "1";
}

/** Only this site's own pages report visits (browsers send Origin on POST). */
export function fromOwnSite(req: FastifyRequest, publicOrigin: string): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === publicOrigin;
  return req.headers["sec-fetch-site"] === "same-origin";
}

/** Record that a visitor is on `path` right now. Entries expire on their own within 5 minutes. */
export async function touchPresence(redis: Redis, visitor: string, path: string, nowMs = Date.now()): Promise<void> {
  await redis
    .multi()
    .zadd(PRESENCE_KEY, nowMs, visitor)
    .zremrangebyscore(PRESENCE_KEY, "-inf", nowMs - PRESENCE_TTL_SEC * 1000)
    .expire(PRESENCE_KEY, PRESENCE_TTL_SEC)
    .set(PRESENCE_PATH_KEY(visitor), path, "EX", PRESENCE_TTL_SEC)
    .exec();
}

export interface Presence {
  online: number;
  byPath: { path: string; visitors: number }[];
}

export async function readPresence(redis: Redis, nowMs = Date.now()): Promise<Presence> {
  const ids = await redis.zrangebyscore(PRESENCE_KEY, nowMs - ONLINE_WINDOW_SEC * 1000, "+inf");
  if (ids.length === 0) return { online: 0, byPath: [] };
  const paths = await redis.mget(ids.map(PRESENCE_PATH_KEY));
  const counts = new Map<string, number>();
  for (const p of paths) {
    const key = p ?? "(unknown page)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byPath = [...counts.entries()].map(([path, visitors]) => ({ path, visitors })).sort((a, b) => b.visitors - a.visitors || a.path.localeCompare(b.path));
  return { online: ids.length, byPath };
}
