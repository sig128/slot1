import type { AssetKind, SourceKind, SourceLabel } from "@slot1/contracts";
import type { Queryable } from "./client";

export interface MediaSourceRow {
  id: string;
  broadcaster_id: string;
  session_id: string | null;
  kind: SourceKind;
  label: SourceLabel;
  name: string;
  status: "pending" | "processing" | "ready" | "awaiting_publisher" | "publishing" | "idle" | "revoked" | "failed" | "deleted";
  original_asset_id: string | null;
  playback_asset_id: string | null;
  publish_path: string | null;
  publish_key_hash: Buffer | null;
  publish_key_hint: string | null;
  publisher_ip: string | null;
  publish_started_at: Date | null;
  publish_ended_at: Date | null;
  revoked_at: Date | null;
  probe: ProbeJson | null;
  error: string | null;
  created_at: Date;
  /** Boxes hidden from the AI (fractions of the picture); empty when nothing is hidden. */
  camera_mask: { x: number; y: number; w: number; h: number }[];
}

export interface ProbeJson {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  sizeBytes: number | null;
  formatName: string | null;
}

const M_COLS = `id, broadcaster_id, session_id, kind, label, name, status, original_asset_id, playback_asset_id, publish_path,
  publish_key_hash, publish_key_hint, publisher_ip, publish_started_at, publish_ended_at, revoked_at, probe, error, created_at, camera_mask`;

export async function createUploadSource(db: Queryable, broadcasterId: string, sessionId: string, name: string): Promise<MediaSourceRow> {
  const { rows } = await db.query<MediaSourceRow>(
    `INSERT INTO media_sources (broadcaster_id, session_id, kind, label, name, status) VALUES ($1, $2, 'upload', 'replay', $3, 'pending')
     RETURNING ${M_COLS}`,
    [broadcasterId, sessionId, name],
  );
  return rows[0]!;
}

export async function createClipSource(db: Queryable, broadcasterId: string, sessionId: string, name: string): Promise<MediaSourceRow> {
  const { rows } = await db.query<MediaSourceRow>(
    `INSERT INTO media_sources (broadcaster_id, session_id, kind, label, name, status) VALUES ($1, $2, 'twitch_clip', 'clip', $3, 'processing')
     RETURNING ${M_COLS}`,
    [broadcasterId, sessionId, name],
  );
  return rows[0]!;
}

export async function createIngestSource(
  db: Queryable,
  input: { broadcasterId: string; name: string; label: "live" | "test"; publishPath: string; keyHash: Buffer; keyHint: string },
): Promise<MediaSourceRow> {
  const { rows } = await db.query<MediaSourceRow>(
    `INSERT INTO media_sources (broadcaster_id, kind, label, name, status, publish_path, publish_key_hash, publish_key_hint)
     VALUES ($1, 'live_ingest', $2, $3, 'awaiting_publisher', $4, $5, $6) RETURNING ${M_COLS}`,
    [input.broadcasterId, input.label, input.name, input.publishPath, input.keyHash, input.keyHint],
  );
  return rows[0]!;
}

export async function getSource(db: Queryable, id: string): Promise<MediaSourceRow | null> {
  const { rows } = await db.query<MediaSourceRow>(`SELECT ${M_COLS} FROM media_sources WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getSourceByPublishPath(db: Queryable, publishPath: string): Promise<MediaSourceRow | null> {
  const { rows } = await db.query<MediaSourceRow>(`SELECT ${M_COLS} FROM media_sources WHERE publish_path = $1`, [publishPath]);
  return rows[0] ?? null;
}

export async function listSources(db: Queryable, broadcasterId: string): Promise<MediaSourceRow[]> {
  const { rows } = await db.query<MediaSourceRow>(
    `SELECT ${M_COLS} FROM media_sources WHERE broadcaster_id = $1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT 50`,
    [broadcasterId],
  );
  return rows;
}

export async function listPublishingSources(db: Queryable): Promise<MediaSourceRow[]> {
  const { rows } = await db.query<MediaSourceRow>(
    `SELECT ${M_COLS} FROM media_sources WHERE kind = 'live_ingest' AND status = 'publishing' AND revoked_at IS NULL`,
  );
  return rows;
}

/**
 * Set the boxes hidden from the AI on one of the creator's live sources. Returns null when the
 * source isn't theirs, isn't a live source, or was revoked.
 */
export async function setSourceCameraMask(
  db: Queryable,
  broadcasterId: string,
  id: string,
  boxes: { x: number; y: number; w: number; h: number }[],
): Promise<MediaSourceRow | null> {
  const { rows } = await db.query<MediaSourceRow>(
    `UPDATE media_sources SET camera_mask = $3::jsonb, updated_at = now()
     WHERE id = $1 AND broadcaster_id = $2 AND kind = 'live_ingest' AND revoked_at IS NULL AND status <> 'deleted'
     RETURNING ${M_COLS}`,
    [id, broadcasterId, JSON.stringify(boxes)],
  );
  return rows[0] ?? null;
}

export async function updateSourceStatus(db: Queryable, id: string, status: MediaSourceRow["status"], error: string | null = null) {
  await db.query(`UPDATE media_sources SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [id, status, error]);
}

