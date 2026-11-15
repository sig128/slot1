import type { Queryable } from "./client";

/**
 * Totals for the Learning page. "Watched" counts only what anyone could already see: public
 * channels with public analysis, public sessions, and never TEST sources. "Learned from" counts only
 * channels that have switched on training right now.
 */

const PUBLIC_SESSIONS = `
  FROM stream_sessions s
  JOIN channel_settings cs ON cs.broadcaster_id = s.broadcaster_id
 WHERE s.visibility = 'public' AND cs.visibility = 'public' AND cs.public_analysis AND coalesce(s.label, '') <> 'test'`;

export async function learningWatched(db: Queryable): Promise<{ streams: number; channels: number; analyzedMs: number }> {
  const { rows } = await db.query<{ streams: number; channels: number; analyzed_ms: string }>(
    `SELECT count(*)::int AS streams, count(DISTINCT s.broadcaster_id)::int AS channels, coalesce(sum(s.analyzed_ms), 0)::text AS analyzed_ms
     ${PUBLIC_SESSIONS} AND s.analyzed_ms > 0`,
  );
  const r = rows[0];
  return { streams: r?.streams ?? 0, channels: r?.channels ?? 0, analyzedMs: Number(r?.analyzed_ms ?? 0) };
}

/**
 * What SLOT1 named on public streams, by the same rules as "Right now" (deriveActivity in
 * contracts/now.ts): result screens read on screen, chases, crashes, shootouts, the GTA model's
 * scenes, and mission text. Rejected entries and Twitch-side entries never count.
 */
export async function learningSeen(db: Queryable): Promise<Map<string, number>> {
  const result = `coalesce(o.raw_text, CASE WHEN o.type = 'result_screen' THEN o.description END)`;
  const scene = (name: string, key: string) => `WHEN o.type = 'environment' AND o.description ~* '^Scene: ${name}\\s*$' THEN '${key}'`;
  const { rows } = await db.query<{ key: string; n: number }>(
    `SELECT key, count(*)::int AS n FROM (
       SELECT CASE
         WHEN ${result} ~* '\\m(MISSION PASSED|MISSION COMPLETE)\\M' THEN 'mission_passed'
         WHEN ${result} ~* '\\mMISSION FAILED\\M' THEN 'mission_failed'
         WHEN ${result} ~* '\\mWASTED\\M' THEN 'wasted'
         WHEN ${result} ~* '\\mBUSTED\\M' THEN 'busted'
         WHEN o.type = 'movement' AND o.description ~* 'chase' THEN 'police_chase'
         WHEN o.type = 'possible_collision' THEN 'crash'
         WHEN o.type = 'combat' THEN 'shootout'
         ${scene("driving", "driving")}
         ${scene("on foot", "on_foot")}
         ${scene("shootout", "shootout")}
         ${scene("cutscene", "cutscene")}
         ${scene("menu or map", "menu")}
         ${scene("phone", "phone")}
         ${scene("loading or black", "loading")}
         WHEN o.type IN ('mission_title', 'objective_text') AND length(btrim(coalesce(o.raw_text, ''))) >= 3 THEN 'mission'
       END AS key
       FROM observations o
       JOIN stream_sessions s ON s.id = o.session_id
       JOIN channel_settings cs ON cs.broadcaster_id = o.broadcaster_id
      WHERE o.origin <> 'twitch' AND o.review_status <> 'rejected'
        AND s.visibility = 'public' AND cs.visibility = 'public' AND cs.public_analysis AND coalesce(s.label, '') <> 'test'
     ) t
     WHERE key IS NOT NULL
     GROUP BY key`,
  );
  return new Map(rows.map((r) => [r.key, r.n]));
}

/** Frames kept to learn from, and how many people labeled, from channels that consent now. */
export async function learningFrames(db: Queryable): Promise<{ frames: number; labeled: number }> {
  const { rows } = await db.query<{ frames: number; labeled: number }>(
    `SELECT count(*)::int AS frames, count(*) FILTER (WHERE f.status = 'labeled')::int AS labeled
       FROM training_frames f
       JOIN channel_settings cs ON cs.broadcaster_id = f.broadcaster_id AND cs.training_consent`,
  );
  return { frames: rows[0]?.frames ?? 0, labeled: rows[0]?.labeled ?? 0 };
}

/** Labeled examples per class ("event:wasted", "box:minimap"…): accepted labels on consenting channels' frames. */
export async function learningExamples(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query<{ kind: string; class: string; n: number }>(
    `SELECT l.kind, l.class, count(DISTINCT l.frame_id)::int AS n
       FROM training_labels l
       JOIN training_frames f ON f.id = l.frame_id AND f.status = 'labeled'
       JOIN channel_settings cs ON cs.broadcaster_id = f.broadcaster_id AND cs.training_consent
      WHERE l.status = 'accepted'
      GROUP BY l.kind, l.class`,
  );
  return new Map(rows.map((r) => [`${r.kind}:${r.class}`, r.n]));
}
