import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AnalysisStatus, DEMO_LOGIN, type AnalysisStatus as AnalysisStatusT } from "@slot1/contracts";
import {
  createOcrEngine,
  createVisionProvider,
  getProfile,
  jpegSize,
  ObservationPipeline,
  type FrameInsight,
  type FrameModel,
  type ObjectFinder,
  type PipelineSink,
} from "@slot1/analysis";
import {
  endTwitchBroadcastSessions,
  ensurePreviewSource,
  getBroadcasterByLogin,
  getBroadcasterByTwitchId,
  getSettings,
  kickLogin,
  setAnalysisState,
  updateSettings,
  upsertKickBroadcaster,
  upsertKickUser,
  upsertTwitchBroadcastSession,
  upsertTwitchBroadcaster,
  upsertTwitchUser,
  type BroadcasterRow,
  type StreamSessionRow,
} from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import { sizeThumbnail } from "@slot1/twitch";
import type { AiViewContext } from "./ai-view";
import type { ServerContext } from "./context";
import { kickChannels, kickConfigured, type KickChannel } from "./kick";
import { LEARNING_PAUSED_KEY, readLearningSwitch } from "./learning-switch";
import { ADDED_WATCH_STATUS_KEY, featuredLogin, getPreviewLogins } from "./preview-list";
import { createPipelineSink } from "./pipeline-sink";
import { withAppToken } from "./twitch";

const LOCK_KEY = "slot1:lock:added-watch";
/**
 * How often each added live stream's preview picture is fetched and shown to Claude. Every check
 * goes to the AI, even when Twitch (every 5 minutes) or Kick (about every 90 s) hasn't published a
 * new picture yet: SLOT1 keeps reading each live stream continuously. That is a deliberate choice.
 */
const SAMPLE_MS = 5_000;
const STATUS_TTL_SEC = 180;
/** OCR readings left out of featured channels' logs: whole-frame text that isn't a subtitle, objective, title or place. */
const PREVIEW_OCR_KEEP_OUT: ReadonlySet<string> = new Set(["visible_text"]);

/** The last picture of one featured entry that went into the training pool (a SHA-1 of its bytes). */
export const ADDED_WATCH_TRAINED_KEY = (entry: string) => `slot1:added-watch:trained:${entry}`;

/**
 * The AI looks at a featured stream's picture on every check, but the picture itself only changes
 * every 1 to 5 minutes. Each distinct picture goes into the training pool once, not once per look.
 */
export function trainOncePerPicture(
  redis: Pick<ServerContext["redis"], "get" | "set">,
  entry: string,
  jpeg: Buffer,
  trainingFrame: NonNullable<PipelineSink["trainingFrame"]>,
): NonNullable<PipelineSink["trainingFrame"]> {
  const digest = createHash("sha1").update(jpeg).digest("hex");
  return async (input) => {
    if ((await redis.get(ADDED_WATCH_TRAINED_KEY(entry))) === digest) return;
    await trainingFrame(input);
    await redis.set(ADDED_WATCH_TRAINED_KEY(entry), digest, "EX", 6 * 3600);
  };
}

export interface AddedWatchOptions {
  gtaModel: FrameModel | null;
  /** The object finder, run on every picture SLOT1 looks at. */
  objects?: ObjectFinder | null;
  toJpeg?: (buf: Buffer, contentType: string) => Promise<Buffer | null>;
  /** "What the AI sees" and the AI overlay: called once per analyzed picture (the worker stores it while someone watches). */
  insight?: (c: AiViewContext, i: FrameInsight) => Promise<void>;
}

export interface AddedWatchResult {
  watched: number;
  learned: number;
  unchanged: number;
  vision: boolean;
}

/**
 * Why the describing model did or didn't run. Watching and keeping the picture does not need
 * the Admin → AI key; describing the picture does.
 */
export function addedWatchReason(visionOn: boolean, visionReason: string | null): string {
  if (visionOn) return "Watching this stream and learning from it.";
  const why = visionReason ?? "AI not configured: set VISION_PROVIDER and the provider's API key and vision model";
  return `Watching this stream and learning from its picture. The describing model is off (${why}). Turn it on under Admin → AI.`;
}

