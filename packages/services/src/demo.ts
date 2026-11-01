import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFrameAt } from "@slot1/analysis";
import { bigMoment, DEMO_LOGIN, DEMO_PUBLISH_PATH, type ChannelSettings, type DemoInfo, type Observation } from "@slot1/contracts";

export { DEMO_LOGIN, DEMO_PUBLISH_PATH, DEMO_STREAM_NAME } from "@slot1/contracts";
import {
  createIngestSource,
  createLocalBroadcaster,
  createLocalUser,
  getCurrentLiveSession,
  getSourceByPublishPath,
  insertAsset,
  listLibraryItems,
  updateSettings,
  withTx,
  type BroadcasterRow,
  type Queryable,
  type StreamSessionRow,
} from "@slot1/db";
import { QUEUES, sanitizeErrorMessage, sha256, storageKeys, type AppConfig } from "@slot1/platform";
import type { ServerContext } from "./context";
import { bufferReplay, type BufferReplayRequest } from "./instant-replay";

/**
 * The demo broadcast: one public channel fed by SLOT1's own synthetic test video (the worker's
 * dist/demo-broadcast.js), analyzed by the real pipeline. Off unless SLOT1_DEMO=true. Every place
 * it appears says it's a demo with a synthetic test video: its source is a TEST source, its
 * display name and session title say "Demo", and the video carries a watermark.
 */

export const DEMO_DISPLAY_NAME = "SLOT1 Demo";
export const DEMO_SOURCE_NAME = "Demo generator (synthetic test video)";
export const DEMO_SESSION_TITLE = "Demo stream: synthetic test video, not gameplay";

/** Bounds that let the demo run for weeks without growing. */
export const DEMO_LIMITS = {
  /** A demo session is closed and a new one started after this long. */
  sessionMaxMs: 60 * 60_000,
  /** Closed demo sessions (frames, observations, buffers) are deleted after this long. */
  keepEndedMs: 2 * 60 * 60_000,
  /** Evidence frames of the demo expire after 2 hours (fraction of a day). */
  frameRetentionDays: 2 / 24,
  /** Demo clips kept in its library (newest first). */
  maxClips: 20,
  /** At most one demo clip per this long. */
  clipEveryMs: 10 * 60_000,
  /** Paid vision calls per hour when SLOT1_DEMO_VISION=true. */
  visionCallsPerHour: 12,
  rollingBufferSeconds: 90,
} as const;

export function demoConfigured(config: Pick<AppConfig, "env">): { enabled: boolean; reason: string | null } {
  // Simply switched off: nothing to explain beyond `enabled: false`.
  if (!config.env.SLOT1_DEMO) return { enabled: false, reason: null };
  if (!config.env.SLOT1_DEMO_STREAM_KEY || config.env.SLOT1_DEMO_STREAM_KEY.length < 16) {
    return { enabled: false, reason: "The demo broadcast is switched on but has no stream key (SLOT1_DEMO_STREAM_KEY, 16+ characters)." };
  }
  return { enabled: true, reason: null };
}

export function isDemoBroadcaster(b: Pick<BroadcasterRow, "kind" | "login"> | null | undefined): boolean {
  return Boolean(b && b.kind === "local" && b.login === DEMO_LOGIN);
}

/** True when this broadcaster is the demo channel and the demo is switched off (hide it). */
export function hiddenDemo(config: Pick<AppConfig, "env">, b: Pick<BroadcasterRow, "kind" | "login"> | null | undefined): boolean {
  return isDemoBroadcaster(b) && !demoConfigured(config).enabled;
}

export async function findDemoBroadcaster(db: Queryable): Promise<BroadcasterRow | null> {
  const { rows } = await db.query<BroadcasterRow>(
    `SELECT id, owner_user_id, kind, twitch_user_id, login, display_name, avatar_url FROM broadcasters
      WHERE kind = 'local' AND login = $1 ORDER BY created_at ASC LIMIT 1`,
    [DEMO_LOGIN],
  );
  return rows[0] ?? null;
}

