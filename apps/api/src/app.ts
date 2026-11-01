import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { REDACT_PATHS, sanitizeErrorMessage } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { ApiProblem } from "./lib/errors";
import { textForRequest } from "./lib/setup-details";
import type { EventHub } from "./lib/hub";
import { assertCsrf, loadAuth } from "./lib/session";
import { authRoutes } from "./routes/auth";
import { channelRoutes } from "./routes/channels";
import { clipRoutes } from "./routes/clips";
import { eventsubRoutes } from "./routes/eventsub";
import { healthRoutes } from "./routes/health";
import { ingestRoutes } from "./routes/ingest";
import { instantRoutes } from "./routes/instant";
import { libraryRoutes } from "./routes/library";
import { nowRoutes } from "./routes/now";
import { relayRoutes } from "./routes/relay";
import { liveRoutes } from "./routes/live";
import { mediaRoutes } from "./routes/media";
import { momentRoutes } from "./routes/moments";
import { sessionRoutes } from "./routes/sessions";
import { seoRoutes } from "./routes/seo";
import { studioRoutes } from "./routes/studio";
import { trainingRoutes } from "./routes/training";
import { uploadRoutes } from "./routes/uploads";
import { adminRoutes } from "./routes/admin";
import { analyticsRoutes } from "./routes/analytics";
import { contactRoutes } from "./routes/contact";
import { aiViewRoutes } from "./routes/aiview";
import { demoRoutes } from "./routes/demo";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set false on routes that authenticate differently (webhooks, gateway hooks). */
    csrf?: boolean;
  }
}

export interface AppDeps {
  ctx: ServerContext;
  hub: EventHub;
}

export async function buildApp({ ctx, hub }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.config.env.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    trustProxy: ctx.config.env.SLOT1_TRUST_PROXY,
    bodyLimit: 256 * 1024,
    // Signed media tokens are longer than the default 100-character parameter limit.
    routerOptions: { maxParamLength: 2048 },
    disableRequestLogging: ctx.config.env.NODE_ENV === "test",
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false, redis: ctx.redis, nameSpace: "slot1-api-rl:" });
  await app.register(multipart, {
    limits: { fileSize: ctx.config.env.UPLOAD_MAX_BYTES, files: 1, fields: 6, fieldSize: 2000, parts: 8 },
  });

  app.decorateRequest("auth", null as never);
  app.addHook("onRequest", async (req, reply) => {
    req.auth = await loadAuth(ctx, req);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
  });
  app.addHook("preHandler", async (req) => {
    if (req.routeOptions.config.csrf === false) return;
    assertCsrf(ctx, req);
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ApiProblem) {
      // Requirements can name server settings: only operators see those (lib/setup-details.ts).
      // Everyone else's friendly version can be the message itself; then it isn't said twice.
      const text = await textForRequest(ctx, req, err.requirement);
      const same = (x: string) => x.trim().replace(/[.!?]$/, "").toLowerCase();
      const requirement = text && same(text) !== same(err.message) ? text : null;
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, requirement } });
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.status(400).send({ error: { code: "invalid_input", message: `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`, requirement: null } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests — slow down a little", requirement: null } });
    if (e.code === "FST_REQ_FILE_TOO_LARGE" || e.statusCode === 413) {
      return reply.status(413).send({ error: { code: "too_large", message: "File is larger than the upload limit", requirement: null } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? "bad_request", message: sanitizeErrorMessage(e.message), requirement: null } });
    }
    req.log.error({ err: sanitizeErrorMessage(e.message) }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong on our side", requirement: null } });
  });

  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(channelRoutes(ctx));
  await app.register(sessionRoutes(ctx, hub));
  await app.register(uploadRoutes(ctx));
  await app.register(mediaRoutes(ctx));
  await app.register(momentRoutes(ctx));
  await app.register(clipRoutes(ctx));
  await app.register(studioRoutes(ctx));
  await app.register(trainingRoutes(ctx));
  await app.register(eventsubRoutes(ctx));
  await app.register(ingestRoutes(ctx));
  await app.register(liveRoutes(ctx));
  await app.register(libraryRoutes(ctx));
  await app.register(relayRoutes(ctx));
  await app.register(instantRoutes(ctx));
  await app.register(nowRoutes(ctx));
  await app.register(seoRoutes(ctx));
  await app.register(analyticsRoutes(ctx));
  await app.register(contactRoutes(ctx));
  await app.register(adminRoutes(ctx));
  await app.register(aiViewRoutes(ctx));
  await app.register(demoRoutes(ctx));
  return app;
}
