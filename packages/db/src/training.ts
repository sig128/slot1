import { createHash } from "node:crypto";
import type pg from "pg";
import { splitForSession, type ModelEvaluation, type SubmitLabelsInput } from "@slot1/contracts";
import { withTx, type Queryable } from "./client";

/* ------------------------------------------------------------------------------------------ */
/* Training frames and labels                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface TrainingFrameRow {
  id: string;
  broadcaster_id: string;
  session_id: string;
  source_id: string | null;
  source_kind: "upload" | "twitch_clip" | "live_ingest";
  source_label: "replay" | "test" | "live" | "clip";
  media_pts_ms: string | null;
  storage_key: string;
  width: number;
  height: number;
  bytes: number;
  consent_at: Date;
  status: "unlabeled" | "labeled" | "skipped";
  priority: number;
  labeled_at: Date | null;
  labeled_by: string | null;
  created_at: Date;
  session_title?: string | null;
}

export interface TrainingLabelRow {
  id: string;
  frame_id: string;
  kind: "scene" | "event" | "box";
  class: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  source: "auto_ocr" | "auto_measure" | "model" | "creator" | "labeler";
  status: "proposed" | "accepted" | "rejected";
  confidence: number | null;
  model_id: string | null;
  labeler_user_id: string | null;
  evidence_text: string | null;
  created_at: Date;
}

export interface NewTrainingLabel {
  kind: "scene" | "event" | "box";
  class: string;
  box: { x: number; y: number; w: number; h: number } | null;
  source: TrainingLabelRow["source"];
  status?: TrainingLabelRow["status"];
  confidence: number | null;
  modelId?: string | null;
  labelerUserId?: string | null;
  evidenceText?: string | null;
}

const F_COLS = `f.id, f.broadcaster_id, f.session_id, f.source_id, f.source_kind, f.source_label, f.media_pts_ms, f.storage_key, f.width, f.height,
  f.bytes, f.consent_at, f.status, f.priority, f.labeled_at, f.labeled_by, f.created_at`;

export async function insertTrainingFrame(
  db: Queryable,
  f: {
    broadcasterId: string;
    sessionId: string;
    sourceId: string | null;
    sourceKind: TrainingFrameRow["source_kind"];
    sourceLabel: TrainingFrameRow["source_label"];
    mediaPtsMs: number | null;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    priority: number;
  },
): Promise<TrainingFrameRow> {
  const { rows } = await db.query<TrainingFrameRow>(
    `INSERT INTO training_frames (broadcaster_id, session_id, source_id, source_kind, source_label, media_pts_ms, storage_key, width, height, bytes, consent_at, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)
     RETURNING id, broadcaster_id, session_id, source_id, source_kind, source_label, media_pts_ms, storage_key, width, height, bytes, consent_at, status, priority, labeled_at, labeled_by, created_at`,
    [f.broadcasterId, f.sessionId, f.sourceId, f.sourceKind, f.sourceLabel, f.mediaPtsMs, f.storageKey, f.width, f.height, f.bytes, f.priority],
  );
  return rows[0]!;
}

export async function insertTrainingLabels(db: Queryable, frameId: string, labels: NewTrainingLabel[]): Promise<void> {
  for (const l of labels) {
    await db.query(
      `INSERT INTO training_labels (frame_id, kind, class, x, y, w, h, source, status, confidence, model_id, labeler_user_id, evidence_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING`,
      [
        frameId,
        l.kind,
        l.class,
        l.box?.x ?? null,
        l.box?.y ?? null,
        l.box?.w ?? null,
        l.box?.h ?? null,
        l.source,
        l.status ?? "proposed",
        l.confidence === null ? null : Math.min(1, Math.max(0, l.confidence)),
        l.modelId ?? null,
        l.labelerUserId ?? null,
        l.evidenceText ? l.evidenceText.slice(0, 300) : null,
      ],
    );
  }
}

export async function countSessionTrainingFrames(db: Queryable, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM training_frames WHERE session_id = $1`, [sessionId]);
  return rows[0]?.n ?? 0;
}

export async function getTrainingFrame(db: Queryable, id: string): Promise<TrainingFrameRow | null> {
  const { rows } = await db.query<TrainingFrameRow>(
    `SELECT ${F_COLS}, s.title AS session_title FROM training_frames f JOIN stream_sessions s ON s.id = f.session_id WHERE f.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listFrameLabels(db: Queryable, frameIds: string[]): Promise<TrainingLabelRow[]> {
  if (frameIds.length === 0) return [];
  const { rows } = await db.query<TrainingLabelRow>(
    `SELECT id, frame_id, kind, class, x, y, w, h, source, status, confidence, model_id, labeler_user_id, evidence_text, created_at
     FROM training_labels WHERE frame_id = ANY($1::uuid[]) ORDER BY created_at`,
    [frameIds],
  );
  return rows;
}

/** The creator's own labeling queue: frames with automatic proposals and uncertain predictions first. */
export async function listTrainingQueue(db: Queryable, broadcasterId: string, limit = 20): Promise<TrainingFrameRow[]> {
  const { rows } = await db.query<TrainingFrameRow>(
    `SELECT ${F_COLS}, s.title AS session_title FROM training_frames f JOIN stream_sessions s ON s.id = f.session_id
     WHERE f.broadcaster_id = $1 AND f.status = 'unlabeled'
     ORDER BY f.priority DESC, f.created_at ASC LIMIT $2`,
    [broadcasterId, limit],
  );
  return rows;
}

