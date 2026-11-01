import type { FastifyRequest } from "fastify";
import { capabilitiesFor, publicText, reasonFor, type CapabilityKey } from "@slot1/platform";
import type { Capabilities } from "@slot1/contracts";
import type { ServerContext } from "@slot1/services";
import { hasAdminSession } from "./admin-session";

/**
 * Who may see server settings (environment-variable names, setup commands): SLOT1 operators and
 * /admin sessions. Everyone else gets friendly, honest reasons (packages/platform/public-reasons).
 * Cached per request.
 */
export async function seesSetupDetails(ctx: ServerContext, req: FastifyRequest): Promise<boolean> {
  const r = req as FastifyRequest & { slot1SetupDetails?: boolean };
  if (r.slot1SetupDetails === undefined) {
    r.slot1SetupDetails = Boolean(req.auth?.user?.is_operator) || (await hasAdminSession(ctx.redis, req).catch(() => false));
  }
  return r.slot1SetupDetails;
}

export async function capabilitiesForRequest(ctx: ServerContext, req: FastifyRequest): Promise<Capabilities> {
  return capabilitiesFor(ctx.config.capabilities, await seesSetupDetails(ctx, req));
}

/** A capability's unavailable reason, phrased for whoever is asking. */
export async function reasonForRequest(ctx: ServerContext, req: FastifyRequest, key: CapabilityKey): Promise<string | null> {
  return reasonFor(ctx.config.capabilities, key, await seesSetupDetails(ctx, req));
}

/** Any stored or computed text: unchanged for operators, without server settings for everyone else. */
export async function textForRequest(ctx: ServerContext, req: FastifyRequest, text: string | null | undefined, fallback?: string): Promise<string | null> {
  if (!text) return text ?? null;
  return (await seesSetupDetails(ctx, req)) ? text : publicText(ctx.config.capabilities, text, fallback);
}
