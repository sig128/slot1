import { knowledgeTags, type Observation } from "@slot1/contracts";
import type { Queryable } from "./client";
import { mapObservation, O_COLS, toTsQuery, type ObservationRow } from "./observations";

/**
 * Everything SLOT1 saw, sorted (contracts/src/game-knowledge.ts), across every stream anyone can
 * see: public channels with public analysis, public sessions, never TEST sources, never rejected
 * or Twitch-side entries. The Learning page's counts and its "Ask SLOT1 about the game" read here.
 */
const PUBLIC = `JOIN stream_sessions s ON s.id = o.session_id
  JOIN channel_settings cs ON cs.broadcaster_id = s.broadcaster_id
 WHERE s.visibility = 'public' AND cs.visibility = 'public' AND cs.public_analysis AND coalesce(s.label, '') <> 'test'
   AND o.review_status <> 'rejected' AND o.origin <> 'twitch'`;

export interface TagCount {
  tag: string;
  seen: number;
  streams: number;
  channels: number;
  lastSeenAt: Date | null;
}

/** How often each activity and place was seen. */
export async function knowledgeCounts(db: Queryable): Promise<TagCount[]> {
  const { rows } = await db.query<{ tag: string; seen: number; streams: number; channels: number; last: Date | null }>(
    `SELECT t AS tag, count(*)::int AS seen, count(DISTINCT o.session_id)::int AS streams, count(DISTINCT o.broadcaster_id)::int AS channels,
            max(o.received_at) AS last
       FROM observations o CROSS JOIN LATERAL unnest(o.tags) AS t
       ${PUBLIC}
      GROUP BY t`,
  );
  return rows.map((r) => ({ tag: r.tag, seen: r.seen, streams: r.streams, channels: r.channels, lastSeenAt: r.last }));
}

/** Places seen in the same entries as an activity ("where people buy guns"), most often first. */
export async function knowledgePlacesFor(db: Queryable, activityTag: string, limit = 6): Promise<{ place: string; seen: number }[]> {
  const { rows } = await db.query<{ place: string; seen: number }>(
    `SELECT substr(t, 7) AS place, count(*)::int AS seen
       FROM observations o CROSS JOIN LATERAL unnest(o.tags) AS t
       ${PUBLIC} AND o.tags @> ARRAY[$1]::text[] AND t LIKE 'place:%'
      GROUP BY t ORDER BY seen DESC, place LIMIT $2`,
    [activityTag, limit],
  );
  return rows;
}

export interface KnowledgeEvidence extends Observation {
  tags: string[];
  channelLogin: string;
  channelName: string;
  sessionKind: string;
}

/**
 * Entries that answer a question: those about the question's activities and places first, then
 * those whose words match it. Newest first within each.
 */
export async function knowledgeEvidence(db: Queryable, q: { tags: string[]; text: string; limit?: number }): Promise<KnowledgeEvidence[]> {
  const terms = toTsQuery(q.text);
  if (q.tags.length === 0 && !terms) return [];
  const cols = O_COLS.split(",")
    .map((c) => `o.${c.trim()}`)
    .join(", ");
  const { rows } = await db.query<ObservationRow & { tags: string[] | null; login: string; display_name: string; kind: string; overlap: number }>(
    `SELECT ${cols}, o.tags, b.login, b.display_name, s.kind,
            cardinality(ARRAY(SELECT unnest(coalesce(o.tags, '{}')) INTERSECT SELECT unnest($1::text[])))::int AS overlap
       FROM observations o JOIN broadcasters b ON b.id = o.broadcaster_id
       ${PUBLIC}
        AND o.type NOT IN ('media_facts', 'session_coverage', 'source_gap')
        AND ((cardinality($1::text[]) > 0 AND o.tags && $1::text[]) OR ($2::text IS NOT NULL AND o.search @@ to_tsquery('simple', $2)))
      ORDER BY overlap DESC, o.received_at DESC
      LIMIT $3`,
    [q.tags, terms, q.limit ?? 12],
  );
  return rows.map((r) => ({ ...mapObservation(r), tags: r.tags ?? [], channelLogin: r.login, channelName: r.display_name, sessionKind: r.kind }));
}

/** Tags entries saved before tagging existed, a batch at a time. Returns how many it tagged. */
export async function backfillKnowledgeTags(db: Queryable, batch = 2000): Promise<number> {
  const { rows } = await db.query<{ id: string; type: string; description: string; raw_text: string | null; origin: string }>(
    `SELECT id, type, description, raw_text, origin FROM observations WHERE tags IS NULL LIMIT $1`,
    [batch],
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  const tags = rows.map((r) => `{${knowledgeTags({ type: r.type, description: r.description, rawText: r.raw_text, origin: r.origin }).map((t) => `"${t.replace(/["\\]/g, "")}"`).join(",")}}`);
  await db.query(
    `UPDATE observations o SET tags = v.tags::text[] FROM unnest($1::uuid[], $2::text[]) AS v(id, tags) WHERE o.id = v.id`,
    [ids, tags],
  );
  return rows.length;
}
