import type { Queryable } from "./client";

/**
 * Deployment-wide counts for the operator dashboard (/admin). Every number is a real count from
 * the database; nothing here is estimated.
 */
export interface PlatformCounts {
  users: { total: number; new7: number; operators: number };
  creators: { total: number; connected: number };
  botChannels: number;
  botLinked: boolean;
  liveSources: { total: number; publishing: number };
  sessions: { total: number; today: number };
  observations24h: number;
  clips: number;
  library: { total: number; recordings: number; renders: number; screenshots: number };
  storage: { trackedBytes: number; files: number };
  relay: { total: number; enabled: number; live: number };
}

export async function platformCounts(db: Queryable): Promise<PlatformCounts> {
  const { rows } = await db.query<Record<string, number | boolean>>(
    `SELECT
       (SELECT count(*) FROM users)::int AS users_total,
       (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS users_new7,
       (SELECT count(*) FROM users WHERE is_operator)::int AS operators,
       (SELECT count(*) FROM broadcasters)::int AS creators_total,
       (SELECT count(*) FROM broadcaster_connections WHERE status = 'active')::int AS creators_connected,
       (SELECT count(*) FROM channel_settings WHERE bot_enabled AND NOT bot_killed)::int AS bot_channels,
       EXISTS (SELECT 1 FROM encrypted_grants WHERE role = 'bot' AND status = 'active') AS bot_linked,
       (SELECT count(*) FROM media_sources WHERE kind = 'live_ingest' AND revoked_at IS NULL AND status <> 'deleted')::int AS sources_total,
       (SELECT count(*) FROM media_sources WHERE kind = 'live_ingest' AND status = 'publishing' AND revoked_at IS NULL)::int AS sources_publishing,
       (SELECT count(*) FROM stream_sessions WHERE delete_requested_at IS NULL)::int AS sessions_total,
       (SELECT count(*) FROM stream_sessions WHERE delete_requested_at IS NULL
          AND started_at >= (date_trunc('day', now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC')::int AS sessions_today,
       (SELECT count(*) FROM observations o JOIN stream_sessions s ON s.id = o.session_id
         WHERE (s.ended_at IS NULL OR s.ended_at > now() - interval '24 hours')
           AND o.received_at > now() - interval '24 hours')::int AS observations_24h,
       (SELECT count(*) FROM clip_jobs WHERE state = 'ready')::int AS clips,
       (SELECT count(*) FROM library_items WHERE status = 'ready')::int AS library_total,
       (SELECT count(*) FROM library_items WHERE status = 'ready' AND kind = 'recording')::int AS library_recordings,
       (SELECT count(*) FROM library_items WHERE status = 'ready' AND kind IN ('render', 'clip_export'))::int AS library_renders,
       (SELECT count(*) FROM library_items WHERE status = 'ready' AND kind = 'screenshot')::int AS library_screenshots,
       (SELECT COALESCE(sum(bytes), 0) FROM evidence_assets WHERE deleted_at IS NULL)::bigint AS tracked_bytes,
       (SELECT count(*) FROM evidence_assets WHERE deleted_at IS NULL)::int AS tracked_files,
       (SELECT count(*) FROM relay_destinations)::int AS relay_total,
       (SELECT count(*) FROM relay_destinations WHERE enabled)::int AS relay_enabled,
       (SELECT count(*) FROM relay_destinations WHERE enabled AND status = 'live')::int AS relay_live`,
  );
  const r = rows[0]!;
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    users: { total: n("users_total"), new7: n("users_new7"), operators: n("operators") },
    creators: { total: n("creators_total"), connected: n("creators_connected") },
    botChannels: n("bot_channels"),
    botLinked: Boolean(r.bot_linked),
    liveSources: { total: n("sources_total"), publishing: n("sources_publishing") },
    sessions: { total: n("sessions_total"), today: n("sessions_today") },
    observations24h: n("observations_24h"),
    clips: n("clips"),
    library: { total: n("library_total"), recordings: n("library_recordings"), renders: n("library_renders"), screenshots: n("library_screenshots") },
    storage: { trackedBytes: n("tracked_bytes"), files: n("tracked_files") },
    relay: { total: n("relay_total"), enabled: n("relay_enabled"), live: n("relay_live") },
  };
}

