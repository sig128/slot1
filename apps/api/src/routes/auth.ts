import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  clearRelayPermissionWait,
  consumeOAuthState,
  createLocalBroadcaster,
  createLocalUser,
  createOAuthState,
  getBroadcaster,
  getGrant,
  upsertConnection,
  upsertGrant,
  upsertTwitchBroadcaster,
  upsertTwitchUser,
} from "@slot1/db";
import { QUEUES, randomToken, sanitizeErrorMessage, sha256 } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import {
  BOT_SCOPES,
  BROADCASTER_BASE_SCOPES,
  BROADCASTER_CLIP_ANALYSIS_SCOPES,
  BROADCASTER_RELAY_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  missingScopes,
  validateToken,
} from "@slot1/twitch";
import { badRequest, forbidden, unavailable } from "../lib/errors";
import { ensureSession, signIn, signOut } from "../lib/session";

async function currentBroadcasterScopes(ctx: ServerContext, broadcasterId: string | null): Promise<string[]> {
  if (!broadcasterId) return [];
  const b = await getBroadcaster(ctx.db, broadcasterId);
  if (!b?.twitch_user_id) return [];
  const g = await getGrant(ctx.db, "broadcaster", b.twitch_user_id);
  return g && g.status !== "revoked" ? g.scopes : [];
}

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
export function safeReturnTo(v: unknown, fallback = "/studio"): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || v.length > 200) return fallback;
  return v;
}

const StartQuery = z.object({
  role: z.enum(["broadcaster", "bot"]).default("broadcaster"),
  clipAnalysis: z.enum(["0", "1"]).default("0"),
  relay: z.enum(["0", "1"]).default("0"),
  returnTo: z.string().optional(),
});

const CallbackQuery = z.object({
  code: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  scope: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
});

function back(ctx: ServerContext, reply: FastifyReply, path: string, params: Record<string, string>) {
  const q = new URLSearchParams(params).toString();
  return reply.redirect(`${ctx.config.publicOrigin}${path}${path.includes("?") ? "&" : "?"}${q}`, 302);
}

