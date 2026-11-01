import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Redis } from "ioredis";
import { runChecked, type MediaTools } from "@slot1/analysis";
import type { InstantReplayRequest, InstantReplayResponse, InstantReplaySource, InstantReplayStatus } from "@slot1/contracts";
import {
  getAsset,
  getObservation,
  getRecordingBySession,
  getSettings,
  getSource,
  listSources,
  type RecordingRow,
  type RecordingRun,
  type StreamSessionRow,
} from "@slot1/db";
import { createRedis, sanitizeErrorMessage, storageKeys, type StorageDriver } from "@slot1/platform";
import type { ServerContext } from "./context";

/**
 * Instant replay: a short, exact window around a live moment, cut from media SLOT1 really holds
 * (the creator's recording segments in storage, or the rolling buffer on the worker reading the
 * stream). The result is ephemeral: cached briefly, never added to the library, swept after its
 * link expires.
 */

/** How long a replay file and its link live. */
export const INSTANT_REPLAY_TTL_SEC = 15 * 60;
const CACHE_PREFIX = "slot1:ireplay:win:";
const SWEEP_SET = "slot1:ireplay:keys";
export const replayRequestChannel = (sourceId: string) => `slot1:ireplay:req:${sourceId}`;
const RESPONSE_PREFIX = "slot1:ireplay:res:";

type Ready = Extract<InstantReplayResponse, { status: "ready" }>;
/** A stored cut before its link is signed (the API signs; workers never hand out URLs). */
export type StoredReplay = Omit<Ready, "url" | "expiresAt"> & { key: string };
export type BufferReplayReply = StoredReplay | Exclude<InstantReplayResponse, { status: "ready" }>;

export interface BufferReplayRequest {
  id: string;
  sessionId: string;
  broadcasterId: string;
  receivedAtMs: number;
  mediaMs: number | null;
  secondsAgo: number | null;
  preMs: number;
  postMs: number;
}

export type InstantReplayAvailability = InstantReplayStatus & { liveSourceId: string | null };

const unavailable = (reason: string): InstantReplayAvailability => ({ available: false, reason, source: null, bufferSeconds: null, liveSourceId: null });

/** Whether instant replay can work in this session, and from which media. */
export async function instantReplayStatus(ctx: Pick<ServerContext, "db">, session: StreamSessionRow): Promise<InstantReplayAvailability> {
  if (session.kind === "replay") return unavailable("This is an uploaded replay: jump straight to any moment instead");
  if (session.ended_at) return unavailable("This stream has ended. Its moments play from the recording instead.");
  const sources = await listSources(ctx.db, session.broadcaster_id);
  const live = sources.find((s) => s.kind === "live_ingest" && s.session_id === session.id && !s.revoked_at);
  if (!live) return unavailable("Instant replay needs the creator to send their video to SLOT1. This stream only reaches Twitch.");
  const settings = await getSettings(ctx.db, session.broadcaster_id);
  if (settings.recordingConsent && settings.recordingEnabled) return { available: true, reason: null, source: "recording", bufferSeconds: null, liveSourceId: live.id };
  if (settings.recordingConsent && settings.rollingBufferEnabled) {
    return { available: true, reason: null, source: "buffer", bufferSeconds: settings.rollingBufferSeconds, liveSourceId: live.id };
  }
  return unavailable("Instant replay is off: the creator hasn't turned on recording or the rolling buffer in Studio.");
}

interface Anchor {
  receivedAtMs: number;
  mediaMs: number | null;
  secondsAgo: number | null;
}

