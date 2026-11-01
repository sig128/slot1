import type { FastifyPluginAsync } from "fastify";
import {
  ACTIVITY_WINDOW_MS,
  deriveActivity,
  type AnalysisStatus,
  type NowRecentEntry,
  type NowResponse,
  type NowStream,
  type Observation,
} from "@slot1/contracts";
import { getAssets, listDirectoryBroadcasters, type BroadcasterRow, type StreamSessionRow } from "@slot1/db";
import { analysisStatus, liveSnapshots, type ServerContext } from "@slot1/services";
import { channelUrl } from "@slot1/twitch";

/** The server computes the page once per this many ms; clients poll a little slower. */
export const NOW_CACHE_MS = 3000;
export const NOW_REFRESH_MS = 5000;
/** Latest-frame thumbnails are signed for a short time: only long enough for one view. */
const THUMB_TTL_SEC = 120;
const RECENT_WINDOW = "15 minutes";

type LiveRow = StreamSessionRow & {
  login: string;
  display_name: string;
  avatar_url: string | null;
  broadcaster_kind: BroadcasterRow["kind"];
  owner_user_id: string | null;
  twitch_user_id: string | null;
  live_source_id: string;
  last_frame_asset_id: string | null;
};

/** Why a stream shows plain "Live": never a guess at the gameplay. */
export function quietReason(st: Pick<AnalysisStatus, "state" | "reason">): string {
  switch (st.state) {
    case "live_vision":
    case "delayed":
      return "Nothing SLOT1 could name in the last minute";
    case "ready":
      return st.reason?.includes("agent not enabled") ? "AI analysis is off for this stream" : "Waiting for the first analyzed frames";
    case "stale":
      return "Feed stale: no new frames, so nothing is being analyzed";
    case "stopped":
      return "Analysis paused by the creator";
    case "error":
      return "Analysis unavailable right now";
    default:
      return "SLOT1 can't see the gameplay right now";
  }
}

/**
 * Public live SLOT1 streams: the creator's channel and the session are public with public
 * analysis, and video is reaching SLOT1 right now. Private sessions never match.
 */
async function publicLiveSessions(ctx: ServerContext): Promise<LiveRow[]> {
  const { rows } = await ctx.db.query<LiveRow>(
    `SELECT s.*, b.login, b.display_name, b.avatar_url, b.kind AS broadcaster_kind, b.owner_user_id, b.twitch_user_id,
            m.id AS live_source_id, h.last_frame_asset_id
       FROM stream_sessions s
       JOIN broadcasters b ON b.id = s.broadcaster_id
       JOIN channel_settings cs ON cs.broadcaster_id = s.broadcaster_id
       JOIN LATERAL (
         SELECT ms.id FROM media_sources ms
          WHERE ms.session_id = s.id AND ms.kind = 'live_ingest' AND ms.status = 'publishing' AND ms.revoked_at IS NULL
          ORDER BY ms.publish_started_at DESC NULLS LAST LIMIT 1
       ) m ON true
       LEFT JOIN source_health h ON h.source_id = m.id
      WHERE s.ended_at IS NULL AND s.delete_requested_at IS NULL AND s.kind IN ('ingest', 'twitch_broadcast')
        AND s.visibility = 'public' AND cs.visibility = 'public' AND cs.public_analysis
      ORDER BY s.started_at DESC
      LIMIT 200`,
  );
  // One stream per creator: the newest public session.
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.broadcaster_id) ? false : (seen.add(r.broadcaster_id), true)));
}

type ActivityRow = { id: string; session_id: string; type: Observation["type"]; description: string; raw_text: string | null; origin: Observation["origin"]; received_at: Date; review_status: Observation["reviewStatus"] };