/**
 * Featured channels (Admin → Featured channels) are not sent into SLOT1. While one is live,
 * download the public preview picture Twitch or Kick already publishes, run the same analysis
 * pipeline on it, and keep it for learning. Offline ends only that stream. A creator who is
 * already sending their own video is left to that reader.
 */
export async function watchAddedStreams(
  ctx: ServerContext,
  opts: AddedWatchOptions = { gtaModel: null },
): Promise<AddedWatchResult> {
  const idle = { watched: 0, learned: 0, unchanged: 0, vision: ctx.config.capabilities.vision.available };
  const locked = await ctx.redis.set(LOCK_KEY, "1", "EX", 90, "NX");
  if (locked !== "OK") return idle;
  try {
    // Admin → Learning is off: look at nothing, and close what was open when it went off.
    if (!(await readLearningSwitch(ctx.redis)).on) {
      await pauseWatching(ctx);
      return idle;
    }
    return await runWatch(ctx, opts);
  } finally {
    await ctx.redis.del(LOCK_KEY).catch(() => undefined);
  }
}

/**
 * Once after learning goes off: every featured stream SLOT1 was watching stops showing as watched,
 * and its open session ends (the database alone, no Twitch or Kick calls). A creator who connected
 * SLOT1 keeps their session: their own stream's events end it.
 */
async function pauseWatching(ctx: ServerContext): Promise<void> {
  if (await ctx.redis.get(LEARNING_PAUSED_KEY)) return;
  let ended = 0;
  for (const entry of await getPreviewLogins(ctx)) {
    await ctx.redis.del(ADDED_WATCH_STATUS_KEY(featuredLogin(entry))).catch(() => undefined);
    const broadcaster = await getBroadcasterByLogin(ctx.db, entry.startsWith("kick:") ? kickLogin(entry.slice(5)) : entry);
    if (broadcaster && (await creatorConnected(ctx, broadcaster.id))) {
      await ctx.redis.del(ADDED_WATCH_STATUS_KEY(entry)).catch(() => undefined);
      continue;
    }
    const open = broadcaster ? await endTwitchBroadcastSessions(ctx.db, broadcaster.id) : [];
    await ctx.redis.del(ADDED_WATCH_STATUS_KEY(entry)).catch(() => undefined);
    ended += open.length;
  }
  await ctx.redis.set(LEARNING_PAUSED_KEY, new Date().toISOString());
  ctx.log.info({ ended }, "learning is off: featured channels are no longer watched");
}

