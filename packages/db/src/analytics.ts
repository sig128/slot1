import type { AdminDay, AdminVisitorTotals, BrowserFamily, ContactMessageStatus, ContactMessageView, ContactTopic, DeviceType } from "@slot1/contracts";
import { isoReq, iso, type Queryable } from "./client";

/* ------------------------------------------------------------------------------------------ */
/* Page views (cookieless; see 0005_analytics.sql)                                            */
/* ------------------------------------------------------------------------------------------ */

export const ANALYTICS_RAW_RETENTION_DAYS = 90;
export const CONTACT_RETENTION_MONTHS = 24;

export interface NewPageView {
  path: string;
  referrerHost: string | null;
  device: DeviceType;
  browser: BrowserFamily;
  visitorId: Buffer;
  /** Defaults to now(); tests pass explicit times. */
  at?: Date;
}

export async function insertPageView(db: Queryable, v: NewPageView): Promise<void> {
  await db.query(
    `INSERT INTO page_views (created_at, path, referrer_host, device, browser, visitor_id)
     VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5, $6)`,
    [v.at ?? null, v.path, v.referrerHost, v.device, v.browser, v.visitorId],
  );
}

/** Start of the UTC day `daysAgo` days before today (0 = today). */
const DAY_START = `(date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1::int)) AT TIME ZONE 'UTC'`;

/**
 * Views and visitors since the start of the UTC day `daysAgo` days back. Visitor IDs change at
 * UTC midnight, so "visitors" is the sum of each day's unique visitors.
 */
export async function visitorTotals(db: Queryable, daysAgo: number): Promise<AdminVisitorTotals> {
  const { rows } = await db.query<{ views: number; visitors: number }>(
    `SELECT COALESCE(sum(views), 0)::int AS views, COALESCE(sum(visitors), 0)::int AS visitors FROM (
       SELECT count(*) AS views, count(DISTINCT visitor_id) AS visitors
         FROM page_views WHERE created_at >= ${DAY_START}
        GROUP BY (created_at AT TIME ZONE 'UTC')::date
     ) d`,
    [daysAgo],
  );
  return { views: rows[0]?.views ?? 0, visitors: rows[0]?.visitors ?? 0 };
}

/** One row per UTC day for the last `days` days (oldest first), zero-filled. */
export async function dailyVisitors(db: Queryable, days: number): Promise<AdminDay[]> {
  const { rows } = await db.query<{ day: string; views: number; visitors: number }>(
    `WITH span AS (
       SELECT generate_series((now() AT TIME ZONE 'UTC')::date - ($1::int - 1), (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day
     ), raw AS (
       SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS views, count(DISTINCT visitor_id)::int AS visitors
         FROM page_views WHERE created_at >= ${DAY_START.replace("$1::int", "($1::int - 1)")}
        GROUP BY 1
     )
     SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
            COALESCE(r.views, d.views, 0)::int AS views,
            COALESCE(r.visitors, d.visitors, 0)::int AS visitors
       FROM span s LEFT JOIN raw r USING (day) LEFT JOIN analytics_daily d USING (day)
      ORDER BY s.day`,
    [days],
  );
  return rows;
}

/** All views ever counted: kept daily totals for days whose raw rows are gone, plus raw rows. */
export async function allTimeViews(db: Queryable): Promise<{ views: number; since: string | null }> {
  const { rows } = await db.query<{ views: number; since: string | null }>(
    `WITH first_raw AS (SELECT min(created_at) AS at FROM page_views)
     SELECT (COALESCE((SELECT sum(views) FROM analytics_daily
                        WHERE day < COALESCE(((SELECT at FROM first_raw) AT TIME ZONE 'UTC')::date, 'infinity'::date)), 0)
             + (SELECT count(*) FROM page_views))::bigint AS views,
            to_char(LEAST((SELECT min(day) FROM analytics_daily), ((SELECT at FROM first_raw) AT TIME ZONE 'UTC')::date), 'YYYY-MM-DD') AS since`,
  );
  return { views: Number(rows[0]?.views ?? 0), since: rows[0]?.since ?? null };
}

export type RankDimension = "path" | "referrer_host" | "device" | "browser";

