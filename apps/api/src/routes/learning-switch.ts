import type { FastifyPluginAsync } from "fastify";
import { AdminLearningRequest, type AdminLearning } from "@slot1/contracts";
import { readLearningSwitch, writeLearningSwitch, type ServerContext } from "@slot1/services";
import { requireAdmin } from "../lib/admin-access";
import { ApiProblem } from "../lib/errors";
import { clearPreviewCache } from "../lib/preview-channels";
import { clearLearningCache } from "./learning";

/**
 * Admin → Learning: whether SLOT1 watches and learns from the featured channels' live streams
 * (services/learning-switch.ts). Off until an admin turns it on. Everyone else gets a plain 404.
 */
export const learningSwitchRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/admin/learning", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply): Promise<AdminLearning> => {
      await requireAdmin(ctx, req, reply);
      return readLearningSwitch(ctx.redis);
    });

    app.put("/api/admin/learning", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply): Promise<AdminLearning> => {
      const who = await requireAdmin(ctx, req, reply);
      const body = AdminLearningRequest.safeParse(req.body ?? {});
      if (!body.success) throw new ApiProblem(400, "bad_request", "Say whether learning should be on or off.");
      const value = await writeLearningSwitch(ctx.redis, body.data.on);
      // The cards and the Learning page say whether SLOT1 is learning: show the change right away.
      clearPreviewCache();
      clearLearningCache();
      req.log.warn({ admin: who, on: value.on }, value.on ? "admin turned learning on" : "admin turned learning off");
      return value;
    });
  };
