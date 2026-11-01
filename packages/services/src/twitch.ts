import {
  clearAppToken,
  deleteEventSubSubscriptionRow,
  getAppToken,
  getBotGrant,
  getBroadcaster,
  getConnection,
  getGrant,
  getSettings,
  listActiveGrants,
  listEventSubSubscriptions,
  markDisconnected,
  markGrantValidated,
  recordOpsError,
  revokeAllIngestSources,
  saveAppToken,
  setGrantStatus,
  updateGrantTokens,
  upsertEventSubSubscription,
  type GrantRow,
} from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import {
  getAppAccessToken,
  HelixError,
  refreshUserToken,
  requiredSubscriptions,
  revokeToken,
  TwitchAuthError,
  validateToken,
} from "@slot1/twitch";
import type { ServerContext } from "./context";

export class GrantUnavailableError extends Error {
  constructor(
    message: string,
    readonly requirement: string,
  ) {
    super(message);
  }
}

export class TwitchNotConfiguredError extends Error {
  constructor(readonly requirement: string) {
    super(requirement);
  }
}

function requireTwitch(ctx: ServerContext) {
  if (!ctx.helix || !ctx.oauth) throw new TwitchNotConfiguredError(ctx.config.capabilities.twitch.reason ?? "Twitch is not configured");
  return { helix: ctx.helix, oauth: ctx.oauth };
}

/* ------------------------------------------------------------------------------------------ */
/* App access token (client credentials)                                                      */
/* ------------------------------------------------------------------------------------------ */

export async function appToken(ctx: ServerContext, forceNew = false): Promise<string> {
  const { oauth } = requireTwitch(ctx);
  if (!forceNew) {
    const cached = await getAppToken(ctx.db, oauth.clientId);
    if (cached) return ctx.cipher.decrypt(cached.access_token_enc);
  }
  const t = await getAppAccessToken(oauth);
  const enc = ctx.cipher.encrypt(t.accessToken);
  await saveAppToken(ctx.db, oauth.clientId, enc.value, enc.keyId, t.expiresIn);
  return t.accessToken;
}