/** Create (or reuse) an instant replay for this session. The caller has authorized the viewer. */
export async function makeInstantReplay(ctx: ServerContext, session: StreamSessionRow, req: InstantReplayRequest): Promise<InstantReplayResponse> {
  const st = await instantReplayStatus(ctx, session);
  if (!st.available || !st.source || !st.liveSourceId) return { status: "unavailable", reason: st.reason ?? "Instant replay isn't available" };
  let anchor: Anchor;
  if (req.observationId) {
    const o = await getObservation(ctx.db, req.observationId);
    if (!o || o.sessionId !== session.id) return { status: "unavailable", reason: "That moment isn't part of this stream" };
    if (o.mediaStartMs === null) return { status: "unavailable", reason: "That entry has no place in the video (it came from Twitch, not the gameplay)" };
    anchor = { receivedAtMs: Date.parse(o.receivedAt), mediaMs: o.mediaStartMs, secondsAgo: null };
  } else {
    anchor = { receivedAtMs: Date.now(), mediaMs: null, secondsAgo: req.secondsAgo ?? 10 };
  }
  void sweepInstantReplays(ctx, 20).catch(() => undefined);
  const reply =
    st.source === "recording"
      ? await fromRecording(ctx, session, anchor, req)
      : await askWorker(ctx, st.liveSourceId, {
          id: randomUUID(),
          sessionId: session.id,
          broadcasterId: session.broadcaster_id,
          receivedAtMs: anchor.receivedAtMs,
          mediaMs: anchor.mediaMs,
          secondsAgo: anchor.secondsAgo,
          preMs: req.preMs,
          postMs: req.postMs,
        });
  return reply.status === "ready" ? signed(ctx, reply) : reply;
}

async function signed(ctx: Pick<ServerContext, "storage">, r: StoredReplay): Promise<Ready> {
  const { key, ...rest } = r;
  const url = await ctx.storage.signedGetUrl(key, INSTANT_REPLAY_TTL_SEC, "video/mp4");
  return { ...rest, url, expiresAt: new Date(Date.now() + INSTANT_REPLAY_TTL_SEC * 1000).toISOString() };
}

/* ------------------------------------------------------------------------------------------ */
/* Window planning (pure)                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface SegmentTimes {
  startMs: number;
  endMs: number;
}

export type WindowPlan =
  | { kind: "ok"; fromMs: number; toMs: number; momentOffsetMs: number | null; parts: number[] }
  | { kind: "pending"; reason: string; retryAfterMs: number }
  | { kind: "unavailable"; reason: string };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
/** While live, a replay starts once this much after the moment is saved (cut short, not delayed). */
export const MIN_AFTERMATH_MS = 2000;

/**
 * Choose the window to cut from contiguous segments (sorted, in the reader's media time). While
 * the stream is still being written (`open`), a window whose end isn't saved yet waits, unless
 * two seconds after the moment are already there; then it is cut short rather than delayed.
 */
export function planWindow(
  segments: readonly SegmentTimes[],
  anchor: Pick<Anchor, "mediaMs" | "secondsAgo">,
  preMs: number,
  postMs: number,
  open: boolean,
  tooOld = "The recording doesn't cover that moment",
): WindowPlan {
  if (segments.length === 0) return open ? { kind: "pending", reason: "The first seconds are still being saved", retryAfterMs: 4000 } : { kind: "unavailable", reason: tooOld };
  const first = segments[0]!.startMs;
  const last = segments[segments.length - 1]!.endMs;
  let from: number;
  let to: number;
  if (anchor.mediaMs === null) {
    to = last;
    from = last - (anchor.secondsAgo ?? 10) * 1000;
  } else {
    if (anchor.mediaMs < first) return { kind: "unavailable", reason: tooOld };
    if (anchor.mediaMs >= last) {
      if (!open) return { kind: "unavailable", reason: tooOld };
      return { kind: "pending", reason: "Saving the moment", retryAfterMs: clamp(anchor.mediaMs + MIN_AFTERMATH_MS - last + 1500, 1500, 8000) };
    }
    from = anchor.mediaMs - preMs;
    to = anchor.mediaMs + postMs;
  }
  from = Math.max(from, first);
  if (to > last) {
    // Two seconds of aftermath are enough to start; the rest of the window isn't waited for.
    const minEnd = (anchor.mediaMs ?? last) + MIN_AFTERMATH_MS;
    if (open && last < minEnd) return { kind: "pending", reason: "Saving the last seconds of the moment", retryAfterMs: clamp(minEnd - last + 1500, 1500, 8000) };
    to = last;
  }
  if (to - from < 1000) return { kind: "unavailable", reason: tooOld };
  const parts: number[] = [];
  segments.forEach((s, i) => {
    if (s.endMs > from && s.startMs < to) parts.push(i);
  });
  // Joining across a hole would shift everything after it: say so instead.
  for (let i = 1; i < parts.length; i++) {
    if (Math.abs(segments[parts[i]!]!.startMs - segments[parts[i - 1]!]!.endMs) > 250) return { kind: "unavailable", reason: "Part of that moment wasn't saved" };
  }
  return { kind: "ok", fromMs: from, toMs: to, momentOffsetMs: anchor.mediaMs === null ? null : anchor.mediaMs - from, parts };
}

