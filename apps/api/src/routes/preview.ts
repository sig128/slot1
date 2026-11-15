import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PreviewChannels } from "@slot1/contracts";
import type { ServerContext } from "@slot1/services";
import { requireAdmin } from "../lib/admin-access";
import { getPreviewLogins, normalizePreviewLogins, setPreviewLogins } from "../lib/preview-channels";

/** Admin → Preview channels (lib/preview-channels.ts). Everyone else gets a plain 404. */
export const previewRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/admin/preview-channels", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply): Promise<PreviewChannels> => {
      await requireAdmin(ctx, req, reply);
      return { logins: await getPreviewLogins(ctx) };
    });

    app.put("/api/admin/preview-channels", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply): Promise<PreviewChannels> => {
      await requireAdmin(ctx, req, reply);
      const { logins } = z.object({ logins: z.array(z.string().max(300)).max(20) }).parse(req.body);
      const clean = normalizePreviewLogins(logins);
      await setPreviewLogins(ctx, clean);
      return { logins: clean };
    });
  };
