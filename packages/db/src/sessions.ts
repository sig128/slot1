import type { AnalysisState, BroadcastState, SessionKind, SourceLabel, Visibility } from "@slot1/contracts";
import type { Queryable } from "./client";

export interface StreamSessionRow {
  id: string;
  broadcaster_id: string;
  kind: SessionKind;
  label: SourceLabel | null;
  title: string | null;
  category: string | null;
  twitch_stream_id: string | null;
  visibility: Visibility;
  broadcast_state: BroadcastState;
  analysis_state: AnalysisState;
  analysis_reason: string | null;
  started_at: Date;
  ended_at: Date | null;
  last_received_frame_at: Date | null;
  last_analyzed_frame_at: Date | null;
  last_result_at: Date | null;
  measured_cadence_ms: number | null;
  measured_delay_ms: number | null;
  expected_interval_ms: number | null;
  error_reason: string | null;
  frames_received: number;
  frames_analyzed: number;
  frames_dropped: number;
  analyzed_ms: number;
  duration_ms: number | null;
  gaps: { startMs: number; endMs: number; reason: string }[];
  delete_requested_at: Date | null;
}

const S_COLS = `id, broadcaster_id, kind, label, title, category, twitch_stream_id, visibility, broadcast_state, analysis_state,
  analysis_reason, started_at, ended_at, last_received_frame_at, last_analyzed_frame_at, last_result_at, measured_cadence_ms,
  measured_delay_ms, expected_interval_ms, error_reason, frames_received, frames_analyzed, frames_dropped, analyzed_ms,
  duration_ms, gaps, delete_requested_at`;

export async function createReplaySession(db: Queryable, broadcasterId: string, title: string, visibility: Visibility): Promise<StreamSessionRow> {
  const { rows } = await db.query<StreamSessionRow>(
    `INSERT INTO stream_sessions (broadcaster_id, kind, label, title, visibility, broadcast_state, analysis_state, analysis_reason)
     VALUES ($1, 'replay', 'replay', $2, $3, 'unknown', 'ready', 'Upload received; waiting for processing')
     RETURNING ${S_COLS}`,
    [broadcasterId, title, visibility],
  );
  return rows[0]!;
}

export async function createIngestSession(
  db: Queryable,
  broadcasterId: string,
  label: "live" | "test",
  title: string,
  visibility: Visibility,
  expectedIntervalMs: number,
): Promise<StreamSessionRow> {
  const { rows } = await db.query<StreamSessionRow>(
    `INSERT INTO stream_sessions (broadcaster_id, kind, label, title, visibility, analysis_state, analysis_reason, expected_interval_ms)
     VALUES ($1, 'ingest', $2, $3, $4, 'ready', 'Waiting for the first frame', $5)
     RETURNING ${S_COLS}`,
    [broadcasterId, label, title, visibility, expectedIntervalMs],
  );
  return rows[0]!;
}

/** Start (or return the existing) session for a Twitch broadcast, keyed by Twitch's stream id. */
export async function upsertTwitchBroadcastSession(
  db: Queryable,
  input: { broadcasterId: string; twitchStreamId: string; startedAt: string; title: string | null; category: string | null; visibility: Visibility },
): Promise<StreamSessionRow> {
  const { rows } = await db.query<StreamSessionRow>(
    `INSERT INTO stream_sessions (broadcaster_id, kind, twitch_stream_id, started_at, title, category, visibility, broadcast_state, analysis_state, analysis_reason)
     VALUES ($1, 'twitch_broadcast', $2, $3, $4, $5, $6, 'live', 'no_source', 'No authorized video source — chat and clips only')
     ON CONFLICT (broadcaster_id, twitch_stream_id) WHERE twitch_stream_id IS NOT NULL
       DO UPDATE SET broadcast_state = 'live', title = COALESCE(EXCLUDED.title, stream_sessions.title),
                     category = COALESCE(EXCLUDED.category, stream_sessions.category)
     RETURNING ${S_COLS}`,
    [input.broadcasterId, input.twitchStreamId, input.startedAt, input.title, input.category, input.visibility],
  );
  return rows[0]!;
}

export async function endTwitchBroadcastSessions(db: Queryable, broadcasterId: string): Promise<StreamSessionRow[]> {
  const { rows } = await db.query<StreamSessionRow>(
    `UPDATE stream_sessions SET broadcast_state = 'offline', ended_at = COALESCE(ended_at, now())
     WHERE broadcaster_id = $1 AND kind = 'twitch_broadcast' AND ended_at IS NULL RETURNING ${S_COLS}`,
    [broadcasterId],
  );
  return rows;
}

export async function getSession(db: Queryable, id: string): Promise<StreamSessionRow | null> {
  const { rows } = await db.query<StreamSessionRow>(`SELECT ${S_COLS} FROM stream_sessions WHERE id = $1 AND delete_requested_at IS NULL`, [id]);
  return rows[0] ?? null;
}