/** Which recording run a live moment belongs to: the same rule the recording uses to re-base. */
export function runForMoment(runs: readonly RecordingRun[], receivedAtMs: number, now = Date.now()): RecordingRun | null {
  const sorted = [...runs].sort((a, b) => Date.parse(a.wallStart) - Date.parse(b.wallStart));
  let hit: RecordingRun | null = null;
  for (const r of sorted) {
    if (receivedAtMs >= Date.parse(r.wallStart) - 2000 && receivedAtMs <= (r.wallEnd ? Date.parse(r.wallEnd) : now) + 15_000) hit = r;
  }
  return hit;
}

/**
 * The rolling buffer's segment list, keeping only segments whose files still hold them. The
 * muxer reuses file names in a ring, so the newest entry per name wins, and the file after the
 * newest one is being rewritten right now: its older entry no longer matches the file.
 */
export function bufferSegments(csv: string, ringSize: number): (SegmentTimes & { name: string })[] {
  const latest = new Map<string, SegmentTimes & { name: string; n: number }>();
  let lastName: string | null = null;
  for (const line of csv.trim().split(/\r?\n/)) {
    const [name, s, e] = line.split(",");
    const m = name?.match(/^seg(\d{4})\.ts$/);
    if (!name || !m) continue;
    const startMs = Math.round(Number(s) * 1000);
    const endMs = Math.round(Number(e) * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    latest.set(name, { name, n: Number(m[1]), startMs, endMs });
    lastName = name;
  }
  if (lastName && ringSize > 0) {
    const writing = `seg${String((latest.get(lastName)!.n + 1) % ringSize).padStart(4, "0")}.ts`;
    if (writing !== lastName) latest.delete(writing);
  }
  const list = [...latest.values()].sort((a, b) => a.startMs - b.startMs).map(({ name, startMs, endMs }) => ({ name, startMs, endMs }));
  // Only the newest contiguous run counts: a gap means older entries belong to another lap.
  let startIdx = list.length - 1;
  while (startIdx > 0 && Math.abs(list[startIdx]!.startMs - list[startIdx - 1]!.endMs) <= 250) startIdx -= 1;
  return list.slice(Math.max(0, startIdx));
}

/* ------------------------------------------------------------------------------------------ */
/* Recording segments (storage): any API process can cut these                               */
/* ------------------------------------------------------------------------------------------ */

async function fromRecording(ctx: ServerContext, session: StreamSessionRow, anchor: Anchor, req: InstantReplayRequest): Promise<BufferReplayReply> {
  const rec = await getRecordingBySession(ctx.db, session.id);
  if (!rec || rec.runs.length === 0) return { status: "pending", reason: "Recording is starting", retryAfterMs: 3000 };
  // After a reconnect, earlier moments were already re-based onto the saved file's timeline.
  if (anchor.mediaMs !== null && rec.rebased_until && anchor.receivedAtMs <= rec.rebased_until.getTime()) return fromSavedFile(ctx, session, rec, anchor, req);
  const run =
    anchor.mediaMs === null
      ? ([...rec.runs].sort((a, b) => Date.parse(b.wallStart) - Date.parse(a.wallStart)).find((r) => r.segments.length > 0) ?? null)
      : runForMoment(rec.runs, anchor.receivedAtMs);
  if (!run) return { status: "unavailable", reason: "That moment happened before recording started" };
  const segments = [...run.segments].sort((a, b) => a.startMs - b.startMs);
  const plan = planWindow(segments, anchor, req.preMs, req.postMs, run.wallEnd === null);
  if (plan.kind === "pending") return { status: "pending", reason: plan.reason, retryAfterMs: plan.retryAfterMs };
  if (plan.kind === "unavailable") return { status: "unavailable", reason: plan.reason };
  const parts = plan.parts.map((i) => segments[i]!);
  try {
    return await cutWindow(ctx, session, `rec|${run.runId}`, plan, "recording", async (work) => {
      const files: string[] = [];
      for (const [i, s] of parts.entries()) files.push(await localCopy(ctx.storage, s.key, path.join(work, `p${i}.ts`)));
      return { files, offsetMs: parts[0]!.startMs };
    });
  } catch (err) {
    ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message), session: session.id }, "instant replay cut failed");
    return { status: "unavailable", reason: "Couldn't cut the replay from the recording. Try again in a moment." };
  }
}

