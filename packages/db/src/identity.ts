import type { BroadcasterRef, ChannelSettings, ChannelSettingsPatch } from "@slot1/contracts";
import type { Queryable } from "./client";

/* ------------------------------------------------------------------------------------------ */
/* Users & browser sessions                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface UserRow {
  id: string;
  kind: "twitch" | "local";
  twitch_user_id: string | null;
  display_name: string;
  is_operator: boolean;
}

export async function createLocalUser(db: Queryable, displayName: string): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (kind, display_name) VALUES ('local', $1) RETURNING id, kind, twitch_user_id, display_name, is_operator`,
    [displayName],
  );
  return rows[0]!;
}

export async function upsertTwitchUser(db: Queryable, twitchUserId: string, displayName: string, isOperator: boolean): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (kind, twitch_user_id, display_name, is_operator) VALUES ('twitch', $1, $2, $3)
     ON CONFLICT (twitch_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, is_operator = EXCLUDED.is_operator
     RETURNING id, kind, twitch_user_id, display_name, is_operator`,
    [twitchUserId, displayName, isOperator],
  );
  return rows[0]!;
}

export async function getUser(db: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(`SELECT id, kind, twitch_user_id, display_name, is_operator FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export interface SessionRow {
  id_hash: Buffer;
  user_id: string | null;
  csrf_token: string;
  expires_at: Date;
}

export async function createBrowserSession(db: Queryable, idHash: Buffer, csrfToken: string, ttlSec: number, userId: string | null) {
  await db.query(
    `INSERT INTO user_sessions (id_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [idHash, userId, csrfToken, ttlSec],
  );
}

export async function getBrowserSession(db: Queryable, idHash: Buffer): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `UPDATE user_sessions SET last_seen_at = now() WHERE id_hash = $1 AND expires_at > now()
     RETURNING id_hash, user_id, csrf_token, expires_at`,
    [idHash],
  );
  return rows[0] ?? null;
}

export async function deleteBrowserSession(db: Queryable, idHash: Buffer) {
  await db.query(`DELETE FROM user_sessions WHERE id_hash = $1`, [idHash]);
}

export async function deleteSessionsForUser(db: Queryable, userId: string) {
  await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

/* ------------------------------------------------------------------------------------------ */
/* OAuth state                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface OAuthStateRow {
  role: "broadcaster" | "bot";
  redirect_uri: string;
  requested_scopes: string[];
  return_to: string | null;
}

export async function createOAuthState(
  db: Queryable,
  input: { stateHash: Buffer; sessionIdHash: Buffer; role: "broadcaster" | "bot"; redirectUri: string; scopes: string[]; returnTo: string | null },
) {
  await db.query(
    `INSERT INTO oauth_states (state_hash, session_id_hash, role, redirect_uri, requested_scopes, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
    [input.stateHash, input.sessionIdHash, input.role, input.redirectUri, input.scopes, input.returnTo],
  );
}

/**
 * Consume an OAuth state exactly once. It must exist, be unexpired, unconsumed and bound to the
 * same browser session that started the flow. Anything else returns null (rejected).
 */
