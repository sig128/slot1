import type { Queryable } from "./client";

/** A file a creator uploaded for their edits (music, voice-over, logo). */
export interface ProjectMediaRow {
  id: string;
  broadcaster_id: string;
  project_id: string | null;
  kind: "audio" | "image";
  name: string;
  storage_key: string;
  content_type: string;
  bytes: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  rights_confirmed_at: Date;
  created_at: Date;
}

const mapMedia = (r: ProjectMediaRow): ProjectMediaRow => ({ ...r, bytes: Number(r.bytes), duration_ms: r.duration_ms === null ? null : Number(r.duration_ms) });

export async function insertProjectMedia(
  db: Queryable,
  m: { id: string; broadcasterId: string; projectId: string | null; kind: "audio" | "image"; name: string; storageKey: string; contentType: string; bytes: number; durationMs: number | null; width: number | null; height: number | null },
): Promise<ProjectMediaRow> {
  const { rows } = await db.query<ProjectMediaRow>(
    `INSERT INTO project_media (id, broadcaster_id, project_id, kind, name, storage_key, content_type, bytes, duration_ms, width, height, rights_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING *`,
    [m.id, m.broadcasterId, m.projectId, m.kind, m.name.slice(0, 120), m.storageKey, m.contentType, m.bytes, m.durationMs, m.width, m.height],
  );
  return mapMedia(rows[0]!);
}

export async function getProjectMedia(db: Queryable, id: string): Promise<ProjectMediaRow | null> {
  const { rows } = await db.query<ProjectMediaRow>(`SELECT * FROM project_media WHERE id = $1`, [id]);
  return rows[0] ? mapMedia(rows[0]) : null;
}

export async function listProjectMedia(db: Queryable, broadcasterId: string): Promise<ProjectMediaRow[]> {
  const { rows } = await db.query<ProjectMediaRow>(`SELECT * FROM project_media WHERE broadcaster_id = $1 ORDER BY created_at DESC LIMIT 200`, [broadcasterId]);
  return rows.map(mapMedia);
}

export async function deleteProjectMedia(db: Queryable, id: string): Promise<void> {
  await db.query(`DELETE FROM project_media WHERE id = $1`, [id]);
}
