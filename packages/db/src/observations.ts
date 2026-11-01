import { randomUUID } from "node:crypto";
import { OBSERVATION_SCHEMA_VERSION, type CorrectionInput, type Observation } from "@slot1/contracts";
import { iso, isoReq, num, type Queryable } from "./client";

interface ObservationRow {
  id: string;
  schema_version: number;
  broadcaster_id: string;
  session_id: string;
  source_id: string | null;
  media_start_ms: number | null;
  media_end_ms: number | null;
  captured_at: Date | null;
  received_at: Date;
  analyzed_at: Date | null;
  published_at: Date | null;
  type: Observation["type"];
  description: string;
  origin: Observation["origin"];
  interpretation: Observation["interpretation"];
  evidence: Observation["evidence"];
  raw_text: string | null;
  model_provider: string | null;
  model_version: string | null;
  model_confidence: number | null;
  review_status: Observation["reviewStatus"];
  related_entities: Observation["relatedEntities"];
}

const O_COLS = `id, schema_version, broadcaster_id, session_id, source_id, media_start_ms, media_end_ms, captured_at, received_at,
  analyzed_at, published_at, type, description, origin, interpretation, evidence, raw_text, model_provider, model_version,
  model_confidence, review_status, related_entities`;

export function mapObservation(r: ObservationRow): Observation {
  return {
    id: r.id,
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    broadcasterId: r.broadcaster_id,
    sessionId: r.session_id,
    sourceId: r.source_id,
    mediaStartMs: num(r.media_start_ms),
    mediaEndMs: num(r.media_end_ms),
    capturedAt: iso(r.captured_at),
    receivedAt: isoReq(r.received_at),
    analyzedAt: iso(r.analyzed_at),
    publishedAt: iso(r.published_at),
    type: r.type,
    description: r.description,
    origin: r.origin,
    interpretation: r.interpretation,
    evidence: r.evidence ?? [],
    rawText: r.raw_text,
    model: r.model_provider && r.model_version ? { provider: r.model_provider, version: r.model_version } : null,
    modelConfidence: r.model_confidence === null ? null : Math.round(r.model_confidence * 1000) / 1000,
    reviewStatus: r.review_status,
    relatedEntities: r.related_entities ?? [],
  };
}

export type NewObservation = Omit<Observation, "id" | "schemaVersion" | "publishedAt" | "reviewStatus"> & {
  id?: string;
  dedupeKey?: string | null;
};

/**
 * Insert an observation. If a `dedupeKey` is supplied and already exists for the session, the
 * existing row is returned untouched (idempotent pipeline retries). Returns `created: false` then.
 */
export async function insertObservation(db: Queryable, o: NewObservation): Promise<{ observation: Observation; created: boolean }> {
  const id = o.id ?? randomUUID();
  const { rows } = await db.query<ObservationRow>(
    `INSERT INTO observations (id, schema_version, broadcaster_id, session_id, source_id, media_start_ms, media_end_ms, captured_at,
        received_at, analyzed_at, published_at, type, description, origin, interpretation, evidence, raw_text, model_provider,
        model_version, model_confidence, related_entities, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING ${O_COLS}`,
    [
      id,
      OBSERVATION_SCHEMA_VERSION,
      o.broadcasterId,
      o.sessionId,
      o.sourceId,
      o.mediaStartMs,
      o.mediaEndMs,
      o.capturedAt,
      o.receivedAt,
      o.analyzedAt,
      o.type,
      o.description,
      o.origin,
      o.interpretation,
      JSON.stringify(o.evidence),
      o.rawText,
      o.model?.provider ?? null,
      o.model?.version ?? null,
      o.modelConfidence,
      JSON.stringify(o.relatedEntities),
      o.dedupeKey ?? null,
    ],
  );
  if (rows[0]) return { observation: mapObservation(rows[0]), created: true };
  const existing = await db.query<ObservationRow>(`SELECT ${O_COLS} FROM observations WHERE session_id = $1 AND dedupe_key = $2`, [
    o.sessionId,
    o.dedupeKey,
  ]);
  return { observation: mapObservation(existing.rows[0]!), created: false };
}

/** Extend an existing (fused) observation's time range and evidence list. */
export async function extendObservation(
  db: Queryable,
  id: string,
  input: { mediaEndMs: number; evidence: Observation["evidence"]; analyzedAt: string },
): Promise<Observation | null> {
  const { rows } = await db.query<ObservationRow>(
    `UPDATE observations SET media_end_ms = GREATEST(COALESCE(media_end_ms, 0), $2), evidence = $3, analyzed_at = $4, updated_at = now()
     WHERE id = $1 RETURNING ${O_COLS}`,
    [id, input.mediaEndMs, JSON.stringify(input.evidence), input.analyzedAt],
  );
  return rows[0] ? mapObservation(rows[0]) : null;
}

export async function getObservation(db: Queryable, id: string): Promise<Observation | null> {
  const { rows } = await db.query<ObservationRow>(`SELECT ${O_COLS} FROM observations WHERE id = $1`, [id]);
  return rows[0] ? mapObservation(rows[0]) : null;
}

export async function listObservations(
  db: Queryable,
  sessionId: string,
  opts: { limit?: number; includeRejected?: boolean; sinceReceivedAt?: string | null } = {},
): Promise<Observation[]> {
  const params: unknown[] = [sessionId];
  let where = `session_id = $1`;
  if (!opts.includeRejected) where += ` AND review_status <> 'rejected'`;
  if (opts.sinceReceivedAt) {
    params.push(opts.sinceReceivedAt);
    where += ` AND received_at >= $${params.length}`;
  }
  params.push(opts.limit ?? 500);
  const { rows } = await db.query<ObservationRow>(
    `SELECT ${O_COLS} FROM (
       SELECT ${O_COLS}, created_at FROM observations WHERE ${where} ORDER BY received_at DESC, created_at DESC LIMIT $${params.length}
     ) t ORDER BY COALESCE(media_start_ms, 0) ASC, received_at ASC`,
    params,
  );
  return rows.map(mapObservation);
}