/** Channel settings for the demo: public, analyzed, bounded, never trained on, no paid AI by default. */
export function demoSettings(config: Pick<AppConfig, "env">): Partial<ChannelSettings> & { agentEnabled: boolean } {
  const vision = config.env.SLOT1_DEMO_VISION;
  return {
    visibility: "public",
    directoryOptIn: false,
    publicAnalysis: true,
    // Questions use the paid text model when one is configured: only with the demo's AI opt-in.
    viewerQuestions: vision ? "anyone" : "off",
    botEnabled: false,
    commentaryMode: "off",
    agentEnabled: true,
    analysisPaused: false,
    // Consent for the rolling buffer only (instant replays and demo clips); no full recording.
    recordingConsent: true,
    rollingBufferEnabled: true,
    rollingBufferSeconds: DEMO_LIMITS.rollingBufferSeconds,
    recordingEnabled: false,
    retentionDays: 1,
    sampleIntervalMs: Math.min(60_000, Math.max(1000, config.env.SLOT1_DEMO_SAMPLE_MS)),
    maxVisionCallsPerHour: vision ? DEMO_LIMITS.visionCallsPerHour : 0,
    gameProfile: "gta5",
    // Synthetic frames must never reach the GTA training pool.
    trainingConsent: false,
    autoClips: false,
    chatAnnouncements: false,
  };
}

/**
 * Create or update the demo channel when the demo is on; hide it, revoke its key and remove its
 * data when it's off. Safe to run on every API start and from several API processes at once.
 */
export async function reconcileDemo(ctx: ServerContext): Promise<{ state: "enabled" | "disabled" | "absent"; broadcasterId: string | null }> {
  const { enabled } = demoConfigured(ctx.config);
  const result = await withTx(ctx.db, async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('slot1-demo-reconcile'))`);
    let b = await findDemoBroadcaster(tx);
    if (!enabled) {
      if (!b) return { state: "absent" as const, broadcasterId: null };
      await tx.query(
        `UPDATE media_sources SET status = 'revoked', revoked_at = now(), publish_key_hash = NULL, updated_at = now()
          WHERE broadcaster_id = $1 AND kind = 'live_ingest' AND revoked_at IS NULL`,
        [b.id],
      );
      await updateSettings(tx, b.id, { visibility: "private", publicAnalysis: false, agentEnabled: false });
      await tx.query(`UPDATE stream_sessions SET ended_at = COALESCE(ended_at, now()) WHERE broadcaster_id = $1`, [b.id]);
      return { state: "disabled" as const, broadcasterId: b.id };
    }
    if (!b) {
      const owner = await createLocalUser(tx, DEMO_DISPLAY_NAME);
      b = await createLocalBroadcaster(tx, owner.id, DEMO_LOGIN, DEMO_DISPLAY_NAME);
    }
    await updateSettings(tx, b.id, demoSettings(ctx.config));
    const key = ctx.config.env.SLOT1_DEMO_STREAM_KEY!;
    const existing = await getSourceByPublishPath(tx, DEMO_PUBLISH_PATH);
    if (existing && existing.broadcaster_id !== b.id) throw new Error(`The demo stream path ${DEMO_PUBLISH_PATH} belongs to another channel`);
    if (existing) {
      await tx.query(
        `UPDATE media_sources SET publish_key_hash = $2, publish_key_hint = $3, label = 'test', name = $4, revoked_at = NULL,
           status = CASE WHEN status IN ('revoked', 'deleted') THEN 'awaiting_publisher' ELSE status END, updated_at = now()
         WHERE id = $1`,
        [existing.id, sha256(key), key.slice(-4), DEMO_SOURCE_NAME],
      );
    } else {
      await createIngestSource(tx, { broadcasterId: b.id, name: DEMO_SOURCE_NAME, label: "test", publishPath: DEMO_PUBLISH_PATH, keyHash: sha256(key), keyHint: key.slice(-4) });
    }
    return { state: "enabled" as const, broadcasterId: b.id };
  });
  // Switched off: the demo's sessions and clips go (outside the transaction; files are involved).
  if (result.state === "disabled" && result.broadcasterId) await removeDemoData(ctx, result.broadcasterId);
  return result;
}

async function purgeDemoItem(ctx: ServerContext, broadcasterId: string, itemId: string) {
  const prefix = storageKeys.libraryPrefix(broadcasterId, itemId);
  await ctx.storage.deletePrefix(prefix).catch(() => 0);
  await ctx.db.query(`UPDATE evidence_assets SET deleted_at = now() WHERE storage_key LIKE $1`, [`${prefix}/%`]);
  await ctx.db.query(`DELETE FROM library_items WHERE id = $1 AND broadcaster_id = $2`, [itemId, broadcasterId]);
}

/** Everything the demo produced: sessions (deleted by the worker's delete-session job) and clips. */
export async function removeDemoData(ctx: ServerContext, broadcasterId: string): Promise<{ sessions: number; clips: number }> {
  const { rows } = await ctx.db.query<{ id: string }>(`SELECT id FROM stream_sessions WHERE broadcaster_id = $1`, [broadcasterId]);
  for (const r of rows) {
    await ctx.db.query(`UPDATE stream_sessions SET delete_requested_at = COALESCE(delete_requested_at, now()) WHERE id = $1`, [r.id]);
    await ctx.enqueue(QUEUES.maintenance, "delete-session", { sessionId: r.id, broadcasterId }, { jobId: `delete-${r.id}` });
  }
  const items = await listLibraryItems(ctx.db, broadcasterId, { limit: 10_000 });
  for (const i of items) await purgeDemoItem(ctx, broadcasterId, i.id);
  return { sessions: rows.length, clips: items.length };
}

/**
 * Keep the demo bounded: closed demo sessions older than DEMO_LIMITS.keepEndedMs are deleted and
 * only the newest DEMO_LIMITS.maxClips clips are kept. Run by the worker reading the demo.
 */
export async function demoHousekeeping(ctx: ServerContext, broadcasterId: string): Promise<{ sessions: number; clips: number }> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM stream_sessions WHERE broadcaster_id = $1 AND ended_at IS NOT NULL AND delete_requested_at IS NULL
        AND ended_at < now() - make_interval(secs => $2)`,
    [broadcasterId, DEMO_LIMITS.keepEndedMs / 1000],
  );
  for (const r of rows) {
    await ctx.db.query(`UPDATE stream_sessions SET delete_requested_at = now() WHERE id = $1`, [r.id]);
    await ctx.enqueue(QUEUES.maintenance, "delete-session", { sessionId: r.id, broadcasterId }, { jobId: `delete-${r.id}` });
  }
  const items = await listLibraryItems(ctx.db, broadcasterId, { limit: 10_000 });
  const extra = [...items].sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(DEMO_LIMITS.maxClips);
  for (const i of extra) await purgeDemoItem(ctx, broadcasterId, i.id);
  return { sessions: rows.length, clips: extra.length };
}

