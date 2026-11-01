import type { Edl, LibraryItemKind, LibraryVisibility } from "@slot1/contracts";
import type pg from "pg";
import { withTx, type Queryable } from "./client";

/* ------------------------------------------------------------------------------------------ */
/* Recordings                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface RecordingSegment {
  key: string;
  /** Segment start/end in the reader run's own timeline (same clock as live frame PTS). */
  startMs: number;
  endMs: number;
  bytes: number;
}

export interface RecordingRun {
  runId: string;
  wallStart: string;
  wallEnd: string | null;
  segments: RecordingSegment[];
}

export interface RecordingRow {
  id: string;
  broadcaster_id: string;
  session_id: string;
  live_source_id: string | null;
  source_id: string | null;
  status: "recording" | "finalizing" | "ready" | "failed" | "expired";
  runs: RecordingRun[];
  rebased_until: Date | null;
  duration_ms: number | null;
  bytes: number | null;
  error: string | null;
  expires_at: Date | null;
  started_at: Date;
  finalized_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const mapRecording = (r: RecordingRow): RecordingRow => ({ ...r, duration_ms: num(r.duration_ms), bytes: num(r.bytes) });

export async function getRecording(db: Queryable, id: string): Promise<RecordingRow | null> {
  const { rows } = await db.query<RecordingRow>(`SELECT * FROM recordings WHERE id = $1`, [id]);
  return rows[0] ? mapRecording(rows[0]) : null;
}

export async function getRecordingBySession(db: Queryable, sessionId: string): Promise<RecordingRow | null> {
  const { rows } = await db.query<RecordingRow>(`SELECT * FROM recordings WHERE session_id = $1`, [sessionId]);
  return rows[0] ? mapRecording(rows[0]) : null;
}

export async function listRecordings(db: Queryable, broadcasterId: string, limit = 100): Promise<RecordingRow[]> {
  const { rows } = await db.query<RecordingRow>(`SELECT * FROM recordings WHERE broadcaster_id = $1 ORDER BY created_at DESC LIMIT $2`, [broadcasterId, limit]);
  return rows.map(mapRecording);
}

/** Create the session's recording, or reopen it when the publisher returns to the same session. */
export async function ensureRecording(db: Queryable, input: { broadcasterId: string; sessionId: string; liveSourceId: string }): Promise<RecordingRow> {
  const { rows } = await db.query<RecordingRow>(
    `INSERT INTO recordings (broadcaster_id, session_id, live_source_id) VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET
       status = CASE WHEN recordings.status = 'expired' THEN recordings.status ELSE 'recording' END,
       updated_at = now()
     RETURNING *`,
    [input.broadcasterId, input.sessionId, input.liveSourceId],
  );
  return mapRecording(rows[0]!);
}

/** Read-modify-write of one run under a row lock (segments arrive every few seconds). */
export async function updateRecordingRun(pool: pg.Pool, recordingId: string, runId: string, change: (run: RecordingRun) => RecordingRun, wallStart?: string) {
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ runs: RecordingRun[] }>(`SELECT runs FROM recordings WHERE id = $1 FOR UPDATE`, [recordingId]);
    if (!rows[0]) return;
    const runs = rows[0].runs;
    let idx = runs.findIndex((r) => r.runId === runId);
    if (idx < 0) {
      runs.push({ runId, wallStart: wallStart ?? new Date().toISOString(), wallEnd: null, segments: [] });
      idx = runs.length - 1;
    }
    runs[idx] = change(runs[idx]!);
    await tx.query(`UPDATE recordings SET runs = $2, updated_at = now() WHERE id = $1`, [recordingId, JSON.stringify(runs)]);
  });
}

export async function setRecordingStatus(db: Queryable, id: string, status: RecordingRow["status"], error: string | null = null) {
  await db.query(`UPDATE recordings SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [id, status, error]);
}

export async function markRecordingReady(
  db: Queryable,
  id: string,
  v: { sourceId: string; durationMs: number; bytes: number; expiresAt: Date; rebasedUntil: Date | null },
) {
  await db.query(
    `UPDATE recordings SET status = 'ready', source_id = $2, duration_ms = $3, bytes = $4, expires_at = $5,
       rebased_until = COALESCE($6, rebased_until), finalized_at = now(), error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, v.sourceId, Math.round(v.durationMs), v.bytes, v.expiresAt, v.rebasedUntil],
  );
}

