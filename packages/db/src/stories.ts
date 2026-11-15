import { buildStories, knowledgeTags, STORY_EVENT_KINDS, type AttemptRecord, type StoryEntry, type StoryEventKind } from "@slot1/contracts";
import { withTx, type DbPool, type Queryable } from "./client";

/**
 * Missions as stories and what leads to each result (contracts/src/mission-stories.ts), stored per
 * stream and rebuilt from its entries whenever new mission entries arrive.
 */

/** Only what anyone could already see counts in the summaries (as in knowledge.ts). */
const PUBLIC_SESSION = `JOIN stream_sessions s ON s.id = x.session_id
  JOIN channel_settings cs ON cs.broadcaster_id = s.broadcaster_id
 WHERE s.visibility = 'public' AND cs.visibility = 'public' AND cs.public_analysis AND coalesce(s.label, '') <> 'test'`;

/**
 * Streams whose stories are out of date: a mission entry (objective, title, result) arrived since
 * the last rebuild, or the stream ended since. At most one rebuild every `minAgeMs` per stream.
 */
export async function sessionsNeedingStories(db: Queryable, limit = 10, minAgeMs = 120_000): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id FROM stream_sessions s
      WHERE s.delete_requested_at IS NULL
        AND (s.stories_refreshed_at IS NULL OR s.stories_refreshed_at < now() - ($2::int * interval '1 millisecond'))
        AND EXISTS (
          SELECT 1 FROM observations o
           WHERE o.session_id = s.id
             AND o.type IN ('objective_text', 'mission_title', 'result_screen')
             AND (s.stories_refreshed_at IS NULL OR o.received_at > s.stories_refreshed_at OR s.ended_at > s.stories_refreshed_at))
      ORDER BY s.started_at DESC
      LIMIT $1`,
    [limit, minAgeMs],
  );
  return rows.map((r) => r.id);
}

/** Rebuilds one stream's mission attempts and result events from its entries. */
export async function refreshSessionStories(pool: DbPool, sessionId: string): Promise<{ attempts: number; events: number }> {
  // Entries arriving while this runs are newer than the mark, so they trigger the next rebuild.
  const mark = new Date();
  const { rows } = await pool.query<{
    id: string;
    broadcaster_id: string;
    type: string;
    origin: string;
    media_start_ms: number;
    raw_text: string | null;
    description: string;
    tags: string[] | null;
  }>(
    `SELECT id, broadcaster_id, type, origin, media_start_ms, raw_text, description, tags
       FROM observations
      WHERE session_id = $1 AND media_start_ms IS NOT NULL AND review_status <> 'rejected' AND origin <> 'twitch'
        AND (type IN ('objective_text', 'mission_title', 'result_screen') OR (type = 'visible_text' AND origin = 'ocr')
             OR tags IS NULL OR cardinality(tags) > 0)
      ORDER BY media_start_ms
      LIMIT 100000`,
    [sessionId],
  );
  const broadcasterId = rows[0]?.broadcaster_id ?? null;
  const entries: StoryEntry[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    origin: r.origin,
    mediaStartMs: r.media_start_ms,
    rawText: r.raw_text,
    // Entries the background tagging hasn't reached yet are tagged here the same way.
    tags: r.tags ?? knowledgeTags({ type: r.type, description: r.description, rawText: r.raw_text, origin: r.origin }),
  }));
  const { attempts, events } = buildStories(entries);
  await withTx(pool, async (c) => {
    await c.query(`DELETE FROM mission_attempts WHERE session_id = $1`, [sessionId]);
    await c.query(`DELETE FROM story_events WHERE session_id = $1`, [sessionId]);
    if (broadcasterId) {
      for (const a of attempts) {
        await c.query(
          `INSERT INTO mission_attempts (session_id, broadcaster_id, seq, name, name_from, mission_key, outcome, fail_reason, started_ms, ended_ms,
                                         duration_ms, objectives, last_objective, deaths, busts, activities, places, start_observation_id, end_observation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            sessionId,
            broadcasterId,
            a.seq,
            a.name,
            a.nameFrom,
            a.key,
            a.outcome,
            a.failReason,
            a.startedMs,
            a.endedMs,
            a.durationMs,
            a.objectives,
            a.lastObjective,
            a.deaths,
            a.busts,
            a.activities,
            a.places,
            a.startEntryId,
            a.endEntryId,
          ],
        );
      }
      for (const e of events) {
        await c.query(
          `INSERT INTO story_events (session_id, broadcaster_id, kind, at_ms, observation_id, attempt_seq, before, places)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [sessionId, broadcasterId, e.kind, e.atMs, e.entryId, e.attemptSeq, e.before, e.places],
        );
      }
    }
    await c.query(`UPDATE stream_sessions SET stories_refreshed_at = $2 WHERE id = $1`, [sessionId, mark]);
  });
  return { attempts: attempts.length, events: events.length };
}

/** Every stored attempt on public streams, newest streams first, for the summaries. */
export async function missionRecords(db: Queryable, limit = 20_000): Promise<AttemptRecord[]> {
  const { rows } = await db.query<{
    session_id: string;
    broadcaster_id: string;
    name: string | null;
    mission_key: string | null;
    outcome: AttemptRecord["outcome"];
    fail_reason: string | null;
    duration_ms: number | null;
    objectives: string[];
    last_objective: string | null;
    deaths: number;
    busts: number;
    activities: string[];
    end_observation_id: string | null;
    ended_at: Date | null;
  }>(
    `SELECT x.session_id, x.broadcaster_id, x.name, x.mission_key, x.outcome, x.fail_reason, x.duration_ms, x.objectives, x.last_objective,
            x.deaths, x.busts, x.activities, x.end_observation_id, coalesce(e.received_at, s.started_at) AS ended_at
       FROM mission_attempts x LEFT JOIN observations e ON e.id = x.end_observation_id
       ${PUBLIC_SESSION}
      ORDER BY s.started_at DESC, x.seq
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    broadcasterId: r.broadcaster_id,
    name: r.name,
    key: r.mission_key,
    outcome: r.outcome,
    failReason: r.fail_reason,
    durationMs: r.duration_ms,
    objectives: r.objectives,
    lastObjective: r.last_objective,
    deaths: r.deaths,
    busts: r.busts,
    activities: r.activities,
    endObservationId: r.end_observation_id,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  }));
}