async function fromSavedFile(ctx: ServerContext, session: StreamSessionRow, rec: RecordingRow, anchor: Anchor, req: InstantReplayRequest): Promise<BufferReplayReply> {
  const src = rec.status === "ready" && rec.source_id ? await getSource(ctx.db, rec.source_id) : null;
  const asset = src?.original_asset_id ? await getAsset(ctx.db, src.original_asset_id) : null;
  if (!asset || !rec.duration_ms) return { status: "pending", reason: "That moment is being saved into the recording", retryAfterMs: 5000 };
  const plan = planWindow([{ startMs: 0, endMs: rec.duration_ms }], anchor, req.preMs, req.postMs, false);
  if (plan.kind !== "ok") return plan.kind === "pending" ? { status: "pending", reason: plan.reason, retryAfterMs: plan.retryAfterMs } : { status: "unavailable", reason: plan.reason };
  try {
    return await cutWindow(ctx, session, `file|${asset.id}`, plan, "recording", async (work) => ({
      files: [await localCopy(ctx.storage, asset.storage_key, path.join(work, "recording.mp4"))],
      offsetMs: 0,
    }));
  } catch (err) {
    ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message), session: session.id }, "instant replay cut failed");
    return { status: "unavailable", reason: "Couldn't cut the replay from the recording. Try again in a moment." };
  }
}

/** fs storage: read the stored file in place. Anything else: download to the work dir. */
async function localCopy(storage: StorageDriver, key: string, dest: string): Promise<string> {
  const local = (storage as StorageDriver & { localPath?: (k: string) => string }).localPath;
  if (local) return local.call(storage, key);
  await storage.downloadToFile(key, dest);
  return dest;
}

const inflight = new Map<string, Promise<StoredReplay>>();

/**
 * Cut one planned window and store it, reusing a cached cut of the same window. Concurrent
 * requests for the same window share one encode.
 */
async function cutWindow(
  ctx: Pick<ServerContext, "redis" | "storage" | "tools">,
  session: Pick<StreamSessionRow, "id" | "broadcaster_id">,
  scope: string,
  plan: Extract<WindowPlan, { kind: "ok" }>,
  source: InstantReplaySource,
  gather: (work: string) => Promise<{ files: string[]; offsetMs: number }>,
): Promise<StoredReplay> {
  const r100 = (v: number) => Math.round(v / 100) * 100;
  const id = createHash("sha1").update(`${session.id}|${scope}|${r100(plan.fromMs)}|${r100(plan.toMs)}`).digest("hex").slice(0, 24);
  const result = {
    status: "ready" as const,
    source,
    startMs: Math.round(plan.fromMs),
    endMs: Math.round(plan.toMs),
    momentOffsetMs: plan.momentOffsetMs === null ? null : Math.round(plan.momentOffsetMs),
    durationMs: Math.round(plan.toMs - plan.fromMs),
  };
  const cached = await ctx.redis.get(CACHE_PREFIX + id);
  if (cached) {
    // The link handed out now must outlive the file: push its sweep time out.
    await ctx.redis.zadd(SWEEP_SET, "GT", Date.now() + INSTANT_REPLAY_TTL_SEC * 1000 + 60_000, cached);
    return { ...result, key: cached };
  }
  const running = inflight.get(id);
  if (running) return running;
  const job = (async () => {
    const work = await mkdtemp(path.join(tmpdir(), "slot1-ireplay-"));
    try {
      const { files, offsetMs } = await gather(work);
      const out = path.join(work, "replay.mp4");
      await encodeReplayWindow(ctx.tools, files, offsetMs, plan.fromMs, plan.toMs, out, work);
      const key = `${storageKeys.sessionPrefix(session.broadcaster_id, session.id)}/instant-replay/${id}.mp4`;
      await ctx.storage.putFile(key, out, "video/mp4");
      await ctx.redis.zadd(SWEEP_SET, Date.now() + INSTANT_REPLAY_TTL_SEC * 1000 + 60_000, key);
      await ctx.redis.set(CACHE_PREFIX + id, key, "EX", INSTANT_REPLAY_TTL_SEC - 60);
      return { ...result, key };
    } finally {
      inflight.delete(id);
      await rm(work, { recursive: true, force: true });
    }
  })();
  inflight.set(id, job);
  return job;
}