export async function trainingCounts(db: Queryable, broadcasterId: string) {
  const { rows } = await db.query<{ frames: number; unlabeled: number; labeled: number; skipped: number; proposals: number }>(
    `SELECT count(*)::int AS frames,
            count(*) FILTER (WHERE f.status = 'unlabeled')::int AS unlabeled,
            count(*) FILTER (WHERE f.status = 'labeled')::int AS labeled,
            count(*) FILTER (WHERE f.status = 'skipped')::int AS skipped,
            (SELECT count(*)::int FROM training_labels l JOIN training_frames f2 ON f2.id = l.frame_id
              WHERE f2.broadcaster_id = $1 AND l.status = 'proposed') AS proposals
     FROM training_frames f WHERE f.broadcaster_id = $1`,
    [broadcasterId],
  );
  return rows[0] ?? { frames: 0, unlabeled: 0, labeled: 0, skipped: 0, proposals: 0 };
}

/**
 * Save a person's labels for a frame. Their answer is the truth: earlier human labels are
 * replaced, automatic proposals that agree are accepted and the rest rejected.
 */
export async function applyHumanLabels(pool: pg.Pool, frameId: string, userId: string, input: SubmitLabelsInput): Promise<void> {
  await withTx(pool, async (tx) => {
    await tx.query(`DELETE FROM training_labels WHERE frame_id = $1 AND source IN ('creator', 'labeler')`, [frameId]);
    if (input.skip) {
      await tx.query(`UPDATE training_labels SET status = 'rejected', updated_at = now() WHERE frame_id = $1 AND status = 'proposed'`, [frameId]);
      await tx.query(`UPDATE training_frames SET status = 'skipped', labeled_at = NULL, labeled_by = $2 WHERE id = $1`, [frameId, userId]);
      return;
    }
    const events = input.events ?? [];
    await tx.query(
      `UPDATE training_labels SET status = CASE
         WHEN kind = 'scene' AND class = $2 THEN 'accepted'
         WHEN kind = 'event' AND class = ANY($3::text[]) THEN 'accepted'
         ELSE 'rejected' END, updated_at = now()
       WHERE frame_id = $1 AND status = 'proposed' AND kind IN ('scene', 'event')`,
      [frameId, input.scene ?? null, events],
    );
    // Proposed boxes are never accepted implicitly: the person draws the boxes that count.
    await tx.query(`UPDATE training_labels SET status = 'rejected', updated_at = now() WHERE frame_id = $1 AND status = 'proposed' AND kind = 'box'`, [frameId]);
    const labels: NewTrainingLabel[] = [
      ...(input.scene ? [{ kind: "scene" as const, class: input.scene, box: null, source: "creator" as const, status: "accepted" as const, confidence: null, labelerUserId: userId }] : []),
      ...events.map((e) => ({ kind: "event" as const, class: e, box: null, source: "creator" as const, status: "accepted" as const, confidence: null, labelerUserId: userId })),
      ...(input.boxes ?? []).map((b) => ({
        kind: "box" as const,
        class: b.class,
        box: { x: b.x, y: b.y, w: b.w, h: b.h },
        source: "creator" as const,
        status: "accepted" as const,
        confidence: null,
        labelerUserId: userId,
      })),
    ];
    await insertTrainingLabels(tx, frameId, labels);
    await tx.query(`UPDATE training_frames SET status = 'labeled', labeled_at = now(), labeled_by = $2 WHERE id = $1`, [frameId, userId]);
  });
}