/** Top values of one dimension over the last `days` days (views, and the sum of daily uniques). */
export async function rankedVisitors(db: Queryable, dimension: RankDimension, days: number, limit: number): Promise<{ key: string; views: number; visitors: number }[]> {
  // The dimension is one of four fixed column names, never user input.
  const col = ({ path: "path", referrer_host: "referrer_host", device: "device", browser: "browser" } as const)[dimension];
  const { rows } = await db.query<{ key: string; views: number; visitors: number }>(
    `SELECT key, sum(views)::int AS views, sum(visitors)::int AS visitors FROM (
       SELECT ${col} AS key, (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS views, count(DISTINCT visitor_id) AS visitors
         FROM page_views
        WHERE created_at >= ${DAY_START.replace("$1::int", "($1::int - 1)")} AND ${col} IS NOT NULL
        GROUP BY 1, 2
     ) d
     GROUP BY key ORDER BY views DESC, key ASC LIMIT $2`,
    [days, limit],
  );
  return rows;
}

/**
 * Keep the daily totals of every completed UTC day, then delete raw rows older than the
 * retention window. Idempotent: days that still have raw rows are recomputed from them.
 */
export async function rollupAndPruneAnalytics(db: Queryable, keepDays = ANALYTICS_RAW_RETENTION_DAYS): Promise<{ daysRolledUp: number; rowsDeleted: number }> {
  const rolled = await db.query(
    `INSERT INTO analytics_daily (day, views, visitors, updated_at)
     SELECT (created_at AT TIME ZONE 'UTC')::date, count(*), count(DISTINCT visitor_id), now()
       FROM page_views
      WHERE created_at < (date_trunc('day', now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC'
        AND created_at >= COALESCE(((SELECT max(day) FROM analytics_daily) - 1)::timestamp AT TIME ZONE 'UTC', '-infinity')
      GROUP BY 1
     ON CONFLICT (day) DO UPDATE SET views = EXCLUDED.views, visitors = EXCLUDED.visitors, updated_at = now()`,
  );
  const deleted = await db.query(`DELETE FROM page_views WHERE created_at < ${DAY_START}`, [keepDays]);
  return { daysRolledUp: rolled.rowCount ?? 0, rowsDeleted: deleted.rowCount ?? 0 };
}

/* ------------------------------------------------------------------------------------------ */
/* Contact messages                                                                           */
/* ------------------------------------------------------------------------------------------ */

interface ContactRow {
  id: string;
  created_at: Date;
  name: string | null;
  email: string;
  topic: ContactTopic;
  message: string;
  status: ContactMessageStatus;
  closed_at: Date | null;
}

const toContactView = (r: ContactRow): ContactMessageView => ({
  id: r.id,
  createdAt: isoReq(r.created_at),
  name: r.name,
  email: r.email,
  topic: r.topic,
  message: r.message,
  status: r.status,
  closedAt: iso(r.closed_at),
});

export async function insertContactMessage(db: Queryable, m: { name: string | null; email: string; topic: ContactTopic; message: string; at?: Date }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contact_messages (created_at, name, email, topic, message) VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5) RETURNING id`,
    [m.at ?? null, m.name, m.email, m.topic, m.message],
  );
  return rows[0]!.id;
}

/** Newest first. `before` is the createdAt of the last message already shown. */
export async function listContactMessages(
  db: Queryable,
  opts: { status: ContactMessageStatus | "all"; before: string | null; limit: number },
): Promise<{ messages: ContactMessageView[]; nextBefore: string | null }> {
  const { rows } = await db.query<ContactRow>(
    `SELECT id, created_at, name, email, topic, message, status, closed_at FROM contact_messages
      WHERE ($1::text = 'all' OR status = $1) AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [opts.status, opts.before, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  return { messages: page.map(toContactView), nextBefore: rows.length > opts.limit && page.length ? isoReq(page[page.length - 1]!.created_at) : null };
}

export async function contactCounts(db: Queryable): Promise<{ open: number; closed: number }> {
  const { rows } = await db.query<{ open: number; closed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'closed')::int AS closed FROM contact_messages`,
  );
  return { open: rows[0]?.open ?? 0, closed: rows[0]?.closed ?? 0 };
}

export async function setContactStatus(db: Queryable, id: string, status: ContactMessageStatus): Promise<ContactMessageView | null> {
  const { rows } = await db.query<ContactRow>(
    `UPDATE contact_messages SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END
      WHERE id = $1 RETURNING id, created_at, name, email, topic, message, status, closed_at`,
    [id, status],
  );
  return rows[0] ? toContactView(rows[0]) : null;
}

export async function deleteContactMessage(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM contact_messages WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function pruneContactMessages(db: Queryable, months = CONTACT_RETENTION_MONTHS): Promise<number> {
  const r = await db.query(`DELETE FROM contact_messages WHERE created_at < now() - make_interval(months => $1::int)`, [months]);
  return r.rowCount ?? 0;
}
