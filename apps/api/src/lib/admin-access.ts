import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminOverview } from "@slot1/contracts";
import type { ServerContext } from "@slot1/services";
import { readAdminSession } from "./admin-session";
import { notFound } from "./errors";

export type AdminAccess = AdminOverview["access"];

/** Who may use /admin: an operator signed in with Twitch, or an admin session (password or one-time link). */
export async function adminAccess(ctx: ServerContext, req: FastifyRequest): Promise<AdminAccess | null> {
  if (req.auth.user?.is_operator) return "operator";
  const session = await readAdminSession(ctx.redis, req);
  if (session) return session.via === "password" ? "admin_password" : "admin_link";
  return null;
}

/** Everyone else gets a plain 404, so /admin's API doesn't even say it exists. */
export async function requireAdmin(ctx: ServerContext, req: FastifyRequest, reply: FastifyReply): Promise<AdminAccess> {
  const a = await adminAccess(ctx, req);
  if (!a) throw notFound();
  reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
  return a;
}