/** Scene proposals from measurements (e.g. frames inside a detected black segment). */
export async function addMeasuredSceneLabels(db: Queryable, sessionId: string, ranges: { startMs: number; endMs: number }[], cls: string, evidenceText: string) {
  let n = 0;
  for (const r of ranges) {
    const res = await db.query(
      `INSERT INTO training_labels (frame_id, kind, class, source, status, confidence, evidence_text)
       SELECT f.id, 'scene', $4, 'auto_measure', 'proposed', 1, $5 FROM training_frames f
       WHERE f.session_id = $1 AND f.status = 'unlabeled' AND f.media_pts_ms BETWEEN $2 AND $3
       ON CONFLICT DO NOTHING`,
      [sessionId, Math.floor(r.startMs), Math.ceil(r.endMs), cls, evidenceText],
    );
    n += res.rowCount ?? 0;
  }
  if (n > 0) await db.query(`UPDATE training_frames SET priority = GREATEST(priority, 1) WHERE session_id = $1 AND status = 'unlabeled' AND id IN (SELECT frame_id FROM training_labels WHERE source = 'auto_measure')`, [sessionId]);
  return n;
}

export async function listTrainingFrameKeys(db: Queryable, broadcasterId: string): Promise<string[]> {
  const { rows } = await db.query<{ storage_key: string }>(`SELECT storage_key FROM training_frames WHERE broadcaster_id = $1`, [broadcasterId]);
  return rows.map((r) => r.storage_key);
}

export async function deleteTrainingFrames(db: Queryable, broadcasterId: string): Promise<number> {
  const res = await db.query(`DELETE FROM training_frames WHERE broadcaster_id = $1`, [broadcasterId]);
  return res.rowCount ?? 0;
}

/* ------------------------------------------------------------------------------------------ */
/* Datasets                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface DatasetVersionRow {
  id: string;
  version: number;
  taxonomy_version: number;
  split_seed: string;
  test_split_hash: string;
  counts: {
    frames: number;
    channels: number;
    sessions: number;
    splits: { train: number; val: number; test: number };
    scenes: Record<string, number>;
    events: Record<string, number>;
    boxes: Record<string, number>;
  };
  created_by: string | null;
  created_at: Date;
}

export interface DatasetFrame {
  frame: TrainingFrameRow;
  split: "train" | "val" | "test";
  scene: string;
  events: string[];
  boxes: { class: string; x: number; y: number; w: number; h: number }[];
}

/**
 * Freeze a new dataset version from every labeled frame whose creator CURRENTLY consents.
 * Splits are by session with a fixed seed, so the test set never leaks into training and stays
 * comparable across versions. Only human-accepted labels are used.
 */
