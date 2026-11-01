import type { FastifyPluginAsync } from "fastify";
import type { DemoInfo } from "@slot1/contracts";
import { demoInfo, type ServerContext } from "@slot1/services";
import { capabilityForReason, publicText, revealsServerSetup } from "@slot1/platform";
import { seesSetupDetails } from "../lib/setup-details";

export const demoRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /** Whether the demo broadcast runs on this server, and where to watch it (docs/DEMO.md). */
    app.get("/api/demo", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply): Promise<DemoInfo> => {
      reply.header("cache-control", "no-store");
      const info = await demoInfo(ctx);
      if (await seesSetupDetails(ctx, req)) {
        // Operators also get the server command that switches the demo on.
        if (!info.enabled && !info.reason) return { ...info, reason: "Nothing is being generated for the demo right now. Switch it on on the server with: slot1 demo on (and off again with: slot1 demo off)" };
        return info;
      }
      if (!info.reason) return info;
      // Visitors never read server settings or commands ("slot1 logs demo"): only operators act on those.
      const caps = ctx.config.capabilities;
      const reason = capabilityForReason(caps, info.reason)
        ? publicText(caps, info.reason)
        : revealsServerSetup(info.reason)
          ? "The demo stream isn't running right now."
          : info.reason;
      return { ...info, reason };
    });
  };