async function build(ctx: ServerContext): Promise<NowResponse> {
  const now = Date.now();
  const live = await publicLiveSessions(ctx);
  const ids = live.map((r) => r.id);
  const [activityRows, recentRows, assets] = await Promise.all([
    ids.length
      ? ctx.db.query<ActivityRow>(
          `SELECT id, session_id, type, description, raw_text, origin, received_at, review_status FROM observations
            WHERE session_id = ANY($1::uuid[]) AND received_at > now() - make_interval(secs => $2) AND review_status <> 'rejected'
            ORDER BY received_at DESC LIMIT 4000`,
          [ids, ACTIVITY_WINDOW_MS / 1000 + 5],
        )
      : Promise.resolve({ rows: [] as ActivityRow[] }),
    ids.length
      ? ctx.db.query<{ id: string; session_id: string; type: string; description: string; received_at: Date }>(
          `SELECT r.id, r.session_id, r.type, r.description, r.received_at FROM unnest($1::uuid[]) AS sid(id)
           CROSS JOIN LATERAL (
             SELECT o.id, o.session_id, o.type, o.description, o.received_at FROM observations o
              WHERE o.session_id = sid.id AND o.review_status <> 'rejected' AND o.origin <> 'twitch'
                AND o.type NOT IN ('media_facts', 'session_coverage') AND o.received_at > now() - interval '${RECENT_WINDOW}'
              ORDER BY o.received_at DESC LIMIT 5
           ) r`,
          [ids],
        )
      : Promise.resolve({ rows: [] }),
    getAssets(ctx.db, live.map((r) => r.last_frame_asset_id).filter((x): x is string => Boolean(x))),
  ]);
  const bySession = new Map<string, ActivityRow[]>();
  for (const r of activityRows.rows) bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), r]);
  const recentBySession = new Map<string, NowRecentEntry[]>();
  for (const r of recentRows.rows) {
    recentBySession.set(r.session_id, [...(recentBySession.get(r.session_id) ?? []), { id: r.id, description: r.description, receivedAt: r.received_at.toISOString(), type: r.type }]);
  }
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // Twitch's own live state for every channel involved (cached in Redis by liveSnapshots).
  const directory = await listDirectoryBroadcasters(ctx.db);
  const twitchOwners: BroadcasterRow[] = live
    .filter((r) => r.broadcaster_kind === "twitch" && r.twitch_user_id)
    .map((r) => ({ id: r.broadcaster_id, owner_user_id: r.owner_user_id, kind: r.broadcaster_kind, twitch_user_id: r.twitch_user_id, login: r.login, display_name: r.display_name, avatar_url: r.avatar_url }) as BroadcasterRow);
  const snaps = await liveSnapshots(ctx, [...directory, ...twitchOwners.filter((b) => !directory.some((d) => d.id === b.id))]);

  const streams: NowStream[] = [];
  for (const r of live) {
    const st = analysisStatus(r, ctx.config, now);
    const obs = (bySession.get(r.id) ?? []).map((o) => ({
      id: o.id,
      type: o.type,
      description: o.description,
      rawText: o.raw_text,
      origin: o.origin,
      receivedAt: o.received_at.toISOString(),
      reviewStatus: o.review_status,
    }));
    const asset = r.last_frame_asset_id ? assetById.get(r.last_frame_asset_id) : undefined;
    const thumb = asset && asset.session_id === r.id && asset.content_type.startsWith("image/") ? await ctx.storage.signedGetUrl(asset.storage_key, THUMB_TTL_SEC, asset.content_type) : null;
    const snap = snaps.get(r.broadcaster_id);
    const onTwitch = r.broadcaster_kind === "twitch";
    streams.push({
      broadcasterId: r.broadcaster_id,
      login: r.login,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      kind: "slot1",
      label: r.label,
      sessionId: r.id,
      title: r.title ?? snap?.title ?? null,
      category: r.category ?? snap?.category ?? null,
      viewerCount: snap?.state === "live" ? snap.viewerCount : null,
      thumbnailUrl: thumb,
      activity: deriveActivity(obs, now, quietReason(st)),
      analysisState: st.state,
      recent: recentBySession.get(r.id) ?? [],
      twitchUrl: onTwitch ? channelUrl(r.login) : null,
      watchPath: `/watch/${encodeURIComponent(r.login)}`,
    });
  }
  // Directory channels live on Twitch without a public SLOT1 stream: watch-only, not analyzed.
  const listed = new Set(streams.map((s) => s.broadcasterId));
  const twitchOnly = directory
    .filter((b) => !listed.has(b.id) && snaps.get(b.id)?.state === "live")
    .sort((a, b) => (snaps.get(b.id)?.viewerCount ?? -1) - (snaps.get(a.id)?.viewerCount ?? -1));
  for (const b of twitchOnly) {
    const snap = snaps.get(b.id)!;
    streams.push({
      broadcasterId: b.id,
      login: b.login,
      displayName: b.display_name,
      avatarUrl: b.avatar_url,
      kind: "twitch",
      label: null,
      sessionId: null,
      title: snap.title,
      category: snap.category,
      viewerCount: snap.viewerCount,
      thumbnailUrl: snap.thumbnailUrl,
      activity: null,
      analysisState: null,
      recent: [],
      twitchUrl: channelUrl(b.login),
      watchPath: `/watch/${encodeURIComponent(b.login)}`,
    });
  }

  let emptyReason: string | null = null;
  if (streams.length === 0) {
    const parts: string[] = [];
    parts.push(
      ctx.config.capabilities.ingest.available
        ? "No creator is sending a public stream to SLOT1 right now."
        : "This SLOT1 server can't receive streams yet (no ingest gateway is configured).",
    );
    if (!ctx.config.capabilities.twitch.available) parts.push("Twitch isn't configured here, so Twitch-only channels can't be shown.");
    else parts.push(directory.length ? "None of the channels in the directory are live on Twitch." : "No channels have joined the directory yet.");
    emptyReason = parts.join(" ");
  }
  return { streams, emptyReason, generatedAt: new Date(now).toISOString(), refreshMs: NOW_REFRESH_MS };
}

const caches = new WeakMap<object, { at: number; value: NowResponse | null; inflight: Promise<NowResponse> | null }>();

/** Drop the cached answer (tests that change data and look again straight away). */
export function clearNowCache(ctx: object): void {
  caches.delete(ctx);
}

/** One computation per NOW_CACHE_MS per API process, shared by every viewer (it's public data). */
export async function losSantosNow(ctx: ServerContext, nowMs = Date.now()): Promise<NowResponse> {
  let c = caches.get(ctx);
  if (!c) caches.set(ctx, (c = { at: 0, value: null, inflight: null }));
  if (c.value && nowMs - c.at < NOW_CACHE_MS) return c.value;
  if (c.inflight) return c.inflight;
  const entry = c;
  entry.inflight = build(ctx)
    .then((v) => {
      entry.value = v;
      entry.at = Date.now();
      return v;
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

export const nowRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * "Los Santos right now": every public live stream and what SLOT1 saw on it in the last
     * minute. Same answer for every viewer, so it is computed once and cached briefly.
     */
    app.get("/api/now", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (_req, reply): Promise<NowResponse> => {
      const res = await losSantosNow(ctx);
      // Public data only; thumbnails are short-lived signed links, so shared caches keep it briefly.
      reply.header("cache-control", "public, max-age=2");
      return res;
    });
  };