export async function buildDatasetVersion(pool: pg.Pool, opts: { seed: string; taxonomyVersion: number; createdBy: string | null }): Promise<DatasetVersionRow | null> {
  return withTx(pool, async (tx) => {
    await tx.query(`LOCK TABLE dataset_versions IN EXCLUSIVE MODE`);
    const { rows: frames } = await tx.query<{ id: string; session_id: string; broadcaster_id: string }>(
      `SELECT f.id, f.session_id, f.broadcaster_id FROM training_frames f
       JOIN channel_settings cs ON cs.broadcaster_id = f.broadcaster_id AND cs.training_consent
       WHERE f.status = 'labeled'
         AND EXISTS (SELECT 1 FROM training_labels l WHERE l.frame_id = f.id AND l.kind = 'scene' AND l.status = 'accepted')
       ORDER BY f.id`,
    );
    if (frames.length === 0) return null;
    const assignment = frames.map((f) => ({ ...f, split: splitForSession(opts.seed, f.session_id) }));
    const testIds = assignment.filter((a) => a.split === "test").map((a) => a.id).sort();
    const testHash = createHash("sha256").update(testIds.join("\n")).digest("hex");
    const labels = await listFrameLabels(tx, frames.map((f) => f.id));
    const counts: DatasetVersionRow["counts"] = {
      frames: frames.length,
      channels: new Set(frames.map((f) => f.broadcaster_id)).size,
      sessions: new Set(frames.map((f) => f.session_id)).size,
      splits: { train: 0, val: 0, test: 0 },
      scenes: {},
      events: {},
      boxes: {},
    };
    for (const a of assignment) counts.splits[a.split] += 1;
    for (const l of labels.filter((x) => x.status === "accepted")) {
      const bucket = l.kind === "scene" ? counts.scenes : l.kind === "event" ? counts.events : counts.boxes;
      bucket[l.class] = (bucket[l.class] ?? 0) + 1;
    }
    const { rows: v } = await tx.query<{ next: number }>(`SELECT COALESCE(max(version), 0) + 1 AS next FROM dataset_versions`);
    const { rows } = await tx.query<DatasetVersionRow>(
      `INSERT INTO dataset_versions (version, taxonomy_version, split_seed, test_split_hash, counts, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [v[0]!.next, opts.taxonomyVersion, opts.seed, testHash, JSON.stringify(counts), opts.createdBy],
    );
    const ds = rows[0]!;
    for (let i = 0; i < assignment.length; i += 500) {
      const chunk = assignment.slice(i, i + 500);
      await tx.query(
        `INSERT INTO dataset_frames (dataset_version_id, frame_id, split) SELECT $1, * FROM unnest($2::uuid[], $3::text[])`,
        [ds.id, chunk.map((c) => c.id), chunk.map((c) => c.split)],
      );
    }
    return ds;
  });
}

export async function listDatasetVersions(db: Queryable): Promise<DatasetVersionRow[]> {
  const { rows } = await db.query<DatasetVersionRow>(`SELECT * FROM dataset_versions ORDER BY version DESC LIMIT 50`);
  return rows;
}

export async function getDatasetVersion(db: Queryable, id: string): Promise<DatasetVersionRow | null> {
  const { rows } = await db.query<DatasetVersionRow>(`SELECT * FROM dataset_versions WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Frames of a dataset version with their accepted labels (frames deleted since are gone). */
export async function listDatasetFrames(db: Queryable, datasetVersionId: string): Promise<DatasetFrame[]> {
  const { rows } = await db.query<TrainingFrameRow & { split: DatasetFrame["split"] }>(
    `SELECT ${F_COLS}, df.split FROM dataset_frames df JOIN training_frames f ON f.id = df.frame_id
     WHERE df.dataset_version_id = $1 ORDER BY f.id`,
    [datasetVersionId],
  );
  const labels = await listFrameLabels(db, rows.map((r) => r.id));
  const byFrame = new Map<string, TrainingLabelRow[]>();
  for (const l of labels) if (l.status === "accepted") byFrame.set(l.frame_id, [...(byFrame.get(l.frame_id) ?? []), l]);
  return rows.map((r) => {
    const ls = byFrame.get(r.id) ?? [];
    // Prefer the human scene label over an accepted automatic one.
    const scene = ls.filter((l) => l.kind === "scene").sort((a, b) => humanRank(b.source) - humanRank(a.source))[0]?.class ?? "other";
    return {
      frame: r,
      split: r.split,
      scene,
      events: [...new Set(ls.filter((l) => l.kind === "event").map((l) => l.class))],
      boxes: ls.filter((l) => l.kind === "box").map((l) => ({ class: l.class, x: l.x!, y: l.y!, w: l.w!, h: l.h! })),
    };
  });
}

const humanRank = (s: TrainingLabelRow["source"]) => (s === "creator" || s === "labeler" ? 1 : 0);

export async function consentingChannelCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM channel_settings WHERE training_consent`);
  return rows[0]?.n ?? 0;
}

export async function acceptedFrameCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM training_frames f JOIN channel_settings cs ON cs.broadcaster_id = f.broadcaster_id AND cs.training_consent WHERE f.status = 'labeled'`,
  );
  return rows[0]?.n ?? 0;
}

/* ------------------------------------------------------------------------------------------ */
/* Model registry                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface ModelRow {
  id: string;
  name: string;
  version: string;
  task: "scene" | "detector";
  taxonomy_version: number;
  classes: { scenes?: string[]; events?: string[]; boxes?: string[] };
  input_spec: { name: string; width: number; height: number; mean: number[]; std: number[]; outputs: Record<string, string> };
  metrics: ModelEvaluation[];
  dataset_version_id: string | null;
  onnx_storage_key: string;
  onnx_sha256: string;
  bytes: string;
  status: "candidate" | "active" | "retired";
  uploaded_by: string | null;
  activated_at: Date | null;
  created_at: Date;
  dataset_version?: number | null;
}

const M_COLS = `m.id, m.name, m.version, m.task, m.taxonomy_version, m.classes, m.input_spec, m.metrics, m.dataset_version_id, m.onnx_storage_key,
  m.onnx_sha256, m.bytes, m.status, m.uploaded_by, m.activated_at, m.created_at, dv.version AS dataset_version`;

export async function insertModel(
  db: Queryable,
  m: Omit<ModelRow, "id" | "status" | "activated_at" | "created_at" | "bytes" | "dataset_version"> & { bytes: number },
): Promise<ModelRow> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO models (name, version, task, taxonomy_version, classes, input_spec, metrics, dataset_version_id, onnx_storage_key, onnx_sha256, bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      m.name,
      m.version,
      m.task,
      m.taxonomy_version,
      JSON.stringify(m.classes),
      JSON.stringify(m.input_spec),
      JSON.stringify(m.metrics),
      m.dataset_version_id,
      m.onnx_storage_key,
      m.onnx_sha256,
      m.bytes,
      m.uploaded_by,
    ],
  );
  return (await getModel(db, rows[0]!.id))!;
}

export async function getModel(db: Queryable, id: string): Promise<ModelRow | null> {
  const { rows } = await db.query<ModelRow>(`SELECT ${M_COLS} FROM models m LEFT JOIN dataset_versions dv ON dv.id = m.dataset_version_id WHERE m.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listModels(db: Queryable): Promise<ModelRow[]> {
  const { rows } = await db.query<ModelRow>(`SELECT ${M_COLS} FROM models m LEFT JOIN dataset_versions dv ON dv.id = m.dataset_version_id ORDER BY m.created_at DESC LIMIT 100`);
  return rows;
}

export async function listActiveModels(db: Queryable): Promise<ModelRow[]> {
  const { rows } = await db.query<ModelRow>(`SELECT ${M_COLS} FROM models m LEFT JOIN dataset_versions dv ON dv.id = m.dataset_version_id WHERE m.status = 'active' ORDER BY m.task`);
  return rows;
}

export async function addModelEvaluations(db: Queryable, id: string, evaluations: ModelEvaluation[]): Promise<ModelRow | null> {
  await db.query(`UPDATE models SET metrics = metrics || $2::jsonb WHERE id = $1`, [id, JSON.stringify(evaluations)]);
  return getModel(db, id);
}

/** Make a model the active one for its task; the previous active model is retired (kept). */
export async function activateModel(pool: pg.Pool, id: string): Promise<ModelRow | null> {
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<{ task: string }>(`SELECT task FROM models WHERE id = $1 FOR UPDATE`, [id]);
    const task = rows[0]?.task;
    if (!task) return null;
    await tx.query(`UPDATE models SET status = 'retired' WHERE task = $1 AND status = 'active' AND id <> $2`, [task, id]);
    await tx.query(`UPDATE models SET status = 'active', activated_at = now() WHERE id = $1`, [id]);
    return getModel(tx, id);
  });
}
