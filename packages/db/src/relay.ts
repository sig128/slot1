import type { RelayPlatform, RelayStatus } from "@slot1/contracts";
import type { Queryable } from "./client";

export interface RelayDestinationRow {
  id: string;
  broadcaster_id: string;
  platform: RelayPlatform;
  label: string;
  server_url: string | null;
  key_enc: string | null;
  key_id: string | null;
  key_hint: string | null;
  enabled: boolean;
  status: RelayStatus;
  status_detail: string | null;
  last_connected_at: Date | null;
  status_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, broadcaster_id, platform, label, server_url, key_enc, key_id, key_hint, enabled, status, status_detail,
  last_connected_at, status_changed_at, created_at, updated_at`;

export async function listRelayDestinations(db: Queryable, broadcasterId: string): Promise<RelayDestinationRow[]> {
  const { rows } = await db.query<RelayDestinationRow>(
    `SELECT ${COLS} FROM relay_destinations WHERE broadcaster_id = $1 ORDER BY (platform = 'twitch') DESC, created_at`,
    [broadcasterId],
  );
  return rows;
}

export async function getRelayDestination(db: Queryable, id: string): Promise<RelayDestinationRow | null> {
  const { rows } = await db.query<RelayDestinationRow>(`SELECT ${COLS} FROM relay_destinations WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function countRelayDestinations(db: Queryable, broadcasterId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM relay_destinations WHERE broadcaster_id = $1`, [broadcasterId]);
  return rows[0]?.n ?? 0;
}

export async function insertRelayDestination(
  db: Queryable,
  input: {
    broadcasterId: string;
    platform: RelayPlatform;
    label: string;
    serverUrl: string | null;
    keyEnc: string | null;
    keyId: string | null;
    keyHint: string | null;
  },
): Promise<RelayDestinationRow> {
  const { rows } = await db.query<RelayDestinationRow>(
    `INSERT INTO relay_destinations (broadcaster_id, platform, label, server_url, key_enc, key_id, key_hint)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
    [input.broadcasterId, input.platform, input.label, input.serverUrl, input.keyEnc, input.keyId, input.keyHint],
  );
  return rows[0]!;
}

export async function updateRelayDestination(
  db: Queryable,
  id: string,
  patch: { label?: string; serverUrl?: string | null; keyEnc?: string | null; keyId?: string | null; keyHint?: string | null; enabled?: boolean },
): Promise<RelayDestinationRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const add = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (patch.label !== undefined) add("label", patch.label);
  if (patch.serverUrl !== undefined) add("server_url", patch.serverUrl);
  if (patch.keyEnc !== undefined) add("key_enc", patch.keyEnc);
  if (patch.keyId !== undefined) add("key_id", patch.keyId);
  if (patch.keyHint !== undefined) add("key_hint", patch.keyHint);
  if (patch.enabled !== undefined) {
    add("enabled", patch.enabled);
    // Switching on starts from "idle"; switching off is immediate and clears any error.
    sets.push(patch.enabled ? `status = CASE WHEN status = 'disabled' THEN 'idle' ELSE status END` : `status = 'disabled', status_detail = NULL`);
    sets.push(`status_changed_at = now()`);
  }
  if (sets.length === 0) return getRelayDestination(db, id);
  const { rows } = await db.query<RelayDestinationRow>(
    `UPDATE relay_destinations SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    values,
  );
  return rows[0] ?? null;
}

/** Deleting a destination erases its encrypted key with the row. */
export async function deleteRelayDestination(db: Queryable, broadcasterId: string, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM relay_destinations WHERE id = $1 AND broadcaster_id = $2`, [id, broadcasterId]);
  return (r.rowCount ?? 0) > 0;
}

/** Status written by the relay worker. Only changes the row while it is still enabled. */
export async function setRelayStatus(db: Queryable, id: string, status: RelayStatus, detail: string | null, connected = false) {
  await db.query(
    `UPDATE relay_destinations
        SET status = $2, status_detail = $3, status_changed_at = now(),
            last_connected_at = CASE WHEN $4 THEN now() ELSE last_connected_at END
      WHERE id = $1 AND (enabled OR $2 = 'disabled')`,
    [id, status, detail, connected],
  );
}

/** Every enabled destination of creators who are publishing a LIVE (not TEST) ingest source right now. */
export async function listActiveRelayPairs(db: Queryable): Promise<{ destination: RelayDestinationRow; sourceId: string; publishPath: string }[]> {
  const { rows } = await db.query<RelayDestinationRow & { source_id: string; publish_path: string }>(
    `SELECT ${COLS.split(",")
      .map((c) => `d.${c.trim()}`)
      .join(", ")}, s.id AS source_id, s.publish_path
       FROM relay_destinations d
       JOIN LATERAL (
         SELECT id, publish_path FROM media_sources
          WHERE broadcaster_id = d.broadcaster_id AND kind = 'live_ingest' AND label = 'live'
            AND status = 'publishing' AND revoked_at IS NULL
          ORDER BY publish_started_at DESC NULLS LAST LIMIT 1
       ) s ON true
      WHERE d.enabled`,
  );
  return rows.map(({ source_id, publish_path, ...d }) => ({ destination: d as RelayDestinationRow, sourceId: source_id, publishPath: publish_path }));
}

/** The creator just allowed Twitch forwarding: Twitch destinations waiting for it are ready again. */
export async function clearRelayPermissionWait(db: Queryable, broadcasterId: string) {
  await db.query(
    `UPDATE relay_destinations SET status = 'idle', status_detail = NULL, status_changed_at = now()
      WHERE broadcaster_id = $1 AND platform = 'twitch' AND enabled AND status = 'needs_permission'`,
    [broadcasterId],
  );
}

/** Enabled destinations whose creator is not streaming: shown as "idle". */
export async function markIdleRelayDestinations(db: Queryable, activeIds: string[]) {
  await db.query(
    `UPDATE relay_destinations SET status = 'idle', status_detail = NULL, status_changed_at = now()
      WHERE enabled AND status NOT IN ('idle', 'needs_permission', 'error') AND NOT (id = ANY ($1::uuid[]))`,
    [activeIds],
  );
}