export const authRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /** Begin server-side authorization-code OAuth. State is bound to this browser session. */
    app.get("/api/auth/twitch/start", { config: { csrf: false, rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const q = StartQuery.parse(req.query);
      if (!ctx.oauth || !ctx.config.env.TWITCH_REDIRECT_URI) {
        throw unavailable("Twitch sign-in isn't configured on this deployment", ctx.config.capabilities.twitch.reason);
      }
      if (q.role === "bot" && !req.auth.user?.is_operator) throw forbidden("Only a SLOT1 operator can link the bot account");
      const { idHash } = await ensureSession(ctx, req, reply);
      const state = randomToken(32);
      // Re-authorizing replaces the granted scopes, so keep every optional permission the creator
      // already gave (clip analysis, forwarding) and add the one being asked for now.
      const current = q.role === "bot" ? [] : await currentBroadcasterScopes(ctx, req.auth.broadcaster?.id ?? null);
      const scopes =
        q.role === "bot"
          ? BOT_SCOPES
          : [
              ...new Set([
                ...BROADCASTER_BASE_SCOPES,
                ...current.filter((s) => BROADCASTER_CLIP_ANALYSIS_SCOPES.includes(s) || BROADCASTER_RELAY_SCOPES.includes(s)),
                ...(q.clipAnalysis === "1" ? BROADCASTER_CLIP_ANALYSIS_SCOPES : []),
                ...(q.relay === "1" ? BROADCASTER_RELAY_SCOPES : []),
              ]),
            ];
      await createOAuthState(ctx.db, {
        stateHash: sha256(state),
        sessionIdHash: idHash,
        role: q.role,
        redirectUri: ctx.config.env.TWITCH_REDIRECT_URI,
        scopes,
        returnTo: safeReturnTo(q.returnTo),
      });
      reply.header("cache-control", "no-store");
      return reply.redirect(
        buildAuthorizeUrl({
          idBase: ctx.config.env.TWITCH_ID_BASE,
          clientId: ctx.oauth.clientId,
          redirectUri: ctx.config.env.TWITCH_REDIRECT_URI,
          scopes,
          state,
          // The bot account must be chosen explicitly, never silently reuse the creator's login.
          forceVerify: q.role === "bot",
        }),
        302,
      );
    });

    app.get("/api/auth/twitch/callback", { config: { csrf: false, rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      const q = CallbackQuery.parse(req.query);
      reply.header("cache-control", "no-store");
      if (!ctx.oauth) throw unavailable("Twitch sign-in isn't configured on this deployment", ctx.config.capabilities.twitch.reason);
      if (!q.state || !req.auth.sessionIdHash) throw badRequest("OAuth state mismatch — start the connection again from Studio");
      const st = await consumeOAuthState(ctx.db, sha256(q.state), req.auth.sessionIdHash);
      if (!st) throw badRequest("OAuth state mismatch or expired — start the connection again from Studio");
      if (q.error) return back(ctx, reply, st.return_to ?? "/studio", { twitch: "denied" });
      if (!q.code) throw badRequest("Missing authorization code");

      let tokens;
      try {
        // Exactly the redirect URI used when the flow started.
        tokens = await exchangeCode(ctx.oauth, q.code, st.redirect_uri);
      } catch (err) {
        req.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "code exchange failed");
        return back(ctx, reply, st.return_to ?? "/studio", { twitch: "error" });
      }
      const info = await validateToken(ctx.oauth, tokens.access_token);
      if (!info?.user_id || !info.login) return back(ctx, reply, st.return_to ?? "/studio", { twitch: "error" });
      const scopes = info.scopes ?? tokens.scope;
      const access = ctx.cipher.encrypt(tokens.access_token);
      const refresh = tokens.refresh_token ? ctx.cipher.encrypt(tokens.refresh_token).value : null;

      if (st.role === "bot") {
        const expected = ctx.config.env.SLOT1_BOT_TWITCH_LOGIN?.toLowerCase();
        if (!req.auth.user?.is_operator) throw forbidden("Only a SLOT1 operator can link the bot account");
        if (!expected || info.login.toLowerCase() !== expected) {
          return back(ctx, reply, "/studio", { bot: "wrong_account" });
        }
        const missing = missingScopes(scopes, BOT_SCOPES);
        if (missing.length) return back(ctx, reply, "/studio", { bot: "missing_scopes" });
        await upsertGrant(ctx.db, {
          role: "bot",
          twitchUserId: info.user_id,
          twitchLogin: info.login,
          scopes,
          accessTokenEnc: access.value,
          refreshTokenEnc: refresh,
          keyId: access.keyId,
          expiresInSec: tokens.expires_in ?? null,
        });
        const { rows } = await ctx.db.query<{ broadcaster_id: string }>(`SELECT broadcaster_id FROM broadcaster_connections WHERE status = 'active'`);
        for (const r of rows) await ctx.enqueue(QUEUES.twitch, "eventsub-reconcile", { broadcasterId: r.broadcaster_id, reason: "bot linked" });
        return back(ctx, reply, "/studio", { bot: "linked" });
      }

      // Broadcaster identity. Pasting someone's URL never does this — only their own sign-in.
      let displayName = info.login;
      let avatar: string | null = null;
      if (ctx.helix) {
        const me = await ctx.helix.getTokenUser(tokens.access_token).catch(() => null);
        if (me) {
          displayName = me.display_name;
          avatar = me.profile_image_url || null;
        }
      }
      const isOperator = ctx.config.operatorLogins.has(info.login.toLowerCase());
      const user = await upsertTwitchUser(ctx.db, info.user_id, displayName, isOperator);
      const b = await upsertTwitchBroadcaster(ctx.db, { ownerUserId: user.id, twitchUserId: info.user_id, login: info.login, displayName, avatarUrl: avatar });
      const grant = await upsertGrant(ctx.db, {
        role: "broadcaster",
        twitchUserId: info.user_id,
        twitchLogin: info.login,
        scopes,
        accessTokenEnc: access.value,
        refreshTokenEnc: refresh,
        keyId: access.keyId,
        expiresInSec: tokens.expires_in ?? null,
      });
      await upsertConnection(ctx.db, b.id, grant.id);
      if (BROADCASTER_RELAY_SCOPES.every((s) => scopes.includes(s))) await clearRelayPermissionWait(ctx.db, b.id);
      await signIn(ctx, req, reply, user.id);
      await ctx.enqueue(QUEUES.twitch, "eventsub-reconcile", { broadcasterId: b.id, reason: "connected" });
      return back(ctx, reply, st.return_to ?? "/studio", { twitch: "connected" });
    });

    /** Development-only local creator account so uploads work without Twitch credentials. */
    app.post("/api/auth/local", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      if (!ctx.config.allowLocalLogin) throw forbidden("Local sign-in is disabled on this deployment");
      const body = z.object({ displayName: z.string().trim().min(2).max(40) }).parse(req.body);
      const user = await createLocalUser(ctx.db, body.displayName);
      const slug = body.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 18) || "creator";
      await createLocalBroadcaster(ctx.db, user.id, `${slug}_${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`, body.displayName);
      await signIn(ctx, req, reply, user.id);
      return { ok: true };
    });

    app.post("/api/auth/logout", async (req, reply) => {
      await signOut(ctx, req, reply);
      return { ok: true };
    });
  };