export async function setSourceProbe(db: Queryable, id: string, probe: ProbeJson) {
  await db.query(`UPDATE media_sources SET probe = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(probe)]);
}

export async function setSourceAssets(db: Queryable, id: string, originalAssetId: string | null, playbackAssetId: string | null) {
  await db.query(
    `UPDATE media_sources SET original_asset_id = COALESCE($2, original_asset_id), playback_asset_id = COALESCE($3, playback_asset_id),
       updated_at = now() WHERE id = $1`,
    [id, originalAssetId, playbackAssetId],
  );
}

export async function setSourceSession(db: Queryable, id: string, sessionId: string | null) {
  await db.query(`UPDATE media_sources SET session_id = $2, updated_at = now() WHERE id = $1`, [id, sessionId]);
}

export async function markPublishing(db: Queryable, id: string, ip: string | null) {
  await db.query(
    `UPDATE media_sources SET status = 'publishing', publisher_ip = $2, publish_started_at = now(), publish_ended_at = NULL, updated_at = now()
     WHERE id = $1 AND revoked_at IS NULL`,
    [id, ip],
  );
}

export async function markPublishEnded(db: Queryable, id: string) {
  await db.query(
    `UPDATE media_sources SET status = CASE WHEN status = 'publishing' THEN 'idle' ELSE status END, publish_ended_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

export async function revokeSource(db: Queryable, broadcasterId: string, id: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE media_sources SET status = 'revoked', revoked_at = now(), publish_key_hash = NULL, updated_at = now()
     WHERE id = $2 AND broadcaster_id = $1 AND kind = 'live_ingest' AND revoked_at IS NULL`,
    [broadcasterId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function revokeAllIngestSources(db: Queryable, broadcasterId: string) {
  await db.query(
    `UPDATE media_sources SET status = 'revoked', revoked_at = now(), publish_key_hash = NULL, updated_at = now()
     WHERE broadcaster_id = $1 AND kind = 'live_ingest' AND revoked_at IS NULL`,
    [broadcasterId],
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Source health                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface SourceHealthRow {
  source_id: string;
  state: string;
  frames_received: number;
  frames_analyzed: number;
  frames_dropped: number;
  last_frame_at: Date | null;
  last_analyzed_at: Date | null;
  last_frame_asset_id: string | null;
  last_frame_pts_ms: number | null;
  cadence_ms: number | null;
  delay_ms: number | null;
  error: string | null;
  updated_at: Date;
}

export async function upsertSourceHealth(
  db: Queryable,
  sourceId: string,
  h: Partial<{
    state: string;
    framesReceivedDelta: number;
    framesAnalyzedDelta: number;
    framesDroppedDelta: number;
    lastFrameAt: Date;
    lastAnalyzedAt: Date;
    lastFrameAssetId: string;
    lastFramePtsMs: number;
    cadenceMs: number;
    delayMs: number;
    error: string | null;
  }>,
): Promise<SourceHealthRow> {
  const { rows } = await db.query<SourceHealthRow>(
    `INSERT INTO source_health (source_id, state, frames_received, frames_analyzed, frames_dropped, last_frame_at, last_analyzed_at,
        last_frame_asset_id, last_frame_pts_ms, cadence_ms, delay_ms, error)
     VALUES ($1, COALESCE($2, 'ready'), COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, 0), $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (source_id) DO UPDATE SET
       state = COALESCE($2, source_health.state),
       frames_received = source_health.frames_received + COALESCE($3, 0),
       frames_analyzed = source_health.frames_analyzed + COALESCE($4, 0),
       frames_dropped = source_health.frames_dropped + COALESCE($5, 0),
       last_frame_at = COALESCE($6, source_health.last_frame_at),
       last_analyzed_at = COALESCE($7, source_health.last_analyzed_at),
       last_frame_asset_id = COALESCE($8, source_health.last_frame_asset_id),
       last_frame_pts_ms = COALESCE($9, source_health.last_frame_pts_ms),
       cadence_ms = COALESCE($10, source_health.cadence_ms),
       delay_ms = COALESCE($11, source_health.delay_ms),
       error = CASE WHEN $13 THEN $12 ELSE source_health.error END,
       updated_at = now()
     RETURNING *`,
    [
      sourceId,
      h.state ?? null,
      h.framesReceivedDelta ?? null,
      h.framesAnalyzedDelta ?? null,
      h.framesDroppedDelta ?? null,
      h.lastFrameAt ?? null,
      h.lastAnalyzedAt ?? null,
      h.lastFrameAssetId ?? null,
      h.lastFramePtsMs ?? null,
      h.cadenceMs ?? null,
      h.delayMs ?? null,
      h.error ?? null,
      h.error !== undefined,
    ],
  );
  return rows[0]!;
}

export async function getSourceHealth(db: Queryable, sourceId: string): Promise<SourceHealthRow | null> {
  const { rows } = await db.query<SourceHealthRow>(`SELECT * FROM source_health WHERE source_id = $1`, [sourceId]);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------------------------------ */
/* Evidence assets                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface AssetRow {
  id: string;
  broadcaster_id: string;
  session_id: string | null;
  source_id: string | null;
  kind: AssetKind;
  storage_key: string;
  content_type: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  media_pts_ms: number | null;
  sha256: string | null;
  created_at: Date;
  expires_at: Date | null;
  deleted_at: Date | null;
}

export async function insertAsset(
  db: Queryable,
  a: {
    broadcasterId: string;
    sessionId: string | null;
    sourceId: string | null;
    kind: AssetKind;
    storageKey: string;
    contentType: string;
    bytes: number | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    mediaPtsMs?: number | null;
    sha256?: string | null;
    expiresAt?: Date | null;
  },
): Promise<AssetRow> {
  const { rows } = await db.query<AssetRow>(
    `INSERT INTO evidence_assets (broadcaster_id, session_id, source_id, kind, storage_key, content_type, bytes, width, height, duration_ms, media_pts_ms, sha256, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (storage_key) DO UPDATE SET bytes = EXCLUDED.bytes, deleted_at = NULL
     RETURNING *`,
    [
      a.broadcasterId,
      a.sessionId,
      a.sourceId,
      a.kind,
      a.storageKey,
      a.contentType,
      a.bytes,
      a.width ?? null,
      a.height ?? null,
      a.durationMs ?? null,
      a.mediaPtsMs ?? null,
      a.sha256 ?? null,
      a.expiresAt ?? null,
    ],
  );
  return rows[0]!;
}

export async function getAsset(db: Queryable, id: string): Promise<AssetRow | null> {
  const { rows } = await db.query<AssetRow>(`SELECT * FROM evidence_assets WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}

export async function getAssets(db: Queryable, ids: string[]): Promise<AssetRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<AssetRow>(`SELECT * FROM evidence_assets WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]);
  return rows;
}

export async function listSessionAssets(db: Queryable, sessionId: string): Promise<AssetRow[]> {
  const { rows } = await db.query<AssetRow>(`SELECT * FROM evidence_assets WHERE session_id = $1 AND deleted_at IS NULL`, [sessionId]);
  return rows;
}

export async function firstFrameAsset(db: Queryable, sessionId: string): Promise<AssetRow | null> {
  const { rows } = await db.query<AssetRow>(
    `SELECT * FROM evidence_assets WHERE session_id = $1 AND kind IN ('thumbnail', 'frame') AND deleted_at IS NULL
     ORDER BY (kind = 'thumbnail') DESC, media_pts_ms ASC NULLS LAST LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

export async function markAssetsDeleted(db: Queryable, ids: string[]) {
  if (ids.length === 0) return;
  await db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}

export async function listExpiredAssets(db: Queryable, limit = 500): Promise<AssetRow[]> {
  const { rows } = await db.query<AssetRow>(
    `SELECT * FROM evidence_assets WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < now() LIMIT $1`,
    [limit],
  );
  return rows;
}