export async function getSessionIncludingDeleted(db: Queryable, id: string): Promise<StreamSessionRow | null> {
  const { rows } = await db.query<StreamSessionRow>(`SELECT ${S_COLS} FROM stream_sessions WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** The session the watch page shows: an open Twitch broadcast, else the newest open ingest session. */
export async function getCurrentLiveSession(db: Queryable, broadcasterId: string): Promise<StreamSessionRow | null> {
  const { rows } = await db.query<StreamSessionRow>(
    `SELECT ${S_COLS} FROM stream_sessions
     WHERE broadcaster_id = $1 AND kind IN ('twitch_broadcast', 'ingest') AND delete_requested_at IS NULL
     ORDER BY (ended_at IS NULL) DESC, (kind = 'twitch_broadcast') DESC, started_at DESC LIMIT 1`,
    [broadcasterId],
  );
  return rows[0] ?? null;
}

export async function getOpenTwitchSession(db: Queryable, broadcasterId: string): Promise<StreamSessionRow | null> {
  const { rows } = await db.query<StreamSessionRow>(
    `SELECT ${S_COLS} FROM stream_sessions WHERE broadcaster_id = $1 AND kind = 'twitch_broadcast' AND ended_at IS NULL
       AND delete_requested_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [broadcasterId],
  );
  return rows[0] ?? null;
}

export async function listSessions(db: Queryable, broadcasterId: string, opts: { kind?: SessionKind; publicOnly?: boolean; limit?: number } = {}) {
  const params: unknown[] = [broadcasterId];
  let where = `broadcaster_id = $1 AND delete_requested_at IS NULL`;
  if (opts.kind) {
    params.push(opts.kind);
    where += ` AND kind = $${params.length}`;
  }
  if (opts.publicOnly) where += ` AND visibility = 'public'`;
  params.push(opts.limit ?? 20);
  const { rows } = await db.query<StreamSessionRow>(
    `SELECT ${S_COLS} FROM stream_sessions WHERE ${where} ORDER BY started_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function setAnalysisState(db: Queryable, sessionId: string, state: AnalysisState, reason: string | null) {
  const { rows } = await db.query<StreamSessionRow>(
    `UPDATE stream_sessions SET analysis_state = $2, analysis_reason = $3 WHERE id = $1 RETURNING ${S_COLS}`,
    [sessionId, state, reason],
  );
  return rows[0] ?? null;
}

export async function setBroadcastState(db: Queryable, sessionId: string, state: BroadcastState, title?: string | null, category?: string | null) {
  await db.query(
    `UPDATE stream_sessions SET broadcast_state = $2, title = COALESCE($3, title), category = COALESCE($4, category) WHERE id = $1`,
    [sessionId, state, title ?? null, category ?? null],
  );
}

export async function recordFrameReceived(db: Queryable, sessionId: string, cadenceMs: number | null) {
  await db.query(
    `UPDATE stream_sessions SET frames_received = frames_received + 1, last_received_frame_at = now(),
       measured_cadence_ms = COALESCE($2, measured_cadence_ms) WHERE id = $1`,
    [sessionId, cadenceMs],
  );
}

export async function recordFramesAnalyzed(
  db: Queryable,
  sessionId: string,
  input: { count: number; analyzedSpanMs: number; delayMs: number | null; hadResult: boolean },
) {
  await db.query(
    `UPDATE stream_sessions SET frames_analyzed = frames_analyzed + $2, analyzed_ms = analyzed_ms + $3,
       last_analyzed_frame_at = now(), measured_delay_ms = COALESCE($4, measured_delay_ms),
       last_result_at = CASE WHEN $5 THEN now() ELSE last_result_at END WHERE id = $1`,
    [sessionId, input.count, Math.max(0, Math.round(input.analyzedSpanMs)), input.delayMs, input.hadResult],
  );
}

export async function recordDroppedFrames(db: Queryable, sessionId: string, count: number, gap: { startMs: number; endMs: number; reason: string } | null) {
  await db.query(
    `UPDATE stream_sessions SET frames_dropped = frames_dropped + $2,
       gaps = CASE WHEN $3::jsonb IS NULL THEN gaps
                   ELSE (CASE WHEN jsonb_array_length(gaps) >= 200 THEN gaps - 0 ELSE gaps END) || jsonb_build_array($3::jsonb) END
     WHERE id = $1`,
    [sessionId, count, gap ? JSON.stringify(gap) : null],
  );
}

export async function setSessionDuration(db: Queryable, sessionId: string, durationMs: number) {
  await db.query(`UPDATE stream_sessions SET duration_ms = $2 WHERE id = $1`, [sessionId, Math.round(durationMs)]);
}

export async function endSession(db: Queryable, sessionId: string) {
  await db.query(`UPDATE stream_sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1`, [sessionId]);
}

export async function setSessionVisibility(db: Queryable, broadcasterId: string, sessionId: string, visibility: Visibility) {
  const r = await db.query(`UPDATE stream_sessions SET visibility = $3 WHERE id = $2 AND broadcaster_id = $1`, [broadcasterId, sessionId, visibility]);
  return (r.rowCount ?? 0) > 0;
}

export async function requestSessionDeletion(db: Queryable, broadcasterId: string, sessionId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE stream_sessions SET delete_requested_at = now() WHERE id = $2 AND broadcaster_id = $1 AND delete_requested_at IS NULL`,
    [broadcasterId, sessionId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function hardDeleteSession(db: Queryable, sessionId: string) {
  await db.query(`DELETE FROM stream_sessions WHERE id = $1`, [sessionId]);
}

export async function listSessionsPastRetention(db: Queryable): Promise<{ id: string; broadcaster_id: string }[]> {
  const { rows } = await db.query<{ id: string; broadcaster_id: string }>(
    `SELECT s.id, s.broadcaster_id FROM stream_sessions s JOIN channel_settings cs ON cs.broadcaster_id = s.broadcaster_id
     WHERE (s.delete_requested_at IS NOT NULL)
        OR (COALESCE(s.ended_at, s.started_at) < now() - make_interval(days => cs.retention_days)
            AND (s.ended_at IS NOT NULL OR s.kind = 'replay'))
     LIMIT 200`,
  );
  return rows;
}
