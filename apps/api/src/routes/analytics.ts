import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { AnalyticsCollect, AnalyticsPing } from "@slot1/contracts";
import { insertPageView } from "@slot1/db";
import { hmacSha256 } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import {
  browserFamily,
  dailySalt,
  deviceType,
  fromOwnSite,
  isBot,
  isExcludedPath,
  normalizePath,
  optedOut,
  referrerHost,
  touchPresence,
  visitorId,
} from "../lib/visitors";

/**
 * Cookieless page-view counting for /admin (docs/ADMIN.md). The browser's Beacon posts here with
 * navigator.sendBeacon (a text/plain JSON body). Every answer is an empty 204, counted or not,
 * so nothing about the decision leaks. Analytics never breaks a page: storage errors are logged
 * and swallowed.
 */
export const analyticsRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    const origin = new URL(ctx.config.publicOrigin);
    // The site host goes into the visitor hash, so two deployments never share visitor IDs.
    const siteHost = origin.host;

    function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> | null {
      let value = body;
      if (typeof body === "string") {
        try {
          value = JSON.parse(body);
        } catch {
          return null;
        }
      }
      const r = schema.safeParse(value);
      return r.success ? r.data : null;
    }

    /** Who may be counted: analytics on, no DNT/GPC, our own pages, a real browser. */
    function countable(req: FastifyRequest): { ua: string } | null {
      if (!ctx.config.env.SLOT1_ANALYTICS || optedOut(req) || !fromOwnSite(req, ctx.config.publicOrigin)) return null;
      const ua = String(req.headers["user-agent"] ?? "");
      return isBot(ua) ? null : { ua };
    }

    const done = (reply: FastifyReply) => reply.header("cache-control", "no-store").status(204).send();
    // The limiter's Redis key is an HMAC of the address, so not even the 1-minute counter holds an IP.
    const keyGenerator = (req: FastifyRequest) => `a:${hmacSha256(ctx.config.sessionSecret, `rl:${req.ip}`).toString("base64url").slice(0, 22)}`;
    const routeOpts = (max: number) => ({ bodyLimit: 2048, config: { csrf: false, rateLimit: { max, timeWindow: "1 minute", keyGenerator } } });

    app.post("/api/analytics/collect", routeOpts(60), async (req, reply) => {
      const who = countable(req);
      const body = who ? parse(AnalyticsCollect, req.body) : null;
      const path = body ? normalizePath(body.p) : null;
      if (!who || !body || !path || isExcludedPath(path)) return done(reply);
      try {
        const id = visitorId(await dailySalt(ctx.redis), req.ip, who.ua, siteHost);
        await insertPageView(ctx.db, {
          path,
          referrerHost: referrerHost(body.r, origin.hostname),
          device: deviceType(who.ua, body.b),
          browser: browserFamily(who.ua),
          visitorId: id,
        });
        await touchPresence(ctx.redis, id.toString("hex"), path);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "page view not counted");
      }
      return done(reply);
    });

    app.post("/api/analytics/ping", routeOpts(30), async (req, reply) => {
      const who = countable(req);
      const body = who ? parse(AnalyticsPing, req.body) : null;
      const path = body ? normalizePath(body.p) : null;
      if (!who || !body || !path || isExcludedPath(path)) return done(reply);
      try {
        const id = visitorId(await dailySalt(ctx.redis), req.ip, who.ua, siteHost);
        await touchPresence(ctx.redis, id.toString("hex"), path);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "heartbeat not recorded");
      }
      return done(reply);
    });
  };
