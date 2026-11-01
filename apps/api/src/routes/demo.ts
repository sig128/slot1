import type { FastifyPluginAsync } from "fastify";
import type { DemoInfo } from "@slot1/contracts";
import { demoInfo, type ServerContext } from "@slot1/services";

export const demoRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /** Whether the demo broadcast runs on this server, and where to watch it (docs/DEMO.md). */
    app.get("/api/demo", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (_req, reply): Promise<DemoInfo> => {
      reply.header("cache-control", "no-store");
      return demoInfo(ctx);
    });
  };
