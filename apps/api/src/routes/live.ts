import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { LiveVideoResponse } from "@slot1/contracts";
import { listSources } from "@slot1/db";
import { signPayload, verifyPayload } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { reasonForRequest } from "../lib/setup-details";
import { authorizeSession } from "./sessions";

/** Viewer tokens are short-lived; the player fetches a fresh one for every (re)connect. */
export const LIVE_VIDEO_TOKEN_TTL_SEC = 120;

interface WhepClaims extends Record<string, unknown> {
  t: "whep";
  /** Gateway path the token is valid for, e.g. live/abcd1234. */
  p: string;
  exp: number;
}

export function issueWhepToken(ctx: ServerContext, path: string, nowMs = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + LIVE_VIDEO_TOKEN_TTL_SEC;
  const claims: WhepClaims = { t: "whep", p: path, exp };
  return { token: signPayload(ctx.config.sessionSecret, claims), expiresAt: new Date(exp * 1000).toISOString() };
}

/** True only for an unexpired viewer token issued for exactly this gateway path. */
export function verifyWhepToken(ctx: ServerContext, token: string, path: string, nowMs = Date.now()): boolean {
  const v = verifyPayload<WhepClaims>(ctx.config.sessionSecret, token, nowMs);
  return v.ok && v.payload.t === "whep" && v.payload.p === path;
}

const unavailable = (reason: string): LiveVideoResponse => ({ available: false, reason, whepUrl: null, token: null, expiresAt: null });

export const liveRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * Permission to play a session's SLOT1-hosted live video over WebRTC (WHEP). Authorized like
     * every other session route: owners always, everyone else only for public sessions.
     */
    app.get("/api/sessions/:id/live-video", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply): Promise<LiveVideoResponse> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { session } = await authorizeSession(ctx, req, id);
      reply.header("cache-control", "no-store");
      const cap = ctx.config.capabilities.liveVideo;
      if (!cap.available) return unavailable((await reasonForRequest(ctx, req, "liveVideo")) ?? "SLOT1's own live video isn't switched on yet");
      if (session.ended_at) return unavailable("This session has ended");
      const sources = await listSources(ctx.db, session.broadcaster_id);
      const live = sources.find(
        (s) => s.kind === "live_ingest" && s.session_id === session.id && s.status === "publishing" && !s.revoked_at && s.publish_path,
      );
      if (!live?.publish_path) {
        return unavailable(
          session.kind === "ingest" ? "The creator isn't sending video to SLOT1 right now" : "This channel doesn't send its video to SLOT1, so only Twitch's player is available",
        );
      }
      const base = (ctx.config.env.INGEST_PUBLIC_WEBRTC_URL ?? "").replace(/\/$/, "");
      const { token, expiresAt } = issueWhepToken(ctx, live.publish_path);
      return { available: true, reason: null, whepUrl: `${base}/${live.publish_path}/whep`, token, expiresAt };
    });
  };