async function runWatch(
  ctx: ServerContext,
  opts: AddedWatchOptions,
): Promise<AddedWatchResult> {
  const entries = await getPreviewLogins(ctx);
  const result: AddedWatchResult = { watched: 0, learned: 0, unchanged: 0, vision: ctx.config.capabilities.vision.available };
  if (entries.length === 0) return result;

  const twitchLogins = entries.filter((e) => !e.startsWith("kick:"));
  const kickSlugs = entries.filter((e) => e.startsWith("kick:")).map((e) => e.slice(5));
  const vision = createVisionProvider(ctx.config.env);
  const ocr = createOcrEngine(ctx.config.capabilities.ocr.available, ctx.config.env, ctx.tools);
  const reason = addedWatchReason(Boolean(vision), ctx.config.capabilities.vision.reason);
  const work = await mkdtemp(path.join(tmpdir(), "slot1-added-"));

  try {
    if (twitchLogins.length > 0) {
      if (!ctx.helix) {
        ctx.log.warn("Twitch app is not configured, so added Twitch streams cannot be watched");
      } else {
        const helix = ctx.helix;
        let users: Awaited<ReturnType<typeof helix.getUsers>> = [];
        let streams: Awaited<ReturnType<typeof helix.getStreams>> = [];
        try {
          const fetched = await withAppToken(ctx, async (token) => {
            const [u, s] = await Promise.all([
              helix.getUsers(token, { logins: twitchLogins }),
              helix.getStreams(token, { userLogins: twitchLogins }),
            ]);
            return [u, s] as const;
          });
          users = fetched[0];
          streams = fetched[1];
        } catch (err) {
          ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "added Twitch streams could not be listed");
          users = [];
          streams = [];
        }
        await Promise.all(twitchLogins.map(async (login) => {
          const user = users.find((u) => u.login.toLowerCase() === login);
          if (!user) return;
          const stream = streams.find((s) => s.user_login.toLowerCase() === login && s.type === "live");
          try {
            if (!stream) {
              await stopWatching(ctx, await getBroadcasterByTwitchId(ctx.db, user.id), login);
              return;
            }
            const broadcaster = await ensureTwitch(ctx, user);
            if (!broadcaster || (await creatorIsSending(ctx, broadcaster.id))) return;
            const jpeg = await fetchJpeg(sizeThumbnail(stream.thumbnail_url, 1280, 720), opts.toJpeg);
            if (!jpeg) return;
            const learned = await learnFrame(ctx, {
              entry: login,
              broadcaster,
              streamId: stream.id,
              startedAt: stream.started_at,
              title: stream.title,
              category: stream.game_name || null,
              jpeg,
              work,
              vision,
              ocr,
              gtaModel: opts.gtaModel,
              objects: opts.objects ?? null,
              insight: opts.insight,
              reason,
            });
            if (learned === "skipped") return;
            result.watched += 1;
            if (learned === "learned") result.learned += 1;
            else result.unchanged += 1;
          } catch (err) {
            ctx.log.warn({ login, err: sanitizeErrorMessage((err as Error).message) }, "added stream watch failed");
          }
        }));
      }
    }

    if (kickSlugs.length > 0 && kickConfigured(ctx)) {
      const data = await kickChannels(ctx, kickSlugs);
      await Promise.all(kickSlugs.map(async (slug) => {
        const channel = data.get(slug);
        if (!channel) return;
        const entry = `kick:${slug}`;
        try {
          if (!channel.live) {
            await stopWatching(ctx, await getBroadcasterByLogin(ctx.db, kickLogin(slug)), entry);
            return;
          }
          const broadcaster = await ensureKick(ctx, channel);
          if (!broadcaster || (await creatorIsSending(ctx, broadcaster.id))) return;
          if (!channel.thumbnailUrl) return;
          const jpeg = await fetchJpeg(channel.thumbnailUrl, opts.toJpeg);
          if (!jpeg) return;
          const learned = await learnFrame(ctx, {
            entry,
            broadcaster,
            streamId: `kick:${slug}:${channel.startedAt ?? "live"}`,
            startedAt: channel.startedAt ?? new Date().toISOString(),
            title: channel.title,
            category: channel.category,
            jpeg,
            work,
            vision,
            ocr,
            gtaModel: opts.gtaModel,
            objects: opts.objects ?? null,
            insight: opts.insight,
            reason,
          });
          if (learned === "skipped") return;
          result.watched += 1;
          if (learned === "learned") result.learned += 1;
          else result.unchanged += 1;
        } catch (err) {
          ctx.log.warn({ slug, err: sanitizeErrorMessage((err as Error).message) }, "added Kick stream watch failed");
        }
      }));
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }

  if (result.watched > 0) {
    ctx.log.info(
      { watched: result.watched, learned: result.learned, unchanged: result.unchanged, vision: result.vision, visionReason: ctx.config.capabilities.vision.reason },
      "added streams watched",
    );
  }
  return result;
}