export async function latestObservation(db: Queryable, sessionId: string, gameplayOnly = true): Promise<Observation | null> {
  const { rows } = await db.query<ObservationRow>(
    `SELECT ${O_COLS} FROM observations WHERE session_id = $1 AND review_status <> 'rejected'
       ${gameplayOnly ? `AND origin IN ('video', 'ocr', 'audio') AND type NOT IN ('media_facts', 'session_coverage', 'source_gap')` : ""}
     ORDER BY received_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ? mapObservation(rows[0]) : null;
}

/** Full-text + recency search scoped to one session (always pass an authorized session id). */
export async function searchSessionObservations(db: Queryable, sessionId: string, query: string, limit = 8): Promise<Observation[]> {
  const terms = toTsQuery(query);
  if (!terms) return [];
  const { rows } = await db.query<ObservationRow>(
    `SELECT ${O_COLS} FROM observations
     WHERE session_id = $1 AND review_status <> 'rejected' AND search @@ to_tsquery('simple', $2)
     ORDER BY ts_rank(search, to_tsquery('simple', $2)) DESC, received_at DESC LIMIT $3`,
    [sessionId, terms, limit],
  );
  return rows.map(mapObservation);
}

export async function listObservationsByType(db: Queryable, sessionId: string, types: string[], limit = 20): Promise<Observation[]> {
  const { rows } = await db.query<ObservationRow>(
    `SELECT ${O_COLS} FROM observations WHERE session_id = $1 AND type = ANY($2::text[]) AND review_status <> 'rejected'
     ORDER BY received_at DESC LIMIT $3`,
    [sessionId, types, limit],
  );
  return rows.map(mapObservation);
}

/** Build a safe prefix tsquery from free text: words only, OR-joined, max 8 terms. */
export function toTsQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w) => `${w}:*`).join(" | ");
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "was", "were", "be", "it", "that", "this", "what",
  "did", "do", "does", "just", "show", "me", "find", "any", "there", "happened", "happen", "with", "for", "from", "about",
]);

/* ------------------------------------------------------------------------------------------ */
/* Corrections (audit history preserved)                                                      */
/* ------------------------------------------------------------------------------------------ */

export async function applyCorrection(
  db: Queryable,
  input: { observationId: string; broadcasterId: string; actorUserId: string; correction: CorrectionInput },
): Promise<Observation | null> {
  const current = await db.query<ObservationRow>(`SELECT ${O_COLS} FROM observations WHERE id = $1 AND broadcaster_id = $2 FOR UPDATE`, [
    input.observationId,
    input.broadcasterId,
  ]);
  const row = current.rows[0];
  if (!row) return null;
  await db.query(
    `INSERT INTO review_corrections (observation_id, broadcaster_id, actor_user_id, previous, correction, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.observationId,
      input.broadcasterId,
      input.actorUserId,
      JSON.stringify({ description: row.description, type: row.type, reviewStatus: row.review_status }),
      JSON.stringify(input.correction),
      input.correction.reason ?? null,
    ],
  );
  const { rows } = await db.query<ObservationRow>(
    `UPDATE observations SET review_status = $2, description = COALESCE($3, description), type = COALESCE($4, type), updated_at = now()
     WHERE id = $1 RETURNING ${O_COLS}`,
    [input.observationId, input.correction.reviewStatus, input.correction.description ?? null, input.correction.type ?? null],
  );
  return rows[0] ? mapObservation(rows[0]) : null;
}

export async function listCorrections(db: Queryable, observationId: string) {
  const { rows } = await db.query<{ id: string; created_at: Date; correction: CorrectionInput; reason: string | null; previous: { description: string } }>(
    `SELECT id, created_at, correction, reason, previous FROM review_corrections WHERE observation_id = $1 ORDER BY created_at ASC`,
    [observationId],
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: isoReq(r.created_at),
    reviewStatus: r.correction.reviewStatus,
    reason: r.reason,
    previousDescription: r.previous.description,
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Transcripts                                                                                */
/* ------------------------------------------------------------------------------------------ */

export async function insertTranscript(
  db: Queryable,
  t: {
    broadcasterId: string;
    sessionId: string;
    sourceId: string | null;
    mediaStartMs: number;
    mediaEndMs: number;
    text: string;
    segments: { startMs: number; endMs: number; text: string }[];
    provider: string;
    model: string;
    language: string | null;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transcripts (broadcaster_id, session_id, source_id, media_start_ms, media_end_ms, text, segments, provider, model, language)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (session_id, source_id, media_start_ms) DO UPDATE SET text = EXCLUDED.text, segments = EXCLUDED.segments
     RETURNING id`,
    [t.broadcasterId, t.sessionId, t.sourceId, t.mediaStartMs, t.mediaEndMs, t.text, JSON.stringify(t.segments), t.provider, t.model, t.language],
  );
  return rows[0]!.id;
}

export async function searchTranscripts(db: Queryable, sessionId: string, query: string, limit = 5) {
  const terms = toTsQuery(query);
  if (!terms) return [];
  const { rows } = await db.query<{ id: string; media_start_ms: number; media_end_ms: number; text: string }>(
    `SELECT id, media_start_ms, media_end_ms, text FROM transcripts WHERE session_id = $1 AND search @@ to_tsquery('simple', $2)
     ORDER BY ts_rank(search, to_tsquery('simple', $2)) DESC LIMIT $3`,
    [sessionId, terms, limit],
  );
  return rows;
}
