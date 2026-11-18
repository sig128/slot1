import { withTx, type DbPool, type Queryable } from "./client";
import { learningWatched } from "./learning";

/**
 * Admin → Wipe data: what SLOT1's AI found, kept, heard and learned — findings, the frames it
 * stored, speech, missions, training frames, labels, datasets and models — and the hours-watched
 * counter. The streams themselves stay, with their recordings, clips, media library, accounts,
 * channels and settings, stream keys, featured channels, admin settings, visitor stats, messages
 * and the AI cost log.
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
 * Delete the learning rows in one transaction, so nothing half-wiped ever shows. Stream sessions,
 * their recordings, clips, the media library and every media source stay. Only files the removed
 * AI rows pointed to are listed, so a recording under the same session folder is left on disk.
 */
export async function wipeStreamAndLearningData(pool: DbPool): Promise<WipeResult> {
  return withTx(pool, async (c) => {
    const deleted = await wipeCounts(c);
    const prefixes: string[] = [];
    const keys: string[] = [];

    // Frames, thumbnails and audio the AI stored, plus training pictures and model files.
    // A file a creator's library or a recording still points at stays.
    const loose = await c.query<{ key: string }>(
      `SELECT storage_key AS key FROM evidence_assets e
        WHERE e.deleted_at IS NULL AND e.storage_key IS NOT NULL AND e.kind IN ('frame', 'thumbnail', 'audio_chunk')
          AND NOT EXISTS (SELECT 1 FROM library_items li WHERE li.asset_id = e.id OR li.poster_asset_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM media_sources ms WHERE ms.original_asset_id = e.id OR ms.playback_asset_id = e.id)
       UNION SELECT storage_key AS key FROM training_frames WHERE storage_key IS NOT NULL
       UNION SELECT onnx_storage_key AS key FROM models WHERE onnx_storage_key IS NOT NULL`,
    );
    for (const l of loose.rows) keys.push(l.key);

    await c.query(`DELETE FROM story_events`);
    await c.query(`DELETE FROM mission_attempts`);
    await c.query(`DELETE FROM clip_ai_audio`);
    await c.query(`DELETE FROM saved_moments`);
    await c.query(`DELETE FROM session_events WHERE kind LIKE 'observation.%'`);
    await c.query(`DELETE FROM observations`);
    await c.query(`DELETE FROM transcripts`);
    await c.query(`DELETE FROM models`);
    await c.query(`DELETE FROM dataset_versions`);
    await c.query(`DELETE FROM training_frames`);
    await c.query(
      `DELETE FROM evidence_assets e
        WHERE e.kind IN ('frame', 'thumbnail', 'audio_chunk')
          AND NOT EXISTS (SELECT 1 FROM library_items li WHERE li.asset_id = e.id OR li.poster_asset_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM media_sources ms WHERE ms.original_asset_id = e.id OR ms.playback_asset_id = e.id)`,
    );
    // Hours watched is the sum of analyzed time. Zero it on the streams that stay, so Ask SLOT1
    // starts toward 1,000 hours again. The sessions themselves are not deleted.
    await c.query(
      `UPDATE stream_sessions SET analyzed_ms = 0, frames_analyzed = 0,
              last_analyzed_frame_at = NULL, last_result_at = NULL, stories_refreshed_at = NULL`,
    );
    await c.query(`UPDATE source_health SET frames_analyzed = 0, last_analyzed_at = NULL, last_frame_asset_id = NULL`);
    return { deleted, prefixes, keys };
  });
}
