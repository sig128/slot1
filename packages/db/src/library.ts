import type { ClipJobState, ClipKind, ClipMediaState } from "@slot1/contracts";
import type { Queryable } from "./client";
import { toTsQuery } from "./observations";

/* ------------------------------------------------------------------------------------------ */
/* Saved moments                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface MomentRow {
  id: string;
  broadcaster_id: string;
  session_id: string;
  observation_id: string | null;
  title: string;
  note: string | null;
  media_start_ms: number | null;
  media_end_ms: number | null;
  created_by_user_id: string | null;
  created_at: Date;
  // joined
  channel_login: string;
  channel_display_name: string;
  session_kind: "twitch_broadcast" | "replay" | "ingest";
  session_label: "replay" | "test" | "live" | "clip" | null;
  observation_type: string | null;
  observation_evidence: { assetId: string; kind: string }[] | null;
  clip_job_id: string | null;
  broadcaster_kind: "twitch" | "local";
}

export async function createMoment(
  db: Queryable,
  m: {
    broadcasterId: string;
    sessionId: string;
    observationId: string | null;
    title: string;
    note: string | null;
    mediaStartMs: number | null;
    mediaEndMs: number | null;
    userId: string | null;
  },
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO saved_moments (broadcaster_id, session_id, observation_id, title, note, media_start_ms, media_end_ms, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [m.broadcasterId, m.sessionId, m.observationId, m.title, m.note, m.mediaStartMs, m.mediaEndMs, m.userId],
  );
  return rows[0]!;
}

const MOMENT_SELECT = `
  SELECT m.id, m.broadcaster_id, m.session_id, m.observation_id, m.title, m.note, m.media_start_ms, m.media_end_ms,
         m.created_by_user_id, m.created_at, b.login AS channel_login, b.display_name AS channel_display_name, b.kind AS broadcaster_kind,
         s.kind AS session_kind, s.label AS session_label, o.type AS observation_type, o.evidence AS observation_evidence,
         (SELECT c.id FROM clip_jobs c WHERE c.moment_id = m.id ORDER BY c.requested_at DESC LIMIT 1) AS clip_job_id
  FROM saved_moments m
  JOIN broadcasters b ON b.id = m.broadcaster_id
  JOIN stream_sessions s ON s.id = m.session_id AND s.delete_requested_at IS NULL
  LEFT JOIN observations o ON o.id = m.observation_id
  LEFT JOIN channel_settings cs ON cs.broadcaster_id = m.broadcaster_id`;

/**
 * Library search. Authorization is expressed in SQL: a caller sees their own channel's moments
 * plus moments from sessions that are public on channels with public analysis enabled.
 */
