import {
  expireOldClipLinks,
  hardDeleteSession,
  listDirectoryBroadcasters,
  listExpiredAssets,
  listSessionAssets,
  listSessionsPastRetention,
  markAssetsDeleted,
  pruneDeliveries,
  getSessionIncludingDeleted,
  pruneContactMessages,
  rollupAndPruneAnalytics,
} from "@slot1/db";
import { storageKeys, type MaintenanceJobs } from "@slot1/platform";
import { liveSnapshots, sweepInstantReplays, validateAllGrants, type ServerContext } from "@slot1/services";
import { sweepRecordings } from "./library";

/**
 * Delete a session: every stored object under its prefix (frames, playback, originals, clips,
 * audio), then the session row — which cascades to observations, transcripts, events, moments.
 */
export async function deleteSession(ctx: ServerContext, data: MaintenanceJobs["delete-session"]): Promise<void> {
  const s = await getSessionIncludingDeleted(ctx.db, data.sessionId);
  if (!s || s.broadcaster_id !== data.broadcasterId) return;
  const assets = await listSessionAssets(ctx.db, s.id);
  for (const a of assets) await ctx.storage.delete(a.storage_key).catch(() => undefined);
  await ctx.storage.deletePrefix(storageKeys.sessionPrefix(s.broadcaster_id, s.id)).catch(() => 0);
  // A finalized recording's media source exists only for this session.
  await ctx.db.query(`DELETE FROM media_sources WHERE session_id = $1 AND kind = 'recording'`, [s.id]);
  await hardDeleteSession(ctx.db, s.id);
  ctx.log.info({ session: s.id, assets: assets.length }, "session deleted");
}

export async function retentionSweep(ctx: ServerContext): Promise<{ assets: number; sessions: number }> {
  await sweepRecordings(ctx).catch((err: unknown) => ctx.log.warn({ err: (err as Error).message }, "recording sweep failed"));
  // Instant replays are ephemeral: their files go once their links have expired.
  await sweepInstantReplays(ctx).catch((err: unknown) => ctx.log.warn({ err: (err as Error).message }, "instant replay sweep failed"));
  const expired = await listExpiredAssets(ctx.db, 500);
  for (const a of expired) await ctx.storage.delete(a.storage_key).catch(() => undefined);
  await markAssetsDeleted(ctx.db, expired.map((a) => a.id));
  const sessions = await listSessionsPastRetention(ctx.db);
  for (const s of sessions) await deleteSession(ctx, { sessionId: s.id, broadcasterId: s.broadcaster_id });
  // Ingest sessions whose publisher has been gone for 30 minutes are closed.
  await ctx.db.query(
    `UPDATE stream_sessions s SET ended_at = now()
      WHERE s.kind = 'ingest' AND s.ended_at IS NULL
        AND COALESCE(s.last_received_frame_at, s.started_at) < now() - interval '30 minutes'
        AND NOT EXISTS (SELECT 1 FROM media_sources m WHERE m.session_id = s.id AND m.status = 'publishing')`,
  );
  await pruneDeliveries(ctx.db, 7);
  await expireOldClipLinks(ctx.db);
  await ctx.db.query(`DELETE FROM user_sessions WHERE expires_at < now()`);
  await ctx.db.query(`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 hour'`);
  // Visitor analytics keep daily totals and drop raw page views after 90 days; contact messages go after 24 months.
  await rollupAndPruneAnalytics(ctx.db).catch((err: unknown) => ctx.log.warn({ err: (err as Error).message }, "analytics retention failed"));
  await pruneContactMessages(ctx.db).catch((err: unknown) => ctx.log.warn({ err: (err as Error).message }, "contact retention failed"));
  return { assets: expired.length, sessions: sessions.length };
}

export async function validateGrants(ctx: ServerContext) {
  if (!ctx.config.capabilities.twitch.available) return { checked: 0, refreshed: 0, revoked: 0 };
  return validateAllGrants(ctx);
}

/** Polling fallback for live/offline state (covers deployments without a public EventSub callback). */
export async function refreshDirectory(ctx: ServerContext) {
  if (!ctx.helix) return;
  const list = await listDirectoryBroadcasters(ctx.db);
  if (list.length) await liveSnapshots(ctx, list);
}