async function ensureTwitch(
  ctx: ServerContext,
  user: { id: string; login: string; display_name: string; profile_image_url: string },
): Promise<BroadcasterRow | null> {
  const existing = await getBroadcasterByTwitchId(ctx.db, user.id);
  if (existing) return existing.kind === "local" && existing.login === DEMO_LOGIN ? null : existing;
  const { rows } = await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE twitch_user_id = $1`, [user.id]);
  const ownerId = rows[0]?.id ?? (await upsertTwitchUser(ctx.db, user.id, user.display_name, false)).id;
  return upsertTwitchBroadcaster(ctx.db, {
    ownerUserId: ownerId,
    twitchUserId: user.id,
    login: user.login,
    displayName: user.display_name,
    avatarUrl: user.profile_image_url || null,
  });
}

async function ensureKick(ctx: ServerContext, channel: KickChannel): Promise<BroadcasterRow | null> {
  const login = kickLogin(channel.slug);
  const existing = await getBroadcasterByLogin(ctx.db, login);
  if (existing) return existing;
  if (channel.userId === null || channel.userId === undefined) return null;
  const kickUserId = String(channel.userId);
  const owner = await upsertKickUser(ctx.db, kickUserId, channel.displayName ?? channel.slug);
  return upsertKickBroadcaster(ctx.db, {
    ownerUserId: owner.id,
    kickUserId,
    slug: channel.slug,
    displayName: channel.displayName ?? channel.slug,
    avatarUrl: channel.avatarUrl,
  });
}

/** True when this creator is already sending video into SLOT1. That reader is the one that learns. */
async function creatorIsSending(ctx: ServerContext, broadcasterId: string): Promise<boolean> {
  const { rows } = await ctx.db.query(
    `SELECT 1 FROM media_sources WHERE broadcaster_id = $1 AND kind = 'live_ingest' AND status = 'publishing' AND revoked_at IS NULL LIMIT 1`,
    [broadcasterId],
  );
  return rows.length > 0;
}

async function stopWatching(ctx: ServerContext, broadcaster: BroadcasterRow | null, entry: string): Promise<void> {
  await ctx.redis.del(ADDED_WATCH_STATUS_KEY(entry)).catch(() => undefined);
  if (!broadcaster) return;
  const open = await endTwitchBroadcastSessions(ctx.db, broadcaster.id);
  if (open.length === 0) return;
  ctx.log.info({ login: broadcaster.login }, "added stream went offline");
}

async function learnFrame(
  ctx: ServerContext,
  input: {
    entry: string;
    broadcaster: BroadcasterRow;
    streamId: string;
    startedAt: string;
    title: string | null;
    category: string | null;
    jpeg: Buffer;
    work: string;
    vision: ReturnType<typeof createVisionProvider>;
    ocr: ReturnType<typeof createOcrEngine>;
    gtaModel: FrameModel | null;
    objects: ObjectFinder | null;
    insight?: AddedWatchOptions["insight"];
    reason: string;
  },
): Promise<"learned" | "unchanged" | "skipped"> {
  const connected = await creatorConnected(ctx, input.broadcaster.id);
  if (!connected) {
    await updateSettings(ctx.db, input.broadcaster.id, {
      agentEnabled: true,
      trainingConsent: true,
      analysisPaused: false,
      visibility: "public",
      publicAnalysis: true,
    });
  }
  let settings = await getSettings(ctx.db, input.broadcaster.id);
  const session = await openSession(ctx, input.broadcaster, input, settings.visibility, connected, settings);
  settings = await getSettings(ctx.db, input.broadcaster.id);
  if (settings.analysisPaused || !settings.agentEnabled) return "skipped";

  const size = jpegSize(input.jpeg);
  const now = new Date();
  const source = await ensurePreviewSource(ctx.db, input.broadcaster.id, session.id);
  const base = createPipelineSink(ctx, {
    session,
    source,
    settings,
    retentionDays: settings.retentionDays,
  });
  const sink: PipelineSink = base.trainingFrame ? { ...base, trainingFrame: trainOncePerPicture(ctx.redis, input.entry, input.jpeg, base.trainingFrame) } : base;
  const pipeline = new ObservationPipeline({
    ocr: input.ocr,
    ocrVersion: "5",
    // Loose words from menus, overlays and chat boxes: the vision model describes these better.
    ocrKeepOut: PREVIEW_OCR_KEEP_OUT,
    vision: input.vision,
    gtaModel: input.gtaModel,
    objects: input.objects,
    profile: getProfile(settings.gameProfile),
    sourceLabel: "clip",
    visionBatchSize: 1,
    coverageMsPerFrame: SAMPLE_MS,
    workDir: path.join(input.work, input.broadcaster.id),
    sink,
    // The picture SLOT1 just looked at, for "What the AI sees" and the AI overlay.
    insight: input.insight
      ? (i) => input.insight!({ sessionId: session.id, label: "live", demo: false, intervalMs: SAMPLE_MS, measuredCadenceMs: null }, i)
      : undefined,
  });
  await pipeline.handleFrame({
    ptsMs: Date.now(),
    receivedAt: now,
    capturedAt: now,
    jpeg: input.jpeg,
    width: size?.width ?? null,
    height: size?.height ?? null,
    reason: "live",
  });
  await setAnalysisState(ctx.db, session.id, "live_vision", input.reason);
  await ctx.db.query(`UPDATE stream_sessions SET expected_interval_ms = $2 WHERE id = $1`, [session.id, SAMPLE_MS]);
  await publishStatus(ctx, input.entry, session, input.reason, pipeline.stats.observations > 0);
  return "learned";
}

async function creatorConnected(ctx: ServerContext, broadcasterId: string): Promise<boolean> {
  const { rows } = await ctx.db.query(
    `SELECT 1 FROM broadcaster_connections WHERE broadcaster_id = $1 AND status = 'active' LIMIT 1`,
    [broadcasterId],
  );
  return rows.length > 0;
}

async function openSession(
  ctx: ServerContext,
  broadcaster: BroadcasterRow,
  input: { streamId: string; startedAt: string; title: string | null; category: string | null },
  visibility: "public" | "private",
  connected: boolean,
  settings: { agentEnabled: boolean; trainingConsent: boolean },
): Promise<StreamSessionRow> {
  const demo = broadcaster.kind === "local" && broadcaster.login === DEMO_LOGIN;
  if (!demo && connected && (!settings.agentEnabled || !settings.trainingConsent)) {
    await updateSettings(ctx.db, broadcaster.id, { agentEnabled: true, trainingConsent: true });
  }
  const { rows: open } = await ctx.db.query<{ twitch_stream_id: string | null }>(
    `SELECT twitch_stream_id FROM stream_sessions
     WHERE broadcaster_id = $1 AND kind = 'twitch_broadcast' AND ended_at IS NULL AND delete_requested_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [broadcaster.id],
  );
  if (open[0] && open[0].twitch_stream_id !== input.streamId) await endTwitchBroadcastSessions(ctx.db, broadcaster.id);
  const session = await upsertTwitchBroadcastSession(ctx.db, {
    broadcasterId: broadcaster.id,
    twitchStreamId: input.streamId,
    startedAt: input.startedAt,
    title: input.title,
    category: input.category,
    visibility: connected ? visibility : "public",
  });
  if (!connected && session.visibility !== "public") {
    await ctx.db.query(`UPDATE stream_sessions SET visibility = 'public' WHERE id = $1`, [session.id]);
    session.visibility = "public";
  }
  return session;
}