export async function consumeOAuthState(db: Queryable, stateHash: Buffer, sessionIdHash: Buffer): Promise<OAuthStateRow | null> {
  const { rows } = await db.query<OAuthStateRow>(
    `UPDATE oauth_states SET consumed_at = now()
     WHERE state_hash = $1 AND session_id_hash = $2 AND consumed_at IS NULL AND expires_at > now()
     RETURNING role, redirect_uri, requested_scopes, return_to`,
    [stateHash, sessionIdHash],
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------------------------------ */
/* Broadcasters                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface BroadcasterRow {
  id: string;
  owner_user_id: string;
  kind: "twitch" | "local";
  twitch_user_id: string | null;
  login: string;
  display_name: string;
  avatar_url: string | null;
}

const B_COLS = `id, owner_user_id, kind, twitch_user_id, login, display_name, avatar_url`;

export function toBroadcasterRef(b: BroadcasterRow): BroadcasterRef {
  return { id: b.id, login: b.login, displayName: b.display_name, avatarUrl: b.avatar_url, kind: b.kind };
}

export async function createLocalBroadcaster(db: Queryable, ownerUserId: string, login: string, displayName: string): Promise<BroadcasterRow> {
  const { rows } = await db.query<BroadcasterRow>(
    `INSERT INTO broadcasters (owner_user_id, kind, login, display_name) VALUES ($1, 'local', $2, $3) RETURNING ${B_COLS}`,
    [ownerUserId, login, displayName],
  );
  await ensureSettings(db, rows[0]!.id);
  return rows[0]!;
}

export async function upsertTwitchBroadcaster(
  db: Queryable,
  input: { ownerUserId: string; twitchUserId: string; login: string; displayName: string; avatarUrl: string | null },
): Promise<BroadcasterRow> {
  const { rows } = await db.query<BroadcasterRow>(
    `INSERT INTO broadcasters (owner_user_id, kind, twitch_user_id, login, display_name, avatar_url)
     VALUES ($1, 'twitch', $2, $3, $4, $5)
     ON CONFLICT (twitch_user_id) DO UPDATE SET login = EXCLUDED.login, display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url, owner_user_id = EXCLUDED.owner_user_id, updated_at = now()
     RETURNING ${B_COLS}`,
    [input.ownerUserId, input.twitchUserId, input.login.toLowerCase(), input.displayName, input.avatarUrl],
  );
  await ensureSettings(db, rows[0]!.id);
  return rows[0]!;
}

export async function getBroadcaster(db: Queryable, id: string): Promise<BroadcasterRow | null> {
  const { rows } = await db.query<BroadcasterRow>(`SELECT ${B_COLS} FROM broadcasters WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getBroadcasterByTwitchId(db: Queryable, twitchUserId: string): Promise<BroadcasterRow | null> {
  const { rows } = await db.query<BroadcasterRow>(`SELECT ${B_COLS} FROM broadcasters WHERE twitch_user_id = $1`, [twitchUserId]);
  return rows[0] ?? null;
}

export async function getBroadcasterByLogin(db: Queryable, login: string): Promise<BroadcasterRow | null> {
  const { rows } = await db.query<BroadcasterRow>(
    `SELECT ${B_COLS} FROM broadcasters WHERE lower(login) = lower($1) ORDER BY (kind = 'twitch') DESC LIMIT 1`,
    [login],
  );
  return rows[0] ?? null;
}

export async function getBroadcasterForOwner(db: Queryable, ownerUserId: string): Promise<BroadcasterRow | null> {
  const { rows } = await db.query<BroadcasterRow>(
    `SELECT ${B_COLS} FROM broadcasters WHERE owner_user_id = $1 ORDER BY (kind = 'twitch') DESC, created_at ASC LIMIT 1`,
    [ownerUserId],
  );
  return rows[0] ?? null;
}

export async function listDirectoryBroadcasters(db: Queryable): Promise<BroadcasterRow[]> {
  const { rows } = await db.query<BroadcasterRow>(
    `SELECT b.id, b.owner_user_id, b.kind, b.twitch_user_id, b.login, b.display_name, b.avatar_url
     FROM broadcasters b JOIN channel_settings cs ON cs.broadcaster_id = b.id
     JOIN broadcaster_connections bc ON bc.broadcaster_id = b.id
     WHERE b.kind = 'twitch' AND cs.directory_opt_in AND cs.visibility = 'public' AND bc.status = 'active'
     ORDER BY b.display_name`,
  );
  return rows;
}

/* ------------------------------------------------------------------------------------------ */
/* Channel settings                                                                           */
/* ------------------------------------------------------------------------------------------ */

interface SettingsRow {
  visibility: "public" | "private";
  directory_opt_in: boolean;
  public_analysis: boolean;
  viewer_questions: ChannelSettings["viewerQuestions"];
  bot_enabled: boolean;
  bot_killed: boolean;
  commentary_mode: ChannelSettings["commentaryMode"];
  commentary_muted: boolean;
  allowed_commands: ChannelSettings["allowedCommands"];
  short_aliases_enabled: boolean;
  clip_permission: ChannelSettings["clipPermission"];
  approved_moderator_ids: string[];
  user_cooldown_sec: number;
  channel_cooldown_sec: number;
  agent_enabled: boolean;
  analysis_paused: boolean;
  recording_consent: boolean;
  rolling_buffer_enabled: boolean;
  rolling_buffer_seconds: number;
  retention_days: number;
  sample_interval_ms: number;
  max_vision_calls_per_hour: number;
  game_profile: ChannelSettings["gameProfile"];
  training_consent: boolean;
  recording_enabled: boolean;
  recording_retention_days: number;
  auto_clips: boolean;
  auto_clip_pre_roll_ms: number;
  auto_clip_post_roll_ms: number;
  chat_announcements: boolean;
}

const SETTINGS_MAP: Record<keyof ChannelSettings, keyof SettingsRow> = {
  visibility: "visibility",
  directoryOptIn: "directory_opt_in",
  publicAnalysis: "public_analysis",
  viewerQuestions: "viewer_questions",
  botEnabled: "bot_enabled",
  botKilled: "bot_killed",
  commentaryMode: "commentary_mode",
  commentaryMuted: "commentary_muted",
  allowedCommands: "allowed_commands",
  shortAliasesEnabled: "short_aliases_enabled",
  clipPermission: "clip_permission",
  approvedModeratorIds: "approved_moderator_ids",
  userCooldownSec: "user_cooldown_sec",
  channelCooldownSec: "channel_cooldown_sec",
  agentEnabled: "agent_enabled",
  analysisPaused: "analysis_paused",
  recordingConsent: "recording_consent",
  rollingBufferEnabled: "rolling_buffer_enabled",
  rollingBufferSeconds: "rolling_buffer_seconds",
  retentionDays: "retention_days",
  sampleIntervalMs: "sample_interval_ms",
  maxVisionCallsPerHour: "max_vision_calls_per_hour",
  gameProfile: "game_profile",
  trainingConsent: "training_consent",
  recordingEnabled: "recording_enabled",
  recordingRetentionDays: "recording_retention_days",
  autoClips: "auto_clips",
  autoClipPreRollMs: "auto_clip_pre_roll_ms",
  autoClipPostRollMs: "auto_clip_post_roll_ms",
  chatAnnouncements: "chat_announcements",
};

export async function ensureSettings(db: Queryable, broadcasterId: string) {
  await db.query(`INSERT INTO channel_settings (broadcaster_id) VALUES ($1) ON CONFLICT DO NOTHING`, [broadcasterId]);
}

export async function getSettings(db: Queryable, broadcasterId: string): Promise<ChannelSettings> {
  await ensureSettings(db, broadcasterId);
  const { rows } = await db.query<SettingsRow>(`SELECT * FROM channel_settings WHERE broadcaster_id = $1`, [broadcasterId]);
  const r = rows[0]!;
  const out = {} as Record<string, unknown>;
  for (const [k, col] of Object.entries(SETTINGS_MAP)) out[k] = r[col];
  return out as ChannelSettings;
}

/**
 * Apply a validated settings patch. `agentEnabled` is intentionally NOT patchable here — it
 * can only be switched on through the readiness check that requires a real video source.
 */
export async function updateSettings(db: Queryable, broadcasterId: string, patch: ChannelSettingsPatch & { agentEnabled?: boolean }) {
  const sets: string[] = [];
  const values: unknown[] = [broadcasterId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = SETTINGS_MAP[k as keyof ChannelSettings];
    if (!col) continue;
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  }
  if (sets.length === 0) return getSettings(db, broadcasterId);
  await ensureSettings(db, broadcasterId);
  await db.query(`UPDATE channel_settings SET ${sets.join(", ")}, updated_at = now() WHERE broadcaster_id = $1`, values);
  return getSettings(db, broadcasterId);
}

/* ------------------------------------------------------------------------------------------ */
/* Grants (encrypted)                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface GrantRow {
  id: string;
  role: "broadcaster" | "bot";
  twitch_user_id: string;
  twitch_login: string;
  scopes: string[];
  access_token_enc: string;
  refresh_token_enc: string | null;
  key_id: string;
  access_expires_at: Date | null;
  status: "active" | "refresh_failed" | "revoked";
  last_validated_at: Date | null;
  last_error: string | null;
}

const G_COLS = `id, role, twitch_user_id, twitch_login, scopes, access_token_enc, refresh_token_enc, key_id, access_expires_at, status, last_validated_at, last_error`;

export async function upsertGrant(
  db: Queryable,
  g: {
    role: "broadcaster" | "bot";
    twitchUserId: string;
    twitchLogin: string;
    scopes: string[];
    accessTokenEnc: string;
    refreshTokenEnc: string | null;
    keyId: string;
    expiresInSec: number | null;
  },
): Promise<GrantRow> {
  const { rows } = await db.query<GrantRow>(
    `INSERT INTO encrypted_grants (role, twitch_user_id, twitch_login, scopes, access_token_enc, refresh_token_enc, key_id, access_expires_at, status, last_validated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8::int) END, 'active', now())
     ON CONFLICT (role, twitch_user_id) DO UPDATE SET twitch_login = EXCLUDED.twitch_login, scopes = EXCLUDED.scopes,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, key_id = EXCLUDED.key_id,
       access_expires_at = EXCLUDED.access_expires_at, status = 'active', last_validated_at = now(), last_error = NULL, updated_at = now()
     RETURNING ${G_COLS}`,
    [g.role, g.twitchUserId, g.twitchLogin, g.scopes, g.accessTokenEnc, g.refreshTokenEnc, g.keyId, g.expiresInSec],
  );
  return rows[0]!;
}

export async function getGrant(db: Queryable, role: "broadcaster" | "bot", twitchUserId: string): Promise<GrantRow | null> {
  const { rows } = await db.query<GrantRow>(`SELECT ${G_COLS} FROM encrypted_grants WHERE role = $1 AND twitch_user_id = $2`, [role, twitchUserId]);
  return rows[0] ?? null;
}

export async function getBotGrant(db: Queryable): Promise<GrantRow | null> {
  const { rows } = await db.query<GrantRow>(`SELECT ${G_COLS} FROM encrypted_grants WHERE role = 'bot' ORDER BY updated_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

export async function listActiveGrants(db: Queryable): Promise<GrantRow[]> {
  const { rows } = await db.query<GrantRow>(`SELECT ${G_COLS} FROM encrypted_grants WHERE status = 'active'`);
  return rows;
}

export async function updateGrantTokens(
  db: Queryable,
  id: string,
  t: { accessTokenEnc: string; refreshTokenEnc: string | null; keyId: string; expiresInSec: number | null; scopes: string[] },
) {
  await db.query(
    `UPDATE encrypted_grants SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), key_id = $4,
       access_expires_at = CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5::int) END,
       scopes = $6, status = 'active', last_refreshed_at = now(), last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, t.accessTokenEnc, t.refreshTokenEnc, t.keyId, t.expiresInSec, t.scopes],
  );
}

export async function markGrantValidated(db: Queryable, id: string, scopes: string[], expiresInSec: number) {
  await db.query(
    `UPDATE encrypted_grants SET last_validated_at = now(), scopes = $2,
       access_expires_at = now() + make_interval(secs => $3::int), updated_at = now() WHERE id = $1`,
    [id, scopes, expiresInSec],
  );
}

export async function setGrantStatus(db: Queryable, id: string, status: GrantRow["status"], error: string | null) {
  await db.query(`UPDATE encrypted_grants SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [id, status, error]);
  if (status !== "active") {
    await db.query(
      `UPDATE broadcaster_connections SET status = $2, last_error = $3 WHERE grant_id = $1`,
      [id, status === "revoked" ? "revoked" : "refresh_failed", error],
    );
  }
}

export async function deleteGrant(db: Queryable, id: string) {
  await db.query(`DELETE FROM encrypted_grants WHERE id = $1`, [id]);
}

export interface ConnectionRow {
  broadcaster_id: string;
  status: "active" | "refresh_failed" | "revoked" | "disconnected";
  grant_id: string | null;
  last_validated_at: Date | null;
  last_error: string | null;
}

export async function upsertConnection(db: Queryable, broadcasterId: string, grantId: string) {
  await db.query(
    `INSERT INTO broadcaster_connections (broadcaster_id, status, grant_id, last_validated_at) VALUES ($1, 'active', $2, now())
     ON CONFLICT (broadcaster_id) DO UPDATE SET status = 'active', grant_id = EXCLUDED.grant_id, connected_at = now(),
       disconnected_at = NULL, last_validated_at = now(), last_error = NULL`,
    [broadcasterId, grantId],
  );
}

export async function getConnection(db: Queryable, broadcasterId: string): Promise<ConnectionRow | null> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT broadcaster_id, status, grant_id, last_validated_at, last_error FROM broadcaster_connections WHERE broadcaster_id = $1`,
    [broadcasterId],
  );
  return rows[0] ?? null;
}

export async function markDisconnected(db: Queryable, broadcasterId: string) {
  await db.query(
    `UPDATE broadcaster_connections SET status = 'disconnected', disconnected_at = now(), grant_id = NULL WHERE broadcaster_id = $1`,
    [broadcasterId],
  );
  // Withdraw public listing immediately; the creator must opt in again after reconnecting.
  await db.query(`UPDATE channel_settings SET directory_opt_in = false, bot_enabled = false, agent_enabled = false WHERE broadcaster_id = $1`, [
    broadcasterId,
  ]);
}

/* ------------------------------------------------------------------------------------------ */
/* App token cache                                                                            */
/* ------------------------------------------------------------------------------------------ */

export async function getAppToken(db: Queryable, clientId: string): Promise<{ access_token_enc: string; expires_at: Date } | null> {
  const { rows } = await db.query<{ access_token_enc: string; expires_at: Date }>(
    `SELECT access_token_enc, expires_at FROM app_tokens WHERE client_id = $1 AND expires_at > now() + interval '5 minutes'`,
    [clientId],
  );
  return rows[0] ?? null;
}

export async function saveAppToken(db: Queryable, clientId: string, enc: string, keyId: string, expiresInSec: number) {
  await db.query(
    `INSERT INTO app_tokens (client_id, access_token_enc, key_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4::int))
     ON CONFLICT (client_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, key_id = EXCLUDED.key_id,
       expires_at = EXCLUDED.expires_at, created_at = now()`,
    [clientId, enc, keyId, expiresInSec],
  );
}

export async function clearAppToken(db: Queryable, clientId: string) {
  await db.query(`DELETE FROM app_tokens WHERE client_id = $1`, [clientId]);
}