/** Run a Helix call with the app token; regenerate it once on 401. */
export async function withAppToken<T>(ctx: ServerContext, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await appToken(ctx));
  } catch (err) {
    if (err instanceof HelixError && err.isUnauthorized) {
      await clearAppToken(ctx.db, ctx.oauth!.clientId);
      return fn(await appToken(ctx, true));
    }
    throw err;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* User tokens (broadcaster / bot)                                                             */
/* ------------------------------------------------------------------------------------------ */

async function refreshGrant(ctx: ServerContext, grant: GrantRow): Promise<string> {
  const { oauth } = requireTwitch(ctx);
  if (!grant.refresh_token_enc) {
    await setGrantStatus(ctx.db, grant.id, "refresh_failed", "No refresh token stored");
    throw new GrantUnavailableError("Twitch authorization expired", "Reconnect Twitch in Studio");
  }
  try {
    const t = await refreshUserToken(oauth, ctx.cipher.decrypt(grant.refresh_token_enc));
    const access = ctx.cipher.encrypt(t.access_token);
    const refresh = t.refresh_token ? ctx.cipher.encrypt(t.refresh_token).value : null;
    await updateGrantTokens(ctx.db, grant.id, {
      accessTokenEnc: access.value,
      refreshTokenEnc: refresh,
      keyId: access.keyId,
      expiresInSec: t.expires_in ?? null,
      scopes: t.scope.length ? t.scope : grant.scopes,
    });
    return t.access_token;
  } catch (err) {
    if (err instanceof TwitchAuthError && err.code === "invalid_grant") {
      // The user revoked SLOT1 or the refresh token is no longer valid: disconnect safely.
      await setGrantStatus(ctx.db, grant.id, "revoked", "Twitch rejected the refresh token");
      throw new GrantUnavailableError("Twitch authorization was revoked", "Reconnect Twitch in Studio");
    }
    await setGrantStatus(ctx.db, grant.id, "refresh_failed", sanitizeErrorMessage((err as Error).message));
    throw new GrantUnavailableError("Could not refresh Twitch authorization", "Try again later or reconnect Twitch in Studio");
  }
}

export async function userToken(ctx: ServerContext, role: "broadcaster" | "bot", twitchUserId: string): Promise<{ token: string; grant: GrantRow }> {
  requireTwitch(ctx);
  const grant = role === "bot" ? await getBotGrant(ctx.db) : await getGrant(ctx.db, role, twitchUserId);
  if (!grant) throw new GrantUnavailableError(role === "bot" ? "SLOT1 bot account is not linked" : "Twitch is not connected", "Connect Twitch in Studio");
  if (grant.status === "revoked") throw new GrantUnavailableError("Twitch authorization was revoked", "Reconnect Twitch in Studio");
  const expiresSoon = grant.access_expires_at !== null && grant.access_expires_at.getTime() - Date.now() < 5 * 60_000;
  if (expiresSoon || grant.status === "refresh_failed") return { token: await refreshGrant(ctx, grant), grant };
  return { token: ctx.cipher.decrypt(grant.access_token_enc), grant };
}

/** Run a Helix call with a user token; on 401 refresh once and retry. */
export async function withUserToken<T>(ctx: ServerContext, role: "broadcaster" | "bot", twitchUserId: string, fn: (token: string, grant: GrantRow) => Promise<T>): Promise<T> {
  const { token, grant } = await userToken(ctx, role, twitchUserId);
  try {
    return await fn(token, grant);
  } catch (err) {
    if (err instanceof HelixError && err.isUnauthorized) {
      const fresh = await refreshGrant(ctx, grant);
      return fn(fresh, grant);
    }
    throw err;
  }
}

/**
 * Twitch requires apps to validate tokens on startup and hourly. Invalid tokens are refreshed;
 * if refresh fails the grant is marked revoked and the channel's features are switched off.
 */
export async function validateAllGrants(ctx: ServerContext): Promise<{ checked: number; refreshed: number; revoked: number }> {
  const { oauth } = requireTwitch(ctx);
  let refreshed = 0;
  let revoked = 0;
  const grants = await listActiveGrants(ctx.db);
  for (const g of grants) {
    try {
      const v = await validateToken(oauth, ctx.cipher.decrypt(g.access_token_enc));
      if (v) {
        await markGrantValidated(ctx.db, g.id, v.scopes ?? g.scopes, v.expires_in);
        continue;
      }
      await refreshGrant(ctx, g);
      refreshed += 1;
    } catch (err) {
      if (err instanceof GrantUnavailableError) {
        revoked += 1;
        await recordOpsError(ctx.db, null, "twitch-auth", `Grant for ${g.twitch_login} (${g.role}) needs reconnecting: ${err.message}`);
      } else {
        ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message), grant: g.id }, "grant validation failed");
      }
    }
  }
  return { checked: grants.length, refreshed, revoked };
}

/* ------------------------------------------------------------------------------------------ */
/* EventSub reconciliation                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Make Twitch's subscriptions for a broadcaster match exactly what SLOT1 needs right now.
 * Called on connect/disconnect, settings changes, revocations and service start.
 */
