import type { Queryable } from "./client";

/**
 * SLOT1 chat moderation: bans and reports. The messages themselves live in Redis for 24 hours;
 * these rows are what has to outlast them.
 */

export interface ChatBanRow {
  id: string;
  user_id: string;
  room: string | null;
  name: string;
  banned_by_name: string | null;
  created_at: Date;
}

/** Banned in this room, or everywhere. */
export async function isChatBanned(db: Queryable, userId: string, room: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM chat_bans WHERE user_id = $1 AND (room IS NULL OR room = $2) LIMIT 1`, [userId, room]);
  return rows.length > 0;
}

/** `room` null bans in every chat. Banning twice is a no-op. */
export async function addChatBan(db: Queryable, input: { userId: string; room: string | null; name: string; bannedBy: string | null }): Promise<void> {
  await db.query(
    `INSERT INTO chat_bans (user_id, room, name, banned_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, room) DO NOTHING`,
    [input.userId, input.room, input.name.slice(0, 60), input.bannedBy],
  );
}

export async function listChatBans(db: Queryable, limit = 200): Promise<ChatBanRow[]> {
  const { rows } = await db.query<ChatBanRow>(
    `SELECT b.id::text AS id, b.user_id, b.room, b.name, u.display_name AS banned_by_name, b.created_at
       FROM chat_bans b LEFT JOIN users u ON u.id = b.banned_by
      ORDER BY b.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function removeChatBan(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM chat_bans WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export interface ChatReportInput {
  room: string;
  messageId: string;
  authorUserId: string | null;
  authorName: string;
  text: string;
  messageAt: string;
  reporterUserId: string;
}

/** False if this person already reported the message. Reports older than 30 days are removed. */
export async function addChatReport(db: Queryable, r: ChatReportInput): Promise<boolean> {
  await db.query(`DELETE FROM chat_reports WHERE created_at < now() - interval '30 days'`);
  const { rowCount } = await db.query(
    `INSERT INTO chat_reports (room, message_id, author_user_id, author_name, text, message_at, reporter_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (room, message_id, reporter_user_id) DO NOTHING`,
    [r.room, r.messageId, r.authorUserId, r.authorName.slice(0, 60), r.text.slice(0, 600), r.messageAt, r.reporterUserId],
  );
  return (rowCount ?? 0) > 0;
}

export interface ChatReportRow {
  room: string;
  message_id: string;
  author_user_id: string | null;
  author_name: string;
  text: string;
  message_at: Date;
  reports: number;
  first_reported_at: Date;
}

/** Open reports, one row per reported message, most reported first. */
export async function listOpenChatReports(db: Queryable, limit = 100): Promise<ChatReportRow[]> {
  const { rows } = await db.query<ChatReportRow>(
    `SELECT room, message_id, (array_agg(author_user_id))[1] AS author_user_id, min(author_name) AS author_name, min(text) AS text,
            min(message_at) AS message_at, count(*)::int AS reports, min(created_at) AS first_reported_at
       FROM chat_reports
      WHERE resolved_at IS NULL AND created_at > now() - interval '30 days'
      GROUP BY room, message_id
      ORDER BY count(*) DESC, min(created_at) ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getOpenChatReport(db: Queryable, room: string, messageId: string): Promise<ChatReportRow | null> {
  const { rows } = await db.query<ChatReportRow>(
    `SELECT room, message_id, (array_agg(author_user_id))[1] AS author_user_id, min(author_name) AS author_name, min(text) AS text,
            min(message_at) AS message_at, count(*)::int AS reports, min(created_at) AS first_reported_at
       FROM chat_reports
      WHERE resolved_at IS NULL AND room = $1 AND message_id = $2
      GROUP BY room, message_id`,
    [room, messageId],
  );
  return rows[0] ?? null;
}

/** Mark every open report of a message handled. */
export async function resolveChatReports(db: Queryable, room: string, messageId: string): Promise<number> {
  const { rowCount } = await db.query(`UPDATE chat_reports SET resolved_at = now() WHERE room = $1 AND message_id = $2 AND resolved_at IS NULL`, [room, messageId]);
  return rowCount ?? 0;
}