export interface OutcomeCause {
  kind: StoryEventKind;
  total: number;
  /** In how many of them each activity was seen in the minute before, most often first. */
  before: { activity: string; count: number }[];
  places: { place: string; count: number }[];
  /** The newest ones, to watch. */
  proof: string[];
}

/** What SLOT1 saw in the minute before every WASTED, BUSTED, MISSION FAILED and MISSION PASSED. */
export async function outcomeCauses(db: Queryable): Promise<OutcomeCause[]> {
  const [totals, before, places, proof] = await Promise.all([
    db.query<{ kind: StoryEventKind; total: number }>(`SELECT x.kind, count(*)::int AS total FROM story_events x ${PUBLIC_SESSION} GROUP BY x.kind`),
    db.query<{ kind: StoryEventKind; v: string; n: number }>(
      `SELECT x.kind, b AS v, count(*)::int AS n FROM story_events x CROSS JOIN LATERAL unnest(x.before) AS b ${PUBLIC_SESSION} GROUP BY x.kind, b ORDER BY n DESC, v`,
    ),
    db.query<{ kind: StoryEventKind; v: string; n: number }>(
      `SELECT x.kind, p AS v, count(*)::int AS n FROM story_events x CROSS JOIN LATERAL unnest(x.places) AS p ${PUBLIC_SESSION} GROUP BY x.kind, p ORDER BY n DESC, v`,
    ),
    db.query<{ kind: StoryEventKind; id: string }>(
      `SELECT kind, id FROM (
         SELECT x.kind, x.observation_id AS id, row_number() OVER (PARTITION BY x.kind ORDER BY s.started_at DESC, x.at_ms DESC) AS r
           FROM story_events x ${PUBLIC_SESSION} AND x.observation_id IS NOT NULL) t
        WHERE r <= 3`,
    ),
  ]);
  return STORY_EVENT_KINDS.map((kind) => ({
    kind,
    total: totals.rows.find((t) => t.kind === kind)?.total ?? 0,
    before: before.rows.filter((r) => r.kind === kind).slice(0, 6).map((r) => ({ activity: r.v, count: r.n })),
    places: places.rows.filter((r) => r.kind === kind).slice(0, 4).map((r) => ({ place: r.v, count: r.n })),
    proof: proof.rows.filter((r) => r.kind === kind).map((r) => r.id),
  }));
}