/**
 * Demo clips: the demo never records the whole stream, so its clips are cut from the rolling
 * buffer around a result screen (MISSION PASSED, WASTED, BUSTED) and kept as library items.
 * Throttled to one per DEMO_LIMITS.clipEveryMs; returns the new item id, or null.
 */
export async function demoClipFromBuffer(
  ctx: ServerContext,
  input: { session: StreamSessionRow; sourceId: string; readerStartedAtMs: number; ringSize: number; observation: Observation },
): Promise<string | null> {
  const o = input.observation;
  const big = bigMoment(o);
  if (!big || o.mediaStartMs === null) return null;
  const gate = await ctx.redis.set(`slot1:demo:clip:${input.session.broadcaster_id}`, o.id, "PX", DEMO_LIMITS.clipEveryMs, "NX");
  if (gate !== "OK") return null;
  const req: BufferReplayRequest = {
    id: randomUUID(),
    sessionId: input.session.id,
    broadcasterId: input.session.broadcaster_id,
    receivedAtMs: Date.parse(o.receivedAt),
    mediaMs: o.mediaStartMs,
    secondsAgo: null,
    preMs: 6000,
    postMs: 4000,
  };
  // The post-roll has to be in the buffer first: try for up to a minute.
  let reply = await bufferReplay(ctx, input.sourceId, input.readerStartedAtMs, DEMO_LIMITS.rollingBufferSeconds, input.ringSize, req);
  for (let i = 0; i < 12 && reply.status === "pending"; i++) {
    await new Promise((r) => setTimeout(r, Math.min(8000, Math.max(2000, reply.status === "pending" ? reply.retryAfterMs : 4000))));
    reply = await bufferReplay(ctx, input.sourceId, input.readerStartedAtMs, DEMO_LIMITS.rollingBufferSeconds, input.ringSize, req);
  }
  if (reply.status !== "ready") {
    await ctx.redis.del(`slot1:demo:clip:${input.session.broadcaster_id}`);
    return null;
  }
  const b = input.session.broadcaster_id;
  const itemId = randomUUID();
  const work = await mkdtemp(path.join(tmpdir(), "slot1-democlip-"));
  try {
    const mp4 = path.join(work, "clip.mp4");
    await ctx.storage.downloadToFile(reply.key, mp4);
    const poster = path.join(work, "poster.jpg");
    await extractFrameAt(ctx.tools, mp4, "mov", Math.max(0, reply.momentOffsetMs ?? 0), poster, 1280).catch(() => undefined);
    const vKey = storageKeys.library(b, itemId, "clip.mp4");
    const up = await ctx.storage.putFile(vKey, mp4, "video/mp4");
    const asset = await insertAsset(ctx.db, { broadcasterId: b, sessionId: null, sourceId: null, kind: "clip", storageKey: vKey, contentType: "video/mp4", bytes: up.bytes, durationMs: reply.durationMs });
    let posterId: string | null = null;
    if (await stat(poster).then((s) => s.size > 0).catch(() => false)) {
      const pKey = storageKeys.library(b, itemId, "poster.jpg");
      const pu = await ctx.storage.putFile(pKey, poster, "image/jpeg");
      posterId = (await insertAsset(ctx.db, { broadcasterId: b, sessionId: null, sourceId: null, kind: "thumbnail", storageKey: pKey, contentType: "image/jpeg", bytes: pu.bytes })).id;
    }
    await ctx.db.query(`INSERT INTO library_items (id, broadcaster_id, kind, title, status, visibility, session_id, asset_id, poster_asset_id, media_ms, duration_ms, bytes)
       VALUES ($1, $2, 'render', $3, 'ready', 'public', $4, $5, $6, $7, $8, $9)`, [
      itemId,
      b,
      `Demo clip: ${big.text}`,
      input.session.id,
      asset.id,
      posterId,
      o.mediaStartMs,
      reply.durationMs,
      up.bytes,
    ]);
    await demoHousekeeping(ctx, b);
    return itemId;
  } catch (err) {
    ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "demo clip failed");
    await purgeDemoItem(ctx, b, itemId).catch(() => undefined);
    return null;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** GET /api/demo. */
export async function demoInfo(ctx: ServerContext): Promise<DemoInfo> {
  const cfg = demoConfigured(ctx.config);
  const caps = ctx.config.capabilities;
  const base: DemoInfo = {
    enabled: cfg.enabled,
    reason: cfg.reason,
    login: null,
    displayName: null,
    watchPath: null,
    profilePath: null,
    sessionId: null,
    onAir: false,
    gateway: caps.ingest.gateway ?? null,
    liveVideo: caps.liveVideo.available,
    ocr: caps.ocr.available,
    vision: ctx.config.env.SLOT1_DEMO_VISION && caps.vision.available,
    sampleIntervalMs: demoSettings(ctx.config).sampleIntervalMs ?? 3000,
  };
  if (!cfg.enabled) return base;
  if (!caps.ingest.available) base.reason = caps.ingest.reason;
  const b = await findDemoBroadcaster(ctx.db);
  if (!b) return { ...base, reason: base.reason ?? "The demo channel is being set up. Reload in a moment." };
  const src = await getSourceByPublishPath(ctx.db, DEMO_PUBLISH_PATH);
  const onAir = Boolean(src && src.status === "publishing" && !src.revoked_at);
  const session = await getCurrentLiveSession(ctx.db, b.id);
  const live = session && !session.ended_at ? session : null;
  return {
    ...base,
    login: b.login,
    displayName: b.display_name,
    watchPath: `/watch/${b.login}`,
    profilePath: `/c/${b.login}`,
    sessionId: live?.id ?? null,
    onAir,
    reason: base.reason ?? (onAir ? null : "The demo generator isn't sending right now. On the server, check it with: slot1 logs demo"),
  };
}
