import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  clearRelayPermissionWait,
  consumeOAuthState,
  createLocalBroadcaster,
  createLocalUser,
  createOAuthState,
  listSources,
  upsertConnection,
  upsertGrant,
  upsertKickBroadcaster,
  upsertKickUser,
  upsertTwitchBroadcaster,
  upsertTwitchUser,
} from "@slot1/db";
import { QUEUES, randomToken, sanitizeErrorMessage, sha256 } from "@slot1/platform";
import type { TwitchSignInWhy } from "@slot1/contracts";
import {
  KICK_CREATOR_SCOPES,
  KICK_VIEWER_SCOPES,
  KickApiError,
  kickAuthorizeUrl,
  kickConfigured,
  kickExchangeCode,
  kickPkce,
  kickRedirectUri,
  kickRevoke,
  kickTokenChannel,
  kickTokenUser,
  type ServerContext,
} from "@slot1/services";
import {
  BOT_SCOPES,
  BROADCASTER_CONNECT_SCOPES,
  BROADCASTER_RELAY_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  missingScopes,
  TwitchAuthError,
  validateToken,
} from "@slot1/twitch";
import { forbidden } from "../lib/errors";
import { ensureSession, signIn, signOut } from "../lib/session";
import { classifyExchangeError, recordSignInEvent } from "../lib/signin-events";

/** Where new streamers land after connecting: Studio → Stream setup's guided OBS setup. */
export const ONBOARDING_PATH = "/studio?tab=stream&onboarding=1";

/**
 * After "Connect my Twitch": a creator who hasn't set up streaming yet goes straight into the
 * guided OBS setup. Everyone else, and every flow that asked for a specific page, returns there.
 */
async function connectLanding(ctx: ServerContext, broadcasterId: string, returnTo: string | null): Promise<string> {
  const dest = returnTo ?? "/studio";
  if (dest !== "/studio" || !ctx.config.capabilities.ingest.available) return dest;
  const sources = await listSources(ctx.db, broadcasterId);
  return sources.some((s) => s.kind === "live_ingest" && s.status !== "revoked" && !s.revoked_at) ? dest : ONBOARDING_PATH;
}

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
export function safeReturnTo(v: unknown, fallback = "/studio"): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || v.length > 200) return fallback;
  return v;
}

/**
 * "viewer": Sign in with Twitch only to chat on SLOT1. Identity only (OpenID): no channel is
 * connected, no permission is asked for, and Twitch's token is not kept.
 */
const VIEWER_SCOPES = ["openid"];

const StartQuery = z.object({
  role: z.enum(["broadcaster", "bot", "viewer"]).default("broadcaster"),
  clipAnalysis: z.enum(["0", "1"]).default("0"),
  relay: z.enum(["0", "1"]).default("0"),
  returnTo: z.string().optional(),
});

/** Sign in with Kick: a creator connecting their Kick channel, or a viewer signing in to chat. */
const KickStartQuery = z.object({
  role: z.enum(["broadcaster", "viewer"]).default("broadcaster"),
  returnTo: z.string().optional(),
});