export interface LiveSessionRow {
  session_id: string;
  login: string;
  display_name: string;
  title: string | null;
  kind: "ingest" | "twitch_broadcast";
  label: string | null;
  visibility: "public" | "private";
  analysis_state: string;
  started_at: Date;
  frames_analyzed: number;
  last_result_at: Date | null;
  publishing: boolean;
}

/** Sessions on air right now: video reaching SLOT1, or a Twitch broadcast SLOT1 knows is live. */
export async function liveSessionsNow(db: Queryable, limit = 50): Promise<LiveSessionRow[]> {
  const { rows } = await db.query<LiveSessionRow>(
    `SELECT s.id AS session_id, b.login, b.display_name, s.title, s.kind, s.label, s.visibility, s.analysis_state,
            s.started_at, s.frames_analyzed, s.last_result_at,
            EXISTS (SELECT 1 FROM media_sources m WHERE m.session_id = s.id AND m.kind = 'live_ingest'
                     AND m.status = 'publishing' AND m.revoked_at IS NULL) AS publishing
       FROM stream_sessions s JOIN broadcasters b ON b.id = s.broadcaster_id
      WHERE s.ended_at IS NULL AND s.delete_requested_at IS NULL AND s.kind IN ('ingest', 'twitch_broadcast')
        AND (s.broadcast_state = 'live' OR EXISTS (
              SELECT 1 FROM media_sources m WHERE m.session_id = s.id AND m.kind = 'live_ingest'
                 AND m.status = 'publishing' AND m.revoked_at IS NULL))
      ORDER BY s.started_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface UsageRow {
  kind: "vision" | "transcription" | "qa";
  calls: number;
  frames: number;
  input_tokens: number;
  output_tokens: number;
  audio_seconds: number;
  cost: number | null;
}

/** AI provider calls in the window. cost is null when no call in the window had a price. */
export async function aiUsageSince(db: Queryable, hours: number): Promise<UsageRow[]> {
  const { rows } = await db.query<UsageRow>(
    `SELECT kind, count(*)::int AS calls, COALESCE(sum(frames), 0)::int AS frames,
            COALESCE(sum(input_tokens), 0)::bigint AS input_tokens, COALESCE(sum(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(sum(audio_seconds), 0)::real AS audio_seconds, sum(estimated_cost_usd)::float8 AS cost
       FROM usage_events WHERE created_at > now() - make_interval(hours => $1::int)
      GROUP BY kind ORDER BY kind`,
    [hours],
  );
  return rows;
}

export async function activeModels(db: Queryable): Promise<{ models: { task: string; name: string; version: string; activated_at: Date | null }[]; candidates: number }> {
  const [active, cand] = await Promise.all([
    db.query<{ task: string; name: string; version: string; activated_at: Date | null }>(
      `SELECT task, name, version, activated_at FROM models WHERE status = 'active' ORDER BY task`,
    ),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM models WHERE status = 'candidate'`),
  ]);
  return { models: active.rows, candidates: cand.rows[0]?.n ?? 0 };
}

/** Failed background jobs and surfaced errors in the last 24 hours (messages are already sanitized). */
export async function recentFailures(db: Queryable, limit = 8): Promise<{ count: number; items: { at: Date; place: string; message: string }[] }> {
  const [count, items] = await Promise.all([
    db.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM job_runs WHERE state = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '24 hours')
             + (SELECT count(*) FROM ops_errors WHERE created_at > now() - interval '24 hours'))::int AS n`,
    ),
    db.query<{ at: Date; place: string; message: string }>(
      `SELECT * FROM (
         SELECT COALESCE(finished_at, created_at) AS at, queue || ' / ' || name AS place, COALESCE(error, 'Failed') AS message
           FROM job_runs WHERE state = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '24 hours'
         UNION ALL
         SELECT created_at, scope, message FROM ops_errors WHERE created_at > now() - interval '24 hours'
       ) f ORDER BY at DESC LIMIT $1`,
      [limit],
    ),
  ]);
  return { count: count.rows[0]?.n ?? 0, items: items.rows };
}

export async function databaseInfo(db: Queryable): Promise<{ version: string; sizeBytes: number }> {
  const { rows } = await db.query<{ version: string; size: number }>(
    `SELECT current_setting('server_version') AS version, pg_database_size(current_database())::bigint AS size`,
  );
  return { version: rows[0]!.version, sizeBytes: Number(rows[0]!.size) };
}