export async function listExpiredRecordings(db: Queryable, limit = 50): Promise<RecordingRow[]> {
  const { rows } = await db.query<RecordingRow>(`SELECT * FROM recordings WHERE status = 'ready' AND expires_at < now() ORDER BY expires_at LIMIT $1`, [limit]);
  return rows.map(mapRecording);
}

/* ------------------------------------------------------------------------------------------ */
/* Edit projects                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface EditProjectRow {
  id: string;
  broadcaster_id: string;
  title: string;
  origin: "manual" | "auto";
  auto_key: string | null;
  edl: Edl;
  source_observation_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Returns null when an auto clip for the same key already exists (idempotent). */
export async function createProject(
  db: Queryable,
  p: { broadcasterId: string; title: string; origin: "manual" | "auto"; autoKey?: string | null; edl: Edl; sourceObservationId?: string | null; userId?: string | null },
): Promise<EditProjectRow | null> {
  const { rows } = await db.query<EditProjectRow>(
    `INSERT INTO edit_projects (broadcaster_id, title, origin, auto_key, edl, source_observation_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (broadcaster_id, auto_key) DO NOTHING RETURNING *`,
    [p.broadcasterId, p.title, p.origin, p.autoKey ?? null, JSON.stringify(p.edl), p.sourceObservationId ?? null, p.userId ?? null],
  );
  return rows[0] ?? null;
}