export async function listMoments(
  db: Queryable,
  scope: { viewerBroadcasterId: string | null },
  f: { q?: string; broadcasterId?: string; sessionId?: string; type?: string; from?: string; to?: string; limit: number },
): Promise<MomentRow[]> {
  const params: unknown[] = [scope.viewerBroadcasterId];
  const where: string[] = [
    `(m.broadcaster_id = $1::uuid OR (s.visibility = 'public' AND cs.visibility = 'public' AND cs.public_analysis))`,
  ];
  if (f.broadcasterId) {
    params.push(f.broadcasterId);
    where.push(`m.broadcaster_id = $${params.length}::uuid`);
  }
  if (f.sessionId) {
    params.push(f.sessionId);
    where.push(`m.session_id = $${params.length}::uuid`);
  }
  if (f.type) {
    params.push(f.type);
    where.push(`o.type = $${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    where.push(`m.created_at >= $${params.length}::timestamptz`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`m.created_at <= $${params.length}::timestamptz`);
  }
  const terms = f.q ? toTsQuery(f.q) : null;
  if (terms) {
    params.push(terms);
    const p = `$${params.length}`;
    // Search across the moment itself, the linked observation (description + visible text) and
    // transcripts overlapping the moment — all within the same authorized session.
    where.push(`(m.search @@ to_tsquery('simple', ${p}) OR o.search @@ to_tsquery('simple', ${p}) OR EXISTS (
        SELECT 1 FROM transcripts t WHERE t.session_id = m.session_id AND t.search @@ to_tsquery('simple', ${p})
          AND (m.media_start_ms IS NULL OR (t.media_end_ms >= m.media_start_ms - 15000 AND t.media_start_ms <= COALESCE(m.media_end_ms, m.media_start_ms) + 15000))
      ))`);
  }
  params.push(f.limit);
  const { rows } = await db.query<MomentRow>(
    `${MOMENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getMoment(db: Queryable, id: string): Promise<MomentRow | null> {
  const { rows } = await db.query<MomentRow>(`${MOMENT_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------------------------------ */
/* Clip jobs                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface ClipJobRow {
  id: string;
  broadcaster_id: string;
  session_id: string;
  moment_id: string | null;
  kind: ClipKind;
  state: ClipJobState;
  media_state: ClipMediaState;
  idempotency_key: string;
  request_source: "web" | "chat" | "system";
  requested_by_user_id: string | null;
  requested_by_chatter_id: string | null;
  twitch_clip_id: string | null;
  edit_url: string | null;
  clip_url: string | null;
  embed_url: string | null;
  thumbnail_url: string | null;
  vod_id: string | null;
  vod_offset_sec: number | null;
  duration_ms: number | null;
  center_ms: number | null;
  pre_roll_ms: number | null;
  post_roll_ms: number | null;
  vertical: boolean;
  caption: string | null;
  landscape_asset_id: string | null;
  portrait_asset_id: string | null;
  source_resolution: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  requested_at: Date;
  ready_at: Date | null;
  expires_at: Date | null;
}

/**
 * Create a clip job idempotently: the same (broadcaster, idempotencyKey) always maps to the
 * same job, so double-clicks, retries and duplicate chat deliveries never create twice.
 */
export async function createClipJob(
  db: Queryable,
  c: {
    broadcasterId: string;
    sessionId: string;
    momentId: string | null;
    kind: ClipKind;
    idempotencyKey: string;
    requestSource: "web" | "chat" | "system";
    userId: string | null;
    chatterId: string | null;
    centerMs?: number | null;
    preRollMs?: number | null;
    postRollMs?: number | null;
    vertical?: boolean;
    caption?: string | null;
    vodId?: string | null;
    vodOffsetSec?: number | null;
    durationMs?: number | null;
  },
): Promise<{ job: ClipJobRow; created: boolean }> {
  const { rows } = await db.query<ClipJobRow>(
    `INSERT INTO clip_jobs (broadcaster_id, session_id, moment_id, kind, state, idempotency_key, request_source, requested_by_user_id,
        requested_by_chatter_id, center_ms, pre_roll_ms, post_roll_ms, vertical, caption, vod_id, vod_offset_sec, duration_ms)
     VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (broadcaster_id, idempotency_key) DO NOTHING RETURNING *`,
    [
      c.broadcasterId,
      c.sessionId,
      c.momentId,
      c.kind,
      c.idempotencyKey,
      c.requestSource,
      c.userId,
      c.chatterId,
      c.centerMs ?? null,
      c.preRollMs ?? null,
      c.postRollMs ?? null,
      c.vertical ?? false,
      c.caption ?? null,
      c.vodId ?? null,
      c.vodOffsetSec ?? null,
      c.durationMs ?? null,
    ],
  );
  if (rows[0]) return { job: rows[0], created: true };
  const existing = await db.query<ClipJobRow>(`SELECT * FROM clip_jobs WHERE broadcaster_id = $1 AND idempotency_key = $2`, [
    c.broadcasterId,
    c.idempotencyKey,
  ]);
  return { job: existing.rows[0]!, created: false };
}

export async function getClipJob(db: Queryable, id: string): Promise<ClipJobRow | null> {
  const { rows } = await db.query<ClipJobRow>(`SELECT * FROM clip_jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listClipJobs(db: Queryable, sessionId: string, limit = 20): Promise<ClipJobRow[]> {
  const { rows } = await db.query<ClipJobRow>(`SELECT * FROM clip_jobs WHERE session_id = $1 ORDER BY requested_at DESC LIMIT $2`, [sessionId, limit]);
  return rows;
}

export async function nearestReadyClip(db: Queryable, sessionId: string, mediaMs: number | null, receivedAt: string): Promise<ClipJobRow | null> {
  const { rows } = await db.query<ClipJobRow>(
    `SELECT * FROM clip_jobs WHERE session_id = $1 AND state = 'ready'
       AND ( ($2::bigint IS NOT NULL AND center_ms IS NOT NULL AND abs(center_ms - $2::bigint) < 60000)
          OR (requested_at BETWEEN $3::timestamptz - interval '10 seconds' AND $3::timestamptz + interval '90 seconds') )
     ORDER BY requested_at DESC LIMIT 1`,
    [sessionId, mediaMs, receivedAt],
  );
  return rows[0] ?? null;
}

const ALLOWED: Record<ClipJobState, ClipJobState[]> = {
  requested: ["processing", "failed"],
  processing: ["ready", "failed"],
  ready: ["expired"],
  failed: [],
  expired: [],
};

/** Guarded state transition. Returns null if the transition is not allowed from the current state. */
export async function transitionClipJob(
  db: Queryable,
  id: string,
  to: ClipJobState,
  patch: Partial<{
    mediaState: ClipMediaState;
    twitchClipId: string;
    editUrl: string;
    clipUrl: string;
    embedUrl: string;
    thumbnailUrl: string;
    durationMs: number;
    landscapeAssetId: string;
    portraitAssetId: string;
    sourceResolution: string;
    errorCode: string | null;
    errorMessage: string | null;
    expiresAt: Date;
  }> = {},
): Promise<ClipJobRow | null> {
  const from = (Object.entries(ALLOWED) as [ClipJobState, ClipJobState[]][]).filter(([, tos]) => tos.includes(to)).map(([f]) => f);
  const { rows } = await db.query<ClipJobRow>(
    `UPDATE clip_jobs SET state = $2,
       media_state = COALESCE($4, media_state), twitch_clip_id = COALESCE($5, twitch_clip_id), edit_url = COALESCE($6, edit_url),
       clip_url = COALESCE($7, clip_url), embed_url = COALESCE($8, embed_url), thumbnail_url = COALESCE($9, thumbnail_url),
       duration_ms = COALESCE($10, duration_ms), landscape_asset_id = COALESCE($11, landscape_asset_id),
       portrait_asset_id = COALESCE($12, portrait_asset_id), source_resolution = COALESCE($13, source_resolution),
       error_code = CASE WHEN $14 THEN $15 ELSE error_code END, error_message = CASE WHEN $14 THEN $16 ELSE error_message END,
       expires_at = COALESCE($17, expires_at), ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE ready_at END,
       attempts = attempts + CASE WHEN $2 = 'processing' THEN 1 ELSE 0 END, updated_at = now()
     WHERE id = $1 AND state = ANY($3::text[]) RETURNING *`,
    [
      id,
      to,
      from,
      patch.mediaState ?? null,
      patch.twitchClipId ?? null,
      patch.editUrl ?? null,
      patch.clipUrl ?? null,
      patch.embedUrl ?? null,
      patch.thumbnailUrl ?? null,
      patch.durationMs ?? null,
      patch.landscapeAssetId ?? null,
      patch.portraitAssetId ?? null,
      patch.sourceResolution ?? null,
      patch.errorCode !== undefined || patch.errorMessage !== undefined,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      patch.expiresAt ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function setClipMediaState(
  db: Queryable,
  id: string,
  mediaState: ClipMediaState,
  extra: Partial<{ landscapeAssetId: string; portraitAssetId: string; errorMessage: string | null }> = {},
) {
  const { rows } = await db.query<ClipJobRow>(
    `UPDATE clip_jobs SET media_state = $2, landscape_asset_id = COALESCE($3, landscape_asset_id),
       portrait_asset_id = COALESCE($4, portrait_asset_id), error_message = COALESCE($5, error_message), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, mediaState, extra.landscapeAssetId ?? null, extra.portraitAssetId ?? null, extra.errorMessage ?? null],
  );
  return rows[0] ?? null;
}

export async function expireOldClipLinks(db: Queryable) {
  // Twitch clip edit URLs are valid for up to 24 hours; downloaded media URLs are short-lived.
  await db.query(`UPDATE clip_jobs SET edit_url = NULL WHERE edit_url IS NOT NULL AND requested_at < now() - interval '24 hours'`);
}