/** Why a Kick sign-in didn't finish, as ?kick=error&why=<code> on the page it returns to. */
export type KickSignInWhy = "not_configured" | "expired" | "code" | "app" | "kick_down" | "no_channel" | "server";

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
      const parsed = StartQuery.safeParse(req.query);
      const q = parsed.success ? parsed.data : StartQuery.parse({});
      reply.header("cache-control", "no-store");
      // Every "Sign in with Twitch" button links here, so when sign-in isn't set up the person goes
      // back to a page that says so, not to an error document.
      if (!ctx.oauth || !ctx.config.env.TWITCH_REDIRECT_URI) {
        return back(ctx, reply, safeReturnTo(q.returnTo), { twitch: "error", why: "not_configured" });
      }
      if (q.role === "bot" && !req.auth.user?.is_operator) throw forbidden("Only a SLOT1 operator can link the bot account");
      const { idHash } = await ensureSession(ctx, req, reply);
      const state = randomToken(32);
      // One approval for everything a creator uses: chat bot, live clips, clip analysis and
      // forwarding. Re-authorizing replaces the granted scopes, so asking for the full set every
      // time also means a reconnect never drops one. (Older links still send clipAnalysis=1 or
      // relay=1; those scopes are included anyway.)
      const scopes = q.role === "bot" ? BOT_SCOPES : q.role === "viewer" ? VIEWER_SCOPES : BROADCASTER_CONNECT_SCOPES;
      await createOAuthState(ctx.db, {
        stateHash: sha256(state),
        sessionIdHash: idHash,
        role: q.role,
        redirectUri: ctx.config.env.TWITCH_REDIRECT_URI,
        scopes,
        returnTo: safeReturnTo(q.returnTo, q.role === "viewer" ? "/" : "/studio"),
      });
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
      const parsed = CallbackQuery.safeParse(req.query);
      const q = parsed.success ? parsed.data : {};
      reply.header("cache-control", "no-store");
      // Every way this can go wrong ends on a page that says what happened (Studio reads
      // ?twitch=error&why=...), and is kept for /admin and /status.
      const fail = async (path: string, why: TwitchSignInWhy, detail: string | null = null) => {
        await recordSignInEvent(ctx.redis, { outcome: why === "denied" ? "denied" : "error", why, detail });
        return back(ctx, reply, path, why === "denied" ? { twitch: "denied" } : { twitch: "error", why });
      };
      if (!ctx.oauth) return fail("/studio", "not_configured");
      // No state, or one from another browser, tab or an old link: start again.
      if (!q.state || !req.auth.sessionIdHash) return fail("/studio", "expired");
      const st = await consumeOAuthState(ctx.db, sha256(q.state), req.auth.sessionIdHash);
      if (!st) return fail("/studio", "expired");
      const returnTo = st.return_to ?? "/studio";
      if (q.error) return fail(st.role === "bot" ? "/studio" : returnTo, "denied", sanitizeErrorMessage(q.error_description ?? q.error));
      if (!q.code) return fail(returnTo, "code");

      let tokens;
      try {
        // Exactly the redirect URI used when the flow started.
        tokens = await exchangeCode(ctx.oauth, q.code, st.redirect_uri);
      } catch (err) {
        const status = err instanceof TwitchAuthError ? err.status : 0;
        const twitchSaid = sanitizeErrorMessage(err instanceof TwitchAuthError ? (err.twitchMessage ?? err.message) : (err as Error).message);
        const why = classifyExchangeError(status, twitchSaid);
        req.log.warn({ status, twitch: twitchSaid, why }, "Twitch sign-in: code exchange failed");
        return fail(returnTo, why, `Twitch answered ${status || "nothing"}: ${twitchSaid}`);
      }
      let info;
      try {
        info = await validateToken(ctx.oauth, tokens.access_token);
      } catch (err) {
        req.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "Twitch sign-in: token check failed");
        return fail(returnTo, "twitch_down", sanitizeErrorMessage((err as Error).message));
      }
      if (!info?.user_id || !info.login) return fail(returnTo, "twitch_down", "Twitch's token check named no account");
      const scopes = info.scopes ?? tokens.scope;

      if (st.role === "viewer") {
        // Chat sign-in: who you are on Twitch, nothing else. The token is used once, then dropped.
        try {
          let displayName = info.login;
          if (ctx.helix) {
            const me = await ctx.helix.getTokenUser(tokens.access_token).catch(() => null);
            if (me) displayName = me.display_name;
          }
          const user = await upsertTwitchUser(ctx.db, info.user_id, displayName, ctx.config.operatorLogins.has(info.login.toLowerCase()));
          await signIn(ctx, req, reply, user.id);
          return back(ctx, reply, returnTo, { twitch: "signed_in" });
        } catch (err) {
          req.log.error({ err }, "Twitch sign-in (chat): saving the user failed");
          return fail(returnTo, "server", sanitizeErrorMessage((err as Error).message));
        }
      }

      try {
        const access = ctx.cipher.encrypt(tokens.access_token);
        const refresh = tokens.refresh_token ? ctx.cipher.encrypt(tokens.refresh_token).value : null;

        if (st.role === "bot") {
          const expected = ctx.config.env.SLOT1_BOT_TWITCH_LOGIN?.toLowerCase();
          if (!req.auth.user?.is_operator) return back(ctx, reply, "/studio", { bot: "not_admin" });
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
        await recordSignInEvent(ctx.redis, { outcome: "connected" });
        return back(ctx, reply, await connectLanding(ctx, b.id, st.return_to), { twitch: "connected" });
      } catch (err) {
        req.log.error({ err }, "Twitch sign-in: saving the connection failed");
        return fail(st.role === "bot" ? "/studio" : returnTo, "server", sanitizeErrorMessage((err as Error).message));
      }
    });

    /**
     * Sign in with Kick (OAuth 2.1 with PKCE). The same two ways in as Twitch: a creator connects
     * their Kick channel (it becomes /watch/kick-<slug> with Studio, streaming to SLOT1 and the live
     * log), or a viewer signs in only to chat. Kick's token is used to read who you are, then revoked.
     */
    app.get("/api/auth/kick/start", { config: { csrf: false, rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const parsed = KickStartQuery.safeParse(req.query);
      const q = parsed.success ? parsed.data : KickStartQuery.parse({});
      reply.header("cache-control", "no-store");
      const returnTo = safeReturnTo(q.returnTo, q.role === "viewer" ? "/" : "/studio");
      if (!kickConfigured(ctx) || !ctx.cipher.available) return back(ctx, reply, returnTo, { kick: "error", why: "not_configured" });
      const { idHash } = await ensureSession(ctx, req, reply);
      const state = randomToken(32);
      const { verifier, challenge } = kickPkce();
      const scopes = q.role === "viewer" ? KICK_VIEWER_SCOPES : KICK_CREATOR_SCOPES;
      await createOAuthState(ctx.db, {
        stateHash: sha256(state),
        sessionIdHash: idHash,
        role: q.role,
        redirectUri: kickRedirectUri(ctx),
        scopes,
        returnTo,
        provider: "kick",
        pkceVerifierEnc: ctx.cipher.encrypt(verifier).value,
      });
      return reply.redirect(kickAuthorizeUrl(ctx, { scopes, state, challenge }), 302);
    });

    app.get("/api/auth/kick/callback", { config: { csrf: false, rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      const parsed = CallbackQuery.safeParse(req.query);
      const q = parsed.success ? parsed.data : {};
      reply.header("cache-control", "no-store");
      const fail = (path: string, why: KickSignInWhy | "denied", detail: string | null = null) => {
        if (detail) req.log.warn({ kick: why, detail }, "Kick sign-in didn't finish");
        return back(ctx, reply, path, why === "denied" ? { kick: "denied" } : { kick: "error", why });
      };
      if (!kickConfigured(ctx)) return fail("/studio", "not_configured");
      if (!q.state || !req.auth.sessionIdHash) return fail("/studio", "expired");
      const st = await consumeOAuthState(ctx.db, sha256(q.state), req.auth.sessionIdHash, "kick");
      if (!st || !st.pkce_verifier_enc) return fail("/studio", "expired");
      const returnTo = st.return_to ?? "/studio";
      if (q.error) return fail(returnTo, "denied", sanitizeErrorMessage(q.error_description ?? q.error));
      if (!q.code) return fail(returnTo, "code");

      let token: string;
      try {
        const verifier = ctx.cipher.decrypt(st.pkce_verifier_enc);
        token = (await kickExchangeCode(ctx, { code: q.code, verifier, redirectUri: st.redirect_uri })).access_token;
      } catch (err) {
        const status = err instanceof KickApiError ? err.status : 0;
        // 401: Kick didn't accept the app's credentials. Other 4xx: the code was used or expired.
        const why: KickSignInWhy = status === 401 ? "app" : status >= 400 && status < 500 ? "code" : "kick_down";
        return fail(returnTo, why, sanitizeErrorMessage((err as Error).message));
      }

      try {
        let me;
        let channel = null;
        try {
          me = await kickTokenUser(ctx, token);
          if (st.role === "broadcaster") channel = await kickTokenChannel(ctx, token);
        } catch (err) {
          return fail(returnTo, "kick_down", sanitizeErrorMessage((err as Error).message));
        }
        if (st.role === "viewer") {
          const user = await upsertKickUser(ctx.db, me.userId, me.name);
          await signIn(ctx, req, reply, user.id);
          return back(ctx, reply, returnTo, { kick: "signed_in" });
        }
        if (!channel) return fail(returnTo, "no_channel");
        const user = await upsertKickUser(ctx.db, me.userId, me.name);
        const b = await upsertKickBroadcaster(ctx.db, { ownerUserId: user.id, kickUserId: channel.userId ?? me.userId, slug: channel.slug, displayName: me.name, avatarUrl: me.avatarUrl });
        await signIn(ctx, req, reply, user.id);
        return back(ctx, reply, await connectLanding(ctx, b.id, st.return_to), { kick: "connected" });
      } catch (err) {
        req.log.error({ err }, "Kick sign-in: saving the account failed");
        return fail(returnTo, "server", sanitizeErrorMessage((err as Error).message));
      } finally {
        void kickRevoke(ctx, token);
      }
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

