import type { FastifyPluginAsync } from "fastify";
import { AdminWipeRequest, WIPE_CONFIRM_WORD, type AdminWipeResponse, type WipeStatus } from "@slot1/contracts";
import { streamsSendingVideo, wipeCounts } from "@slot1/db";
import { QUEUES } from "@slot1/platform";
import { readWipeStatus, writeWipeStatus, type ServerContext } from "@slot1/services";
import { requireAdmin } from "../lib/admin-access";
import { ApiProblem } from "../lib/errors";

/**
 * Admin → Wipe data (services/wipe.ts): what is stored now, and a confirmed request to delete what
 * the AI found and learned. Streams stay. Everyone else gets a plain 404 from requireAdmin.
 */
export const wipeRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/admin/wipe", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply): Promise<AdminWipeResponse> => {
      await requireAdmin(ctx, req, reply);
      const [counts, status, liveVideo] = await Promise.all([wipeCounts(ctx.db), readWipeStatus(ctx.redis), streamsSendingVideo(ctx.db)]);
      return { counts, status, liveVideo };
    });

    app.post("/api/admin/wipe", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply): Promise<AdminWipeResponse> => {
      const who = await requireAdmin(ctx, req, reply);
      if (!AdminWipeRequest.safeParse(req.body ?? {}).success) throw new ApiProblem(400, "confirm_needed", `Type ${WIPE_CONFIRM_WORD} to confirm.`);
      const current = await readWipeStatus(ctx.redis);
      if (current.state === "queued" || current.state === "running") throw new ApiProblem(409, "wipe_running", "A wipe is already running.");
      const liveVideo = await streamsSendingVideo(ctx.db);
      if (liveVideo > 0) {
        throw new ApiProblem(409, "streaming_now", "Someone is sending video to SLOT1 right now. Wipe once that stream has ended.");
      }
      const requestedAt = new Date().toISOString();
      const status: WipeStatus = { ...current, state: "queued", requestedAt, error: null };
      await writeWipeStatus(ctx.redis, status);
      await ctx.enqueue(QUEUES.maintenance, "wipe-data", { requestedAt }, { jobId: `wipe-${Date.parse(requestedAt)}` });
      req.log.warn({ admin: who }, "admin wipe requested");
      reply.status(202);
      return { counts: await wipeCounts(ctx.db), status, liveVideo };
    });
  };
