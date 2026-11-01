import type { JobState } from "@slot1/contracts";
import { iso, isoReq, type Queryable } from "./client";

/* ------------------------------------------------------------------------------------------ */
/* EventSub deliveries (idempotency) and subscriptions                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Record a delivery by message id. Returns false if this message id was already recorded —
 * the caller must then acknowledge without processing again.
 */
export async function recordEventSubDelivery(
  db: Queryable,
  d: { messageId: string; messageType: string; subscriptionId: string | null; subscriptionType: string | null; broadcasterTwitchId: string | null },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO eventsub_deliveries (message_id, message_type, subscription_id, subscription_type, broadcaster_twitch_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id) DO NOTHING`,
    [d.messageId, d.messageType, d.subscriptionId, d.subscriptionType, d.broadcasterTwitchId],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function markDeliveryProcessed(db: Queryable, messageId: string, status: "processed" | "failed" | "ignored", error: string | null = null) {
  await db.query(`UPDATE eventsub_deliveries SET status = $2, error = $3, processed_at = now() WHERE message_id = $1`, [messageId, status, error]);
}

export async function pruneDeliveries(db: Queryable, olderThanDays = 7) {
  await db.query(`DELETE FROM eventsub_deliveries WHERE received_at < now() - make_interval(days => $1)`, [olderThanDays]);
}

export interface EventSubSubRow {
  id: string;
  broadcaster_id: string;
  type: string;
  version: string;
  status: string;
  condition: Record<string, string>;
}

export async function upsertEventSubSubscription(db: Queryable, s: EventSubSubRow) {
  await db.query(
    `INSERT INTO eventsub_subscriptions (id, broadcaster_id, type, version, status, condition) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (broadcaster_id, type, version) DO UPDATE SET id = EXCLUDED.id, status = EXCLUDED.status, condition = EXCLUDED.condition, updated_at = now()`,
    [s.id, s.broadcaster_id, s.type, s.version, s.status, JSON.stringify(s.condition)],
  );
}

export async function setEventSubStatusById(db: Queryable, id: string, status: string) {
  await db.query(`UPDATE eventsub_subscriptions SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

export async function listEventSubSubscriptions(db: Queryable, broadcasterId: string): Promise<EventSubSubRow[]> {
  const { rows } = await db.query<EventSubSubRow>(`SELECT id, broadcaster_id, type, version, status, condition FROM eventsub_subscriptions WHERE broadcaster_id = $1`, [
    broadcasterId,
  ]);
  return rows;
}

export async function deleteEventSubSubscriptionRow(db: Queryable, id: string) {
  await db.query(`DELETE FROM eventsub_subscriptions WHERE id = $1`, [id]);
}

/* ------------------------------------------------------------------------------------------ */
/* Bot command audit                                                                          */
/* ------------------------------------------------------------------------------------------ */

export type BotDecision = "answered" | "queued" | "denied" | "rate_limited" | "duplicate" | "disabled" | "killed" | "error";

/** Insert-once per chat message id. Returns false when this chat message was already handled. */
export async function claimChatMessage(
  db: Queryable,
  a: { broadcasterId: string; chatterUserId: string; chatterLogin: string; messageId: string; command: string; argsSha256: string | null; argsLength: number },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO bot_command_audit (broadcaster_id, chatter_user_id, chatter_login, message_id, command, args_sha256, args_length, decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued') ON CONFLICT (broadcaster_id, message_id) DO NOTHING`,
    [a.broadcasterId, a.chatterUserId, a.chatterLogin, a.messageId, a.command, a.argsSha256, a.argsLength],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function setChatDecision(db: Queryable, broadcasterId: string, messageId: string, decision: BotDecision, reason: string | null, replyMessageId: string | null = null) {
  await db.query(
    `UPDATE bot_command_audit SET decision = $3, reason = $4, reply_message_id = COALESCE($5, reply_message_id) WHERE broadcaster_id = $1 AND message_id = $2`,
    [broadcasterId, messageId, decision, reason, replyMessageId],
  );
}

export async function listRecentCommands(db: Queryable, broadcasterId: string, limit = 20) {
  const { rows } = await db.query<{ command: string; decision: string; reason: string | null; chatter_login: string; created_at: Date }>(
    `SELECT command, decision, reason, chatter_login, created_at FROM bot_command_audit WHERE broadcaster_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [broadcasterId, limit],
  );
  return rows.map((r) => ({ ...r, created_at: isoReq(r.created_at) }));
}

/* ------------------------------------------------------------------------------------------ */
/* Job runs, usage, errors                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface JobRunRow {
  id: string;
  broadcaster_id: string;
  session_id: string | null;
  queue: string;
  name: string;
  state: JobState;
  step: string | null;
  progress: number | null;
  error: string | null;
  usage: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export async function createJobRun(db: Queryable, j: { broadcasterId: string; sessionId: string | null; queue: string; name: string }): Promise<JobRunRow> {
  const { rows } = await db.query<JobRunRow>(
    `INSERT INTO job_runs (broadcaster_id, session_id, queue, name, state) VALUES ($1, $2, $3, $4, 'queued') RETURNING *`,
    [j.broadcasterId, j.sessionId, j.queue, j.name],
  );
  return rows[0]!;
}

export async function updateJobRun(
  db: Queryable,
  id: string,
  p: Partial<{ state: JobState; step: string | null; progress: number | null; error: string | null; usage: Record<string, unknown> }>,
): Promise<JobRunRow | null> {
  const { rows } = await db.query<JobRunRow>(
    `UPDATE job_runs SET state = COALESCE($2, state), step = CASE WHEN $3 THEN $4 ELSE step END,
       progress = CASE WHEN $5 THEN $6 ELSE progress END, error = CASE WHEN $7 THEN $8 ELSE error END,
       usage = COALESCE($9, usage),
       started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE finished_at END
     WHERE id = $1 RETURNING *`,
    [
      id,
      p.state ?? null,
      p.step !== undefined,
      p.step ?? null,
      p.progress !== undefined,
      p.progress ?? null,
      p.error !== undefined,
      p.error ?? null,
      p.usage ? JSON.stringify(p.usage) : null,
    ],
  );
  return rows[0] ?? null;
}

export async function getJobRun(db: Queryable, id: string): Promise<JobRunRow | null> {
  const { rows } = await db.query<JobRunRow>(`SELECT * FROM job_runs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function latestJobRunForSession(db: Queryable, sessionId: string): Promise<JobRunRow | null> {
  const { rows } = await db.query<JobRunRow>(`SELECT * FROM job_runs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [sessionId]);
  return rows[0] ?? null;
}

export async function listJobRuns(db: Queryable, broadcasterId: string, limit = 25): Promise<JobRunRow[]> {
  const { rows } = await db.query<JobRunRow>(`SELECT * FROM job_runs WHERE broadcaster_id = $1 ORDER BY created_at DESC LIMIT $2`, [broadcasterId, limit]);
  return rows;
}

export function jobRunView(r: JobRunRow) {
  return {
    id: r.id,
    queue: r.queue,
    name: r.name,
    state: r.state,
    step: r.step,
    progress: r.progress,
    error: r.error,
    sessionId: r.session_id,
    createdAt: isoReq(r.created_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export async function recordUsage(
  db: Queryable,
  u: {
    broadcasterId: string;
    sessionId: string | null;
    kind: "vision" | "transcription" | "qa";
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    frames?: number;
    audioSeconds?: number;
    estimatedCostUsd?: number | null;
  },
) {
  await db.query(
    `INSERT INTO usage_events (broadcaster_id, session_id, kind, provider, model, input_tokens, output_tokens, frames, audio_seconds, estimated_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      u.broadcasterId,
      u.sessionId,
      u.kind,
      u.provider,
      u.model,
      u.inputTokens ?? 0,
      u.outputTokens ?? 0,
      u.frames ?? 0,
      u.audioSeconds ?? 0,
      u.estimatedCostUsd ?? null,
    ],
  );
}

export async function visionCallsInLastHour(db: Queryable, broadcasterId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM usage_events WHERE broadcaster_id = $1 AND kind = 'vision' AND created_at > now() - interval '1 hour'`,
    [broadcasterId],
  );
  return rows[0]?.n ?? 0;
}

export async function usageSummary(db: Queryable, broadcasterId: string) {
  const { rows } = await db.query<{
    period_start: Date;
    vision_calls: number;
    frames: number;
    audio_seconds: number;
    input_tokens: number;
    output_tokens: number;
    cost: number | null;
    cost_rows: number;
    rows: number;
  }>(
    `SELECT date_trunc('month', now()) AS period_start,
       count(*) FILTER (WHERE kind = 'vision')::int AS vision_calls,
       coalesce(sum(frames), 0)::int AS frames,
       coalesce(sum(audio_seconds), 0)::real AS audio_seconds,
       coalesce(sum(input_tokens), 0)::int AS input_tokens,
       coalesce(sum(output_tokens), 0)::int AS output_tokens,
       sum(estimated_cost_usd)::float AS cost,
       count(estimated_cost_usd)::int AS cost_rows,
       count(*)::int AS rows
     FROM usage_events WHERE broadcaster_id = $1 AND created_at >= date_trunc('month', now())`,
    [broadcasterId],
  );
  const r = rows[0]!;
  return {
    periodStart: isoReq(r.period_start),
    visionCalls: r.vision_calls,
    framesAnalyzed: r.frames,
    audioSeconds: Math.round(r.audio_seconds),
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    estimatedCostUsd: r.cost_rows > 0 ? Math.round((r.cost ?? 0) * 10000) / 10000 : null,
    pricedRows: r.cost_rows,
    totalRows: r.rows,
  };
}

export async function recordOpsError(db: Queryable, broadcasterId: string | null, scope: string, message: string) {
  await db.query(`INSERT INTO ops_errors (broadcaster_id, scope, message) VALUES ($1, $2, $3)`, [broadcasterId, scope, message.slice(0, 500)]);
}

export async function listOpsErrors(db: Queryable, broadcasterId: string, limit = 10) {
  const { rows } = await db.query<{ created_at: Date; scope: string; message: string }>(
    `SELECT created_at, scope, message FROM ops_errors WHERE broadcaster_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [broadcasterId, limit],
  );
  return rows.map((r) => ({ at: isoReq(r.created_at), scope: r.scope, message: r.message }));
}

/* ------------------------------------------------------------------------------------------ */
/* Session event log (SSE backfill)                                                           */
/* ------------------------------------------------------------------------------------------ */

export interface Publisher {
  publish(channel: string, message: string): Promise<number>;
}

export interface StoredEvent {
  id: string;
  sessionId: string;
  kind: string;
  at: string;
  payload: unknown;
  publicPayload: unknown | null;
}

/** Persist then fan out. Persisting first guarantees a reconnecting client can backfill it. */
export async function appendSessionEvent(
  db: Queryable,
  publisher: Publisher | null,
  e: { sessionId: string; broadcasterId: string; kind: string; payload: unknown; publicPayload: unknown | null },
): Promise<StoredEvent> {
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO session_events (session_id, broadcaster_id, kind, payload, public_payload) VALUES ($1, $2, $3, $4, $5) RETURNING id::text, created_at`,
    [e.sessionId, e.broadcasterId, e.kind, JSON.stringify(e.payload), e.publicPayload === null ? null : JSON.stringify(e.publicPayload)],
  );
  const stored: StoredEvent = {
    id: rows[0]!.id,
    sessionId: e.sessionId,
    kind: e.kind,
    at: isoReq(rows[0]!.created_at),
    payload: e.payload,
    publicPayload: e.publicPayload,
  };
  if (publisher) {
    await publisher.publish(`slot1:session:${e.sessionId}`, JSON.stringify(stored)).catch(() => undefined);
  }
  return stored;
}

export async function backfillSessionEvents(db: Queryable, sessionId: string, afterId: string | null, limit = 500): Promise<StoredEvent[]> {
  const { rows } = await db.query<{ id: string; session_id: string; kind: string; created_at: Date; payload: unknown; public_payload: unknown | null }>(
    `SELECT id::text, session_id, kind, created_at, payload, public_payload FROM session_events
     WHERE session_id = $1 AND ($2::bigint IS NULL OR id > $2::bigint)
     -- Qualified on purpose: a bare "id" would sort by the text output column (1, 10, 2…).
     ORDER BY session_events.id ASC LIMIT $3`,
    [sessionId, afterId, limit],
  );
  return rows.map((r) => ({ id: r.id, sessionId: r.session_id, kind: r.kind, at: isoReq(r.created_at), payload: r.payload, publicPayload: r.public_payload }));
}

export async function latestSessionEventId(db: Queryable, sessionId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>(`SELECT max(id)::text AS id FROM session_events WHERE session_id = $1`, [sessionId]);
  return rows[0]?.id ?? null;
}

/** Keep the event log bounded per session. */
export async function trimSessionEvents(db: Queryable, sessionId: string, keep = 5000) {
  await db.query(
    `DELETE FROM session_events WHERE session_id = $1 AND id < (
       SELECT id FROM session_events WHERE session_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
    [sessionId, keep],
  );
}
