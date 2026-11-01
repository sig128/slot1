import type { FastifyPluginAsync } from "fastify";
import type { MeResponse } from "@slot1/contracts";
import { toBroadcasterRef } from "@slot1/db";
import type { ServerContext } from "@slot1/services";
import { ensureSession } from "../lib/session";
import { capabilitiesForRequest } from "../lib/setup-details";

export const healthRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/health", async () => {
      const checks: Record<string, string> = {};
      try {
        await ctx.db.query("SELECT 1");
        checks.database = "ok";
      } catch {
        checks.database = "unavailable";
      }
      try {
        await ctx.redis.ping();
        checks.redis = "ok";
      } catch {
        checks.redis = "unavailable";
      }
      return { ok: Object.values(checks).every((v) => v === "ok"), checks };
    });

    /**
     * What works on this deployment. Operators (and /admin sessions) also get the exact missing
     * server settings and the command that fixes them; everyone else gets friendly reasons only.
     */
    app.get("/api/capabilities", async (req, reply) => {
      reply.header("cache-control", "private, no-store").header("vary", "cookie");
      return capabilitiesForRequest(ctx, req);
    });

    app.get("/api/me", async (req, reply): Promise<MeResponse> => {
      const { csrf } = await ensureSession(ctx, req, reply);
      reply.header("cache-control", "no-store");
      const u = req.auth.user;
      return {
        user: u ? { id: u.id, displayName: u.display_name, kind: u.kind, isOperator: u.is_operator } : null,
        broadcaster: req.auth.broadcaster ? toBroadcasterRef(req.auth.broadcaster) : null,
        csrfToken: csrf,
      };
    });
  };
