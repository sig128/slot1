import type { FastifyPluginAsync } from "fastify";
import { ContactRequest } from "@slot1/contracts";
import { insertContactMessage } from "@slot1/db";
import { hmacSha256, RedisLimiter } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { ApiProblem } from "../lib/errors";

/** Five messages per hour from one address. */
export const CONTACT_LIMIT_PER_HOUR = 5;

/**
 * The /contact form. Messages are stored for the operators' inbox in /admin and deleted after 24
 * months. The sender's IP is never stored: the hourly limit is a Redis counter keyed by an HMAC
 * of the IP that expires after an hour.
 */
export const contactRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    const limiter = new RedisLimiter(ctx.redis, "slot1:contact");

    const ipKey = (ip: string) => hmacSha256(ctx.config.sessionSecret, `contact:${ip}`).toString("hex").slice(0, 32);
    const rateLimit = { max: 20, timeWindow: "1 minute", keyGenerator: (req: { ip: string }) => `c:${ipKey(req.ip)}` };

    app.post("/api/contact", { bodyLimit: 32 * 1024, config: { rateLimit } }, async (req, reply) => {
      reply.header("cache-control", "no-store");
      const input = ContactRequest.parse(req.body);
      // Honeypot filled in: answer like a success so the bot learns nothing, and store nothing.
      if (input.website && input.website.trim() !== "") return reply.status(202).send({ ok: true });
      const take = await limiter.take(ipKey(req.ip), CONTACT_LIMIT_PER_HOUR, 3600);
      if (!take.allowed) {
        throw new ApiProblem(429, "rate_limited", `You've sent ${CONTACT_LIMIT_PER_HOUR} messages in the last hour. Try again in about ${Math.max(1, Math.ceil(take.resetSec / 60))} minutes.`);
      }
      await insertContactMessage(ctx.db, { name: input.name ?? null, email: input.email, topic: input.topic, message: input.message });
      return reply.status(202).send({ ok: true });
    });
  };
