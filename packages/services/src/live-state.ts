import type { BroadcastSnapshot, BroadcastState } from "@slot1/contracts";
import {
  endTwitchBroadcastSessions,
  getOpenTwitchSession,
  getSettings,
  upsertTwitchBroadcastSession,
  type BroadcasterRow,
} from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import { sizeThumbnail } from "@slot1/twitch";
import type { ServerContext } from "./context";
import { emitBroadcastStatus } from "./events";
import { withAppToken } from "./twitch";

interface CachedLive {
  state: BroadcastState;
  title: string | null;
  category: string | null;
  thumbnailUrl: string | null;
  viewerCount: number | null;
  startedAt: string | null;
  streamId: string | null;
  refreshedAt: string;
}

const KEY = (twitchId: string) => `slot1:live:${twitchId}`;
const TTL_SEC = 60;

const unknown = (): BroadcastSnapshot => ({
  state: "unknown",
  title: null,
  category: null,
  thumbnailUrl: null,
  viewerCount: null,
  startedAt: null,
  lastRefreshedAt: null,
});

/**
 * Live/offline state and metadata from Helix (cached ~60s). Viewer counts appear only when
 * Twitch returned them. When Twitch isn't configured the state is "unknown" — never guessed.
 * Also keeps broadcast sessions in step when EventSub is unavailable (polling fallback).
 */
export async function liveSnapshots(ctx: ServerContext, broadcasters: BroadcasterRow[]): Promise<Map<string, BroadcastSnapshot>> {
  const out = new Map<string, BroadcastSnapshot>();
  const twitchOnes = broadcasters.filter((b) => b.kind === "twitch" && b.twitch_user_id);
  for (const b of broadcasters) out.set(b.id, unknown());
  if (!ctx.helix || twitchOnes.length === 0) return out;

  const missing: BroadcasterRow[] = [];
  for (const b of twitchOnes) {
    const raw = await ctx.redis.get(KEY(b.twitch_user_id!));
    if (raw) out.set(b.id, toSnapshot(JSON.parse(raw) as CachedLive));
    else missing.push(b);
  }
  if (missing.length === 0) return out;

  try {
    const helix = ctx.helix;
    const ids = missing.map((b) => b.twitch_user_id!);
    const [streams, channels] = await Promise.all([
      withAppToken(ctx, (t) => helix.getStreams(t, { userIds: ids })),
      withAppToken(ctx, (t) => helix.getChannels(t, ids)),
    ]);
    const now = new Date().toISOString();
    for (const b of missing) {
      const s = streams.find((x) => x.user_id === b.twitch_user_id && x.type === "live");
      const ch = channels.find((x) => x.broadcaster_id === b.twitch_user_id);
      const cached: CachedLive = s
        ? {
            state: "live",
            title: s.title,
            category: s.game_name || null,
            thumbnailUrl: sizeThumbnail(s.thumbnail_url, 960, 540),
            viewerCount: Number.isFinite(s.viewer_count) ? s.viewer_count : null,
            startedAt: s.started_at,
            streamId: s.id,
            refreshedAt: now,
          }
        : { state: "offline", title: ch?.title ?? null, category: ch?.game_name || null, thumbnailUrl: null, viewerCount: null, startedAt: null, streamId: null, refreshedAt: now };
      await ctx.redis.set(KEY(b.twitch_user_id!), JSON.stringify(cached), "EX", TTL_SEC);
      out.set(b.id, toSnapshot(cached));
      await syncBroadcastSession(ctx, b, cached).catch((err: unknown) =>
        ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "broadcast session sync failed"),
      );
    }
  } catch (err) {
    ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "Helix live lookup failed");
    for (const b of missing) out.set(b.id, { ...unknown(), state: "error" });
  }
  return out;
}

function toSnapshot(c: CachedLive): BroadcastSnapshot {
  return {
    state: c.state,
    title: c.title,
    category: c.category,
    thumbnailUrl: c.thumbnailUrl,
    viewerCount: c.viewerCount,
    startedAt: c.startedAt,
    lastRefreshedAt: c.refreshedAt,
  };
}

async function syncBroadcastSession(ctx: ServerContext, b: BroadcasterRow, live: CachedLive) {
  const open = await getOpenTwitchSession(ctx.db, b.id);
  if (live.state === "live" && live.streamId && open?.twitch_stream_id !== live.streamId) {
    const settings = await getSettings(ctx.db, b.id);
    if (open) await endTwitchBroadcastSessions(ctx.db, b.id);
    const s = await upsertTwitchBroadcastSession(ctx.db, {
      broadcasterId: b.id,
      twitchStreamId: live.streamId,
      startedAt: live.startedAt ?? new Date().toISOString(),
      title: live.title,
      category: live.category,
      visibility: settings.visibility,
    });
    await emitBroadcastStatus(ctx.db, ctx.publisher, s, { state: "live", title: live.title, category: live.category });
  } else if (live.state === "offline" && open) {
    for (const s of await endTwitchBroadcastSessions(ctx.db, b.id)) {
      await emitBroadcastStatus(ctx.db, ctx.publisher, s, { state: "offline", title: s.title, category: s.category });
    }
  }
}

export async function invalidateLiveCache(ctx: ServerContext, twitchUserId: string) {
  await ctx.redis.del(KEY(twitchUserId));
}