/**
 * Join copy-only segments and cut [fromMs, toMs] exactly: the output-side seek decodes from the
 * first segment's keyframe and drops frames up to the start, so the first frame is the requested
 * one (never a nearby keyframe). Only this window is re-encoded: ultrafast, at most 720p,
 * faststart so it plays while it downloads. About 1.4 s for 12 s of 720p30 on two cores.
 */
export async function encodeReplayWindow(tools: MediaTools, files: readonly string[], offsetMs: number, fromMs: number, toMs: number, out: string, work: string): Promise<void> {
  const list = path.join(work, "replay-list.txt");
  await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const seek = (Math.max(0, fromMs - offsetMs) / 1000).toFixed(3);
  // Deep inside one long file (a saved recording), seek on the input instead: still accurate
  // (decodes from the keyframe before), without decoding everything before the window.
  const deep = fromMs - offsetMs > 10_000;
  await runChecked(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-protocol_whitelist",
      "file",
      ...(deep ? ["-ss", seek, "-i", list] : ["-i", list, "-ss", seek]),
      "-t",
      ((toMs - fromMs) / 1000).toFixed(3),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=-2:'min(720,ih)'",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-y",
      out,
    ],
    { timeoutMs: 45_000 },
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Rolling buffer: only the worker reading the stream has it, so ask that worker              */
/* ------------------------------------------------------------------------------------------ */

interface ReplySubscriber {
  redis: Redis;
  ready: Promise<unknown>;
  waiters: Map<string, (reply: BufferReplayReply) => void>;
}
const subscribers = new WeakMap<object, ReplySubscriber>();

async function replySubscriber(ctx: Pick<ServerContext, "config" | "redis">): Promise<ReplySubscriber> {
  let sub = subscribers.get(ctx);
  if (!sub) {
    const redis = createRedis(ctx.config.env.REDIS_URL);
    const waiters = new Map<string, (reply: BufferReplayReply) => void>();
    redis.on("pmessage", (_p: string, channel: string, message: string) => {
      const done = waiters.get(channel.slice(RESPONSE_PREFIX.length));
      if (!done) return;
      try {
        done(JSON.parse(message) as BufferReplayReply);
      } catch {
        /* malformed reply: the request times out */
      }
    });
    sub = { redis, waiters, ready: redis.psubscribe(`${RESPONSE_PREFIX}*`) };
    subscribers.set(ctx, sub);
  }
  await sub.ready;
  return sub;
}

/** Close this context's reply subscriber (API shutdown, tests). */
export async function closeInstantReplay(ctx: object): Promise<void> {
  const sub = subscribers.get(ctx);
  subscribers.delete(ctx);
  if (sub) await sub.redis.quit().catch(() => sub.redis.disconnect());
}

async function askWorker(ctx: Pick<ServerContext, "config" | "redis">, sourceId: string, req: BufferReplayRequest): Promise<BufferReplayReply> {
  const sub = await replySubscriber(ctx);
  let timer: NodeJS.Timeout | undefined;
  const reply = new Promise<BufferReplayReply | null>((resolve) => {
    sub.waiters.set(req.id, resolve);
    timer = setTimeout(() => resolve(null), 15_000);
  });
  try {
    const listeners = await ctx.redis.publish(replayRequestChannel(sourceId), JSON.stringify(req));
    if (listeners === 0) return { status: "unavailable", reason: "SLOT1 isn't reading this stream right now, so its rolling buffer can't be replayed" };
    return (await reply) ?? { status: "pending", reason: "The replay is taking longer than usual", retryAfterMs: 3000 };
  } finally {
    clearTimeout(timer);
    sub.waiters.delete(req.id);
  }
}

/**
 * Cut a replay from this worker's rolling buffer. `readerStartedAtMs` is when the current reader
 * run began: the buffer is rewritten at each reader start, so earlier moments are reported as
 * gone instead of being matched against the wrong clock.
 */
export async function bufferReplay(
  ctx: Pick<ServerContext, "redis" | "storage" | "tools" | "config">,
  sourceId: string,
  readerStartedAtMs: number,
  bufferSeconds: number,
  ringSize: number,
  req: BufferReplayRequest,
): Promise<BufferReplayReply> {
  const span = bufferSeconds >= 120 ? `${Math.round(bufferSeconds / 60)} min` : `${bufferSeconds} s`;
  const gone = `That moment is no longer in the rolling buffer (it keeps the last ${span})`;
  if (req.mediaMs !== null && req.receivedAtMs < readerStartedAtMs) return { status: "unavailable", reason: gone };
  const dir = path.resolve(ctx.config.env.INGEST_SEGMENT_DIR, sourceId);
  let csv: string;
  try {
    csv = await readFile(path.join(dir, "segments.csv"), "utf8");
  } catch {
    return { status: "pending", reason: "The rolling buffer is still filling", retryAfterMs: 4000 };
  }
  const present: (SegmentTimes & { name: string })[] = [];
  for (const s of bufferSegments(csv, ringSize)) {
    if (await stat(path.join(dir, s.name)).then((x) => x.size > 0).catch(() => false)) present.push(s);
  }
  const plan = planWindow(present, req, req.preMs, req.postMs, true, gone);
  if (plan.kind === "pending") return { status: "pending", reason: plan.reason, retryAfterMs: plan.retryAfterMs };
  if (plan.kind === "unavailable") return { status: "unavailable", reason: plan.reason };
  const parts = plan.parts.map((i) => present[i]!);
  try {
    return await cutWindow(ctx, { id: req.sessionId, broadcaster_id: req.broadcasterId }, `buf|${sourceId}|${readerStartedAtMs}`, plan, "buffer", async () => ({
      files: parts.map((p) => path.join(dir, p.name)),
      offsetMs: parts[0]!.startMs,
    }));
  } catch {
    return { status: "unavailable", reason: "Couldn't cut the replay from the rolling buffer. Try again in a moment." };
  }
}

/**
 * Worker side of the rolling-buffer replay: one Redis subscription per worker, one channel per
 * source this worker reads. Requests for sources it doesn't read never reach it.
 */
export class BufferReplayResponder {
  private sub: Redis | null = null;
  private readonly handlers = new Map<string, (req: BufferReplayRequest) => Promise<BufferReplayReply>>();

  constructor(private readonly ctx: Pick<ServerContext, "redis" | "config" | "log">) {}

  private connection(): Redis {
    if (this.sub) return this.sub;
    const sub = createRedis(this.ctx.config.env.REDIS_URL);
    sub.on("message", (channel: string, message: string) => void this.handle(channel, message));
    this.sub = sub;
    return sub;
  }

  private async handle(channel: string, message: string) {
    let req: BufferReplayRequest;
    try {
      req = JSON.parse(message) as BufferReplayRequest;
      if (typeof req.id !== "string" || !/^[0-9a-f-]{36}$/.test(req.id)) return;
    } catch {
      return;
    }
    const handler = this.handlers.get(channel);
    let reply: BufferReplayReply;
    try {
      reply = handler ? await handler(req) : { status: "unavailable", reason: "SLOT1 isn't reading this stream right now" };
    } catch (err) {
      this.ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "buffer replay failed");
      reply = { status: "unavailable", reason: "Couldn't cut the replay from the rolling buffer. Try again in a moment." };
    }
    await this.ctx.redis.publish(`${RESPONSE_PREFIX}${req.id}`, JSON.stringify(reply)).catch(() => undefined);
  }

  /** Answer replay requests for this source with `handler` (replaces an earlier handler). */
  async serve(sourceId: string, handler: (req: BufferReplayRequest) => Promise<BufferReplayReply>): Promise<void> {
    const channel = replayRequestChannel(sourceId);
    const had = this.handlers.has(channel);
    this.handlers.set(channel, handler);
    if (!had) await this.connection().subscribe(channel);
  }

  async stop(sourceId: string): Promise<void> {
    const channel = replayRequestChannel(sourceId);
    if (!this.handlers.delete(channel)) return;
    await this.sub?.unsubscribe(channel).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    const sub = this.sub;
    this.sub = null;
    if (sub) await sub.quit().catch(() => sub.disconnect());
  }
}

/** Delete replay files whose links have expired. */
export async function sweepInstantReplays(ctx: Pick<ServerContext, "redis" | "storage">, limit = 200): Promise<number> {
  const keys = await ctx.redis.zrangebyscore(SWEEP_SET, "-inf", Date.now(), "LIMIT", 0, limit);
  for (const k of keys) {
    await ctx.storage.delete(k).catch(() => undefined);
    await ctx.redis.zrem(SWEEP_SET, k);
  }
  return keys.length;
}