export async function getProject(db: Queryable, id: string): Promise<EditProjectRow | null> {
  const { rows } = await db.query<EditProjectRow>(`SELECT * FROM edit_projects WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listProjects(db: Queryable, broadcasterId: string, limit = 100): Promise<EditProjectRow[]> {
  const { rows } = await db.query<EditProjectRow>(`SELECT * FROM edit_projects WHERE broadcaster_id = $1 ORDER BY updated_at DESC LIMIT $2`, [broadcasterId, limit]);
  return rows;
}

export async function updateProject(db: Queryable, id: string, patch: { title?: string; edl?: Edl }): Promise<EditProjectRow | null> {
  const { rows } = await db.query<EditProjectRow>(
    `UPDATE edit_projects SET title = COALESCE($2, title), edl = COALESCE($3::jsonb, edl), updated_at = now() WHERE id = $1 RETURNING *`,
    [id, patch.title ?? null, patch.edl ? JSON.stringify(patch.edl) : null],
  );
  return rows[0] ?? null;
}

export async function deleteProject(db: Queryable, id: string) {
  await db.query(`DELETE FROM edit_projects WHERE id = $1`, [id]);
}

/**
 * An auto clip already covering this moment (same text, same session and timeline, overlapping
 * window), so one MISSION PASSED read on several frames or by two engines makes one clip.
 */
export async function findOverlappingAutoProject(
  db: Queryable,
  p: { broadcasterId: string; sessionId: string; runId: string | null; title: string; inMs: number; outMs: number },
): Promise<EditProjectRow | null> {
  const { rows } = await db.query<EditProjectRow>(
    `SELECT * FROM edit_projects
      WHERE broadcaster_id = $1 AND origin = 'auto' AND title = $2
        AND edl->'segments'->0->>'sessionId' = $3
        AND COALESCE(edl->'segments'->0->>'runId', '') = $4
        AND (edl->'segments'->0->>'inMs')::bigint < $6
        AND (edl->'segments'->0->>'outMs')::bigint > $5
      LIMIT 1`,
    [p.broadcasterId, p.title, p.sessionId, p.runId ?? "", p.inMs, p.outMs],
  );
  return rows[0] ?? null;
}

/** Projects whose segments point into a recording's per-run timeline (live auto clips). */
export async function listProjectsReferencingSession(db: Queryable, broadcasterId: string, sessionId: string): Promise<EditProjectRow[]> {
  const { rows } = await db.query<EditProjectRow>(
    `SELECT * FROM edit_projects WHERE broadcaster_id = $1 AND edl->'segments' @> $2::jsonb`,
    [broadcasterId, JSON.stringify([{ sessionId }])],
  );
  return rows;
}

/* ------------------------------------------------------------------------------------------ */
/* Library                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface LibraryItemRow {
  id: string;
  broadcaster_id: string;
  kind: LibraryItemKind;
  title: string;
  visibility: LibraryVisibility;
  featured: boolean;
  status: "processing" | "ready" | "failed";
  error: string | null;
  session_id: string | null;
  recording_id: string | null;
  project_id: string | null;
  clip_job_id: string | null;
  job_run_id: string | null;
  asset_id: string | null;
  poster_asset_id: string | null;
  external_url: string | null;
  media_ms: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  bytes: number | null;
  created_at: Date;
  updated_at: Date;
  /** Joined from edit_projects when listed: auto clips are renders of auto projects. */
  project_origin?: "manual" | "auto" | null;
}

/** Library rows with their project's origin (auto clip or manual edit). */
const ITEM_SELECT = `SELECT l.*, p.origin AS project_origin FROM library_items l LEFT JOIN edit_projects p ON p.id = l.project_id`;

const mapItem = (r: LibraryItemRow): LibraryItemRow => ({ ...r, media_ms: num(r.media_ms), duration_ms: num(r.duration_ms), bytes: num(r.bytes) });

export interface NewLibraryItem {
  broadcasterId: string;
  kind: LibraryItemKind;
  title: string;
  status?: LibraryItemRow["status"];
  visibility?: LibraryVisibility;
  sessionId?: string | null;
  recordingId?: string | null;
  projectId?: string | null;
  clipJobId?: string | null;
  jobRunId?: string | null;
  assetId?: string | null;
  posterAssetId?: string | null;
  externalUrl?: string | null;
  mediaMs?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  bytes?: number | null;
}

export async function insertLibraryItem(db: Queryable, i: NewLibraryItem): Promise<LibraryItemRow> {
  const { rows } = await db.query<LibraryItemRow>(
    `INSERT INTO library_items (broadcaster_id, kind, title, status, visibility, session_id, recording_id, project_id, clip_job_id, job_run_id,
       asset_id, poster_asset_id, external_url, media_ms, width, height, duration_ms, bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
    [
      i.broadcasterId,
      i.kind,
      i.title.slice(0, 120),
      i.status ?? "ready",
      i.visibility ?? "private",
      i.sessionId ?? null,
      i.recordingId ?? null,
      i.projectId ?? null,
      i.clipJobId ?? null,
      i.jobRunId ?? null,
      i.assetId ?? null,
      i.posterAssetId ?? null,
      i.externalUrl ?? null,
      i.mediaMs ?? null,
      i.width ?? null,
      i.height ?? null,
      i.durationMs ?? null,
      i.bytes ?? null,
    ],
  );
  return mapItem(rows[0]!);
}

export async function getLibraryItem(db: Queryable, id: string): Promise<LibraryItemRow | null> {
  const { rows } = await db.query<LibraryItemRow>(`${ITEM_SELECT} WHERE l.id = $1`, [id]);
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function getLibraryItemForRecording(db: Queryable, recordingId: string): Promise<LibraryItemRow | null> {
  const { rows } = await db.query<LibraryItemRow>(`SELECT * FROM library_items WHERE recording_id = $1`, [recordingId]);
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function listLibraryItems(
  db: Queryable,
  broadcasterId: string,
  f: { kind?: LibraryItemKind; visibility?: LibraryVisibility; publicOnly?: boolean; projectId?: string; limit?: number } = {},
): Promise<LibraryItemRow[]> {
  const where = ["l.broadcaster_id = $1"];
  const values: unknown[] = [broadcasterId];
  if (f.projectId) {
    values.push(f.projectId);
    where.push(`l.project_id = $${values.length}`);
  }
  if (f.kind) {
    values.push(f.kind);
    where.push(`l.kind = $${values.length}`);
  }
  if (f.visibility) {
    values.push(f.visibility);
    where.push(`l.visibility = $${values.length}`);
  }
  if (f.publicOnly) where.push(`l.visibility = 'public' AND l.status = 'ready'`);
  values.push(f.limit ?? 200);
  const { rows } = await db.query<LibraryItemRow>(
    `${ITEM_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.featured DESC, l.created_at DESC LIMIT $${values.length}`,
    values,
  );
  return rows.map(mapItem);
}

export async function updateLibraryItem(
  db: Queryable,
  id: string,
  p: Partial<{
    title: string;
    visibility: LibraryVisibility;
    featured: boolean;
    status: LibraryItemRow["status"];
    error: string | null;
    assetId: string | null;
    posterAssetId: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    bytes: number | null;
    jobRunId: string | null;
  }>,
): Promise<LibraryItemRow | null> {
  const cols: Record<string, string> = {
    title: "title",
    visibility: "visibility",
    featured: "featured",
    status: "status",
    error: "error",
    assetId: "asset_id",
    posterAssetId: "poster_asset_id",
    width: "width",
    height: "height",
    durationMs: "duration_ms",
    bytes: "bytes",
    jobRunId: "job_run_id",
  };
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || !cols[k]) continue;
    values.push(v);
    sets.push(`${cols[k]} = $${values.length}`);
  }
  if (sets.length === 0) return getLibraryItem(db, id);
  const { rows } = await db.query<LibraryItemRow>(`UPDATE library_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, values);
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function deleteLibraryItem(db: Queryable, id: string) {
  await db.query(`DELETE FROM library_items WHERE id = $1`, [id]);
}

/** Library rows for clip jobs, so Twitch and rendered clips appear in the library too. */
export async function upsertLibraryItemForClipJob(
  db: Queryable,
  c: { id: string; broadcaster_id: string; session_id: string; kind: string; clip_url: string | null; landscape_asset_id: string | null; portrait_asset_id: string | null; duration_ms: number | null; caption: string | null },
) {
  const twitch = c.kind !== "owned_render";
  const assetId = twitch ? null : (c.portrait_asset_id ?? c.landscape_asset_id);
  if (twitch && !c.clip_url) return;
  if (!twitch && !assetId) return;
  await db.query(
    `INSERT INTO library_items (broadcaster_id, kind, title, status, session_id, clip_job_id, asset_id, external_url, duration_ms)
     VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, $8)
     ON CONFLICT (clip_job_id) WHERE clip_job_id IS NOT NULL DO UPDATE SET asset_id = EXCLUDED.asset_id, external_url = EXCLUDED.external_url,
       duration_ms = EXCLUDED.duration_ms, status = 'ready', updated_at = now()`,
    [c.broadcaster_id, twitch ? "twitch_clip" : "clip_export", (c.caption || (twitch ? "Twitch clip" : "Clip")).slice(0, 120), c.session_id, c.id, assetId, twitch ? c.clip_url : null, c.duration_ms],
  );
}

/** Bytes stored per category for one channel (live assets only). */
export async function storageUsage(db: Queryable, broadcasterId: string): Promise<{ recordings: number; library: number; uploads: number; analysis: number; total: number }> {
  const { rows } = await db.query<{ cat: string; bytes: string | null }>(
    `SELECT CASE
        WHEN a.storage_key LIKE 'b/' || $1::text || '/library/%' THEN 'library'
        WHEN a.kind = 'recording_segment' OR s.kind = 'recording' THEN 'recordings'
        WHEN a.kind IN ('original', 'playback') THEN 'uploads'
        ELSE 'analysis' END AS cat,
       sum(a.bytes)::text AS bytes
     FROM evidence_assets a LEFT JOIN media_sources s ON s.id = a.source_id
     WHERE a.broadcaster_id = $1::uuid AND a.deleted_at IS NULL
     GROUP BY 1`,
    [broadcasterId],
  );
  const out = { recordings: 0, library: 0, uploads: 0, analysis: 0, total: 0 };
  for (const r of rows) {
    const v = Number(r.bytes ?? 0);
    if (r.cat in out) (out as Record<string, number>)[r.cat] = v;
    out.total += v;
  }
  return out;
}

/** The media source that makes a finalized recording playable and clippable like an upload. */
export async function createRecordingSource(db: Queryable, r: { broadcasterId: string; sessionId: string; label: "live" | "test"; name: string }): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_sources (broadcaster_id, session_id, kind, label, name, status) VALUES ($1, $2, 'recording', $3, $4, 'ready') RETURNING id`,
    [r.broadcasterId, r.sessionId, r.label, r.name.slice(0, 120)],
  );
  return rows[0]!;
}
