import { knowledgeTags, vehicleName, weaponName, type Observation } from "@slot1/contracts";
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

export type NamedKind = "vehicle" | "weapon" | "person" | "place" | "item" | "text" | "objective" | "other";

export interface NamedThing {
  kind: NamedKind;
  label: string;
  seen: number;
  streams: number;
  /** The newest entry with it. */
  latestId: string;
}

const ENTITY_KINDS = new Set(["vehicle", "person", "place", "item", "text", "other"]);
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Everything SLOT1 named on public streams: what the AI named in the picture, the objectives read on
 * screen, and car and weapon names the game showed (whole lines of on-screen text the dictionary
 * knows). No fixed list; the most seen first, and how many there are in all.
 */
export async function namedThings(db: Queryable, limit = 600): Promise<{ things: NamedThing[]; total: number }> {
  const [named, lines] = await Promise.all([
    db.query<{ kind: string; label: string; seen: number; streams: number; latest: string; total: number }>(
      `SELECT kind, min(label) AS label, count(*)::int AS seen, count(DISTINCT session_id)::int AS streams,
              (array_agg(id ORDER BY received_at DESC))[1] AS latest, count(*) OVER ()::int AS total
         FROM (
           SELECT o.id, o.session_id, o.received_at, e->>'kind' AS kind, btrim(e->>'label') AS label
             FROM observations o
             CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.related_entities) = 'array' THEN o.related_entities ELSE '[]'::jsonb END) AS e
             ${PUBLIC} AND coalesce(e->>'certainty', '') <> 'uncertain' AND length(btrim(e->>'label')) BETWEEN 2 AND 80
           UNION ALL
           SELECT o.id, o.session_id, o.received_at, 'objective', btrim(regexp_replace(o.raw_text, '[[:space:].!]+$', ''))
             FROM observations o
             ${PUBLIC} AND o.type = 'objective_text' AND o.raw_text IS NOT NULL AND length(btrim(o.raw_text)) BETWEEN 4 AND 120
         ) x
        GROUP BY kind, lower(regexp_replace(label, '[^[:alnum:]]+', ' ', 'g'))
        ORDER BY seen DESC, label
        LIMIT $1`,
      [limit],
    ),
    // Short lines of on-screen text, to find the car and weapon names among them.
    db.query<{ raw: string; seen: number; streams: number; latest: string }>(
      `SELECT min(o.raw_text) AS raw, count(*)::int AS seen, count(DISTINCT o.session_id)::int AS streams,
              (array_agg(o.id ORDER BY o.received_at DESC))[1] AS latest
         FROM observations o
         ${PUBLIC} AND o.origin = 'ocr' AND o.type IN ('place_name', 'visible_text') AND o.raw_text IS NOT NULL AND length(o.raw_text) <= 40
        GROUP BY lower(regexp_replace(o.raw_text, '[^[:alnum:]]+', ' ', 'g'))
        ORDER BY seen DESC
        LIMIT 5000`,
    ),
  ]);
  const byKey = new Map<string, NamedThing>();
  for (const r of named.rows) {
    const kind = (r.kind === "objective" || ENTITY_KINDS.has(r.kind) ? r.kind : "other") as NamedKind;
    byKey.set(`${kind}:${nameKey(r.label)}`, { kind, label: r.label, seen: r.seen, streams: r.streams, latestId: r.latest });
  }
  let fromScreen = 0;
  for (const r of lines.rows) {
    const vehicle = vehicleName(r.raw);
    const weapon = vehicle ? null : weaponName(r.raw);
    const label = vehicle ?? weapon;
    if (!label) continue;
    const kind: NamedKind = vehicle ? "vehicle" : "weapon";
    const k = `${kind}:${nameKey(label)}`;
    const cur = byKey.get(k);
    if (cur) {
      cur.seen += r.seen;
      cur.streams = Math.max(cur.streams, r.streams);
    } else {
      byKey.set(k, { kind, label, seen: r.seen, streams: r.streams, latestId: r.latest });
      fromScreen += 1;
    }
  }
  const things = [...byKey.values()].sort((a, b) => b.seen - a.seen || a.label.localeCompare(b.label)).slice(0, limit);
  return { things, total: (named.rows[0]?.total ?? 0) + fromScreen };
}

/** Particular entries (the proof behind a mission or a result), public ones only, in the order asked. */
export async function knowledgeEntries(db: Queryable, ids: string[]): Promise<KnowledgeEvidence[]> {
  if (ids.length === 0) return [];
  const cols = O_COLS.split(",")
    .map((c) => `o.${c.trim()}`)
    .join(", ");
  const { rows } = await db.query<ObservationRow & { tags: string[] | null; login: string; display_name: string; kind: string }>(
    `SELECT ${cols}, o.tags, b.login, b.display_name, s.kind
       FROM observations o JOIN broadcasters b ON b.id = o.broadcaster_id
       ${PUBLIC} AND o.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ ...mapObservation(r), tags: r.tags ?? [], channelLogin: r.login, channelName: r.display_name, sessionKind: r.kind }));
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