export async function reconcileEventSub(ctx: ServerContext, broadcasterId: string): Promise<{ created: string[]; deleted: string[]; skipped: string | null }> {
  const env = ctx.config.env;
  if (!ctx.config.capabilities.eventsub.available) return { created: [], deleted: [], skipped: ctx.config.capabilities.eventsub.reason };
  const { helix } = requireTwitch(ctx);
  const b = await getBroadcaster(ctx.db, broadcasterId);
  const conn = await getConnection(ctx.db, broadcasterId);
  const created: string[] = [];
  const deleted: string[] = [];
  const existing = b?.twitch_user_id ? await withAppToken(ctx, (t) => helix.listEventSubSubscriptions(t, { userId: b.twitch_user_id! })) : [];
  const ours = existing.filter((s) => s.transport.method === "webhook" && s.transport.callback === env.TWITCH_EVENTSUB_CALLBACK_URL);

  let wanted: ReturnType<typeof requiredSubscriptions> = [];
  if (b?.twitch_user_id && conn?.status === "active") {
    const settings = await getSettings(ctx.db, broadcasterId);
    const bot = await getBotGrant(ctx.db);
    wanted = requiredSubscriptions(b.twitch_user_id, bot?.status === "active" ? bot.twitch_user_id : null, settings.botEnabled && !settings.botKilled);
  }
  const key = (s: { type: string; version: string; condition: Record<string, string> }) =>
    `${s.type}@${s.version}:${Object.entries(s.condition)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(",")}`;
  const wantedKeys = new Set(wanted.map(key));
  for (const s of ours) {
    const healthy = s.status === "enabled" || s.status === "webhook_callback_verification_pending";
    if (!wantedKeys.has(key(s)) || !healthy) {
      await withAppToken(ctx, (t) => helix.deleteEventSubSubscription(t, s.id));
      await deleteEventSubSubscriptionRow(ctx.db, s.id);
      deleted.push(`${s.type}:${s.status}`);
    }
  }
  const remaining = new Set(ours.filter((s) => s.status === "enabled" || s.status === "webhook_callback_verification_pending").map(key));
  const liveIds = new Set(existing.map((s) => s.id));
  for (const w of wanted) {
    if (remaining.has(key(w))) continue;
    try {
      const sub = await withAppToken(ctx, (t) =>
        helix.createEventSubSubscription(t, { ...w, callback: env.TWITCH_EVENTSUB_CALLBACK_URL!, secret: env.TWITCH_EVENTSUB_SECRET! }),
      );
      await upsertEventSubSubscription(ctx.db, { id: sub.id, broadcaster_id: broadcasterId, type: sub.type, version: sub.version, status: sub.status, condition: sub.condition });
      liveIds.add(sub.id);
      created.push(w.type);
    } catch (err) {
      const msg = sanitizeErrorMessage((err as Error).message);
      await recordOpsError(ctx.db, broadcasterId, "eventsub", `Could not subscribe to ${w.type}: ${msg}`);
    }
  }
  // Drop local rows for subscriptions Twitch no longer has (or that we just deleted).
  for (const row of await listEventSubSubscriptions(ctx.db, broadcasterId)) {
    if (!liveIds.has(row.id)) await deleteEventSubSubscriptionRow(ctx.db, row.id);
  }
  return { created, deleted, skipped: null };
}

/**
 * Disconnect a broadcaster: revoke tokens at Twitch (best effort), mark the connection, stop
 * public listing and bot, revoke ingest keys, and remove EventSub subscriptions.
 */
export async function disconnectBroadcaster(ctx: ServerContext, broadcasterId: string): Promise<void> {
  const b = await getBroadcaster(ctx.db, broadcasterId);
  if (b?.twitch_user_id) {
    const grant = await getGrant(ctx.db, "broadcaster", b.twitch_user_id);
    if (grant && ctx.oauth) {
      for (const enc of [grant.access_token_enc, grant.refresh_token_enc]) {
        if (!enc) continue;
        await revokeToken(ctx.oauth, ctx.cipher.decrypt(enc)).catch((err: unknown) =>
          ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "token revoke failed"),
        );
      }
      await setGrantStatus(ctx.db, grant.id, "revoked", "Disconnected by the creator");
    }
  }
  await markDisconnected(ctx.db, broadcasterId);
  await revokeAllIngestSources(ctx.db, broadcasterId);
  await reconcileEventSub(ctx, broadcasterId).catch((err: unknown) =>
    ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "eventsub cleanup failed"),
  );
}
