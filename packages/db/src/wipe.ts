import { withTx, type DbPool, type Queryable } from "./client";
import { learningWatched } from "./learning";

/**
 * Admin → Wipe data: every stream SLOT1 has and everything its AI found, kept, heard and learned
 * from them — findings, frames, speech, missions, clips, recordings, the media library, training
 * frames, labels, datasets and models. Accounts, channels and their settings, stream keys,
 * featured channels, admin settings, visitor stats, messages and the AI cost log stay.
 */

export interface WipeCountsRow {
  streams: number;
  findings: number;
  files: number;
  speech: number;
  missions: number;
  trainingFrames: number;
  clips: number;
  library: number;
  models: number;
  hoursWatched: number;
}

export async function wipeCounts(db: Queryable): Promise<WipeCountsRow> {
  const { rows } = await db.query<{
    streams: number;
    findings: number;
    files: number;
    speech: number;
    missions: number;
    training_frames: number;
    clips: number;
    library: number;
    models: number;
  }>(
    `SELECT (SELECT count(*) FROM stream_sessions)::int AS streams,
            (SELECT count(*) FROM observations)::int AS findings,
            (SELECT count(*) FROM evidence_assets WHERE deleted_at IS NULL)::int AS files,
            (SELECT count(*) FROM transcripts)::int AS speech,
            (SELECT count(*) FROM mission_attempts)::int AS missions,
            (SELECT count(*) FROM training_frames)::int AS training_frames,
            (SELECT count(*) FROM clip_jobs)::int AS clips,
            ((SELECT count(*) FROM library_items) + (SELECT count(*) FROM project_media))::int AS library,
            (SELECT count(*) FROM models)::int AS models`,
  );
  const r = rows[0]!;
  const watched = await learningWatched(db);
  return {
    streams: r.streams,
    findings: r.findings,
    files: r.files,
    speech: r.speech,
    missions: r.missions,
    trainingFrames: r.training_frames,
    clips: r.clips,
    library: r.library,
    models: r.models,
    hoursWatched: Math.round((watched.analyzedMs / 3_600_000) * 10) / 10,
  };
}

/**
 * Streams sending video to SLOT1 right now: open, with a frame in the last two minutes. A wipe
 * waits for them, since their reader writes as it goes. A source whose status is stuck on
 * "publishing" with no frames arriving doesn't block it.
 */
export async function streamsSendingVideo(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM stream_sessions
      WHERE kind = 'ingest' AND ended_at IS NULL AND last_received_frame_at > now() - interval '2 minutes'`,
  );
  return rows[0]?.n ?? 0;
}

export interface WipeResult {
  /** What was there just before the wipe. */
  deleted: WipeCountsRow;
  /** Storage prefixes (each ends in "/") and single keys whose files go once the rows are gone. */
  prefixes: string[];
  keys: string[];
}

/**
 * Delete the rows in one transaction, so nothing half-wiped ever shows. Deleting the sessions
 * cascades to their findings, frames, speech, moments, clips, recordings, missions and training
 * frames (with their labels). Only the files the deleted rows pointed to are listed for removal,
 * so a stream that starts after the wipe keeps its files.
 */
export async function wipeStreamAndLearningData(pool: DbPool): Promise<WipeResult> {
  return withTx(pool, async (c) => {
    const deleted = await wipeCounts(c);
    const prefixes: string[] = [];
    const keys: string[] = [];

    const sessions = await c.query<{ id: string; broadcaster_id: string }>(`SELECT id, broadcaster_id FROM stream_sessions`);
    for (const s of sessions.rows) prefixes.push(`b/${s.broadcaster_id}/s/${s.id}/`);
    // Library items, editor media and editor projects (their generated captions) each own a folder.
    const owned = await c.query<{ id: string; broadcaster_id: string }>(
      `SELECT id, broadcaster_id FROM library_items
       UNION ALL SELECT id, broadcaster_id FROM project_media
       UNION ALL SELECT id, broadcaster_id FROM edit_projects`,
    );
    for (const o of owned.rows) prefixes.push(`b/${o.broadcaster_id}/library/${o.id}/`);
    // Files not under a session folder (renders, uploads not yet tied to a session) and model files.
    const loose = await c.query<{ key: string }>(
      `SELECT storage_key AS key FROM evidence_assets WHERE session_id IS NULL AND deleted_at IS NULL AND storage_key IS NOT NULL
       UNION SELECT onnx_storage_key AS key FROM models WHERE onnx_storage_key IS NOT NULL`,
    );
    for (const l of loose.rows) keys.push(l.key);

    await c.query(`DELETE FROM library_items`);
    await c.query(`DELETE FROM project_media`);
    await c.query(`DELETE FROM edit_projects`);
    await c.query(`DELETE FROM dataset_versions`);
    await c.query(`DELETE FROM models`);
    await c.query(`DELETE FROM stream_sessions`);
    // Upload, clip, recording and featured-picture sources belong to the deleted streams. A
    // creator's stream key (live_ingest) stays, so their setup keeps working.
    await c.query(`DELETE FROM media_sources WHERE kind <> 'live_ingest'`);
    await c.query(`DELETE FROM evidence_assets`);
    await c.query(`DELETE FROM training_frames`);
    return { deleted, prefixes, keys };
  });
}