async function publishStatus(ctx: ServerContext, entry: string, session: StreamSessionRow, reason: string, hadResult: boolean): Promise<void> {
  const fresh = await ctx.db.query<{ last_received_frame_at: Date | null; last_analyzed_frame_at: Date | null; last_result_at: Date | null }>(
    `SELECT last_received_frame_at, last_analyzed_frame_at, last_result_at FROM stream_sessions WHERE id = $1`,
    [session.id],
  );
  const row = fresh.rows[0];
  const status: AnalysisStatusT = {
    state: "live_vision",
    reason,
    sourceLabel: "clip",
    lastReceivedFrameAt: row?.last_received_frame_at?.toISOString() ?? new Date().toISOString(),
    lastAnalyzedFrameAt: row?.last_analyzed_frame_at?.toISOString() ?? null,
    lastResultAt: hadResult ? new Date().toISOString() : (row?.last_result_at?.toISOString() ?? null),
    measuredCadenceMs: SAMPLE_MS,
    measuredDelayMs: null,
    staleAfterMs: SAMPLE_MS * 3,
    visionConfigured: ctx.config.capabilities.vision.available,
  };
  AnalysisStatus.parse(status);
  await ctx.redis.set(ADDED_WATCH_STATUS_KEY(entry), JSON.stringify(status), "EX", STATUS_TTL_SEC);
  await ctx.redis.set(ADDED_WATCH_STATUS_KEY(featuredLogin(entry)), JSON.stringify(status), "EX", STATUS_TTL_SEC);
}

async function fetchJpeg(url: string, toJpeg?: (buf: Buffer, contentType: string) => Promise<Buffer | null>): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000), redirect: "follow" });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.length > 8_000_000) return null;
  const type = res.headers.get("content-type") ?? "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return buf;
  return toJpeg ? toJpeg(buf, type) : null;
}
