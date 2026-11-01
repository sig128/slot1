import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  commentaryAllowed,
  createVisionProvider,
  deriveLiveState,
  getProfile,
  LiveIngestAdapter,
  ObservationPipeline,
  TesseractOcr,
  type SampledFrame,
} from "@slot1/analysis";
import { commentaryLine } from "@slot1/bot";
import type { AnalysisState, ChannelSettings, Observation } from "@slot1/contracts";
import {
  createIngestSession,
  endSession,
  getBroadcaster,
  getOpenTwitchSession,
  getSession,
  getSettings,
  getSource,
  getSourceHealth,
  insertAsset,
  listPublishingSources,
  markPublishEnded,
  recordDroppedFrames,
  recordFrameReceived,
  recordOpsError,
  setAnalysisState,
  setSourceSession,
  upsertSourceHealth,
  type MediaSourceRow,
  type StreamSessionRow,
} from "@slot1/db";
import { QUEUES, RedisLease, sanitizeErrorMessage, storageKeys } from "@slot1/platform";
import {
  analysisStatus,
  bufferReplay,
  BufferReplayResponder,
  createPipelineSink,
  DEMO_LIMITS,
  DEMO_PUBLISH_PATH,
  DEMO_SESSION_TITLE,
  demoClipFromBuffer,
  demoHousekeeping,
  emitAnalysisStatus,
  emitSourceHealth,
  isDemoBroadcaster,
  sourceHealthView,
  type BufferReplayReply,
  type BufferReplayRequest,
  type ServerContext,
} from "@slot1/services";
import { loadActiveGtaModel } from "../gta/onnx-model";
import { publishAiView } from "./ai-view";
import { announce } from "./announce";
import { LiveRecorder } from "./recorder";

const LEASE_TTL_MS = 10_000;
/** A publisher returning after this long starts a new session instead of extending the old one. */
const INGEST_SESSION_GAP_MS = 30 * 60_000;
const SALIENT = new Set(["highlight_candidate", "possible_collision", "result_screen", "mission_title"]);

export function buildReadUrl(ctx: ServerContext, publishPath: string): string {
  const env = ctx.config.env;
  const template = env.INGEST_READ_URL_TEMPLATE;
  if (!template) throw new Error("INGEST_READ_URL_TEMPLATE is not set");
  const name = publishPath.replace(/^live\//, "");
  return template
    .replaceAll("{path}", publishPath)
    .replaceAll("{name}", encodeURIComponent(name))
    .replaceAll("{user}", encodeURIComponent(env.INGEST_READ_USER))
    .replaceAll("{password}", encodeURIComponent(env.INGEST_READ_PASSWORD ?? ""));
}

/** Supervises continuous ingest: exactly one worker (Redis lease) reads each publishing source. */
export class LiveSupervisor {
  private runners = new Map<string, LiveRunner>();
  private timer: NodeJS.Timeout | null = null;
  private readonly lease: RedisLease;

  constructor(
    private readonly ctx: ServerContext,
    owner: string,
  ) {
    this.lease = new RedisLease(ctx.redis, owner);
    this.replays = new BufferReplayResponder(ctx);
  }

  /** Instant replays from the rolling buffer are cut by the worker that holds it (this one). */
  private readonly replays: BufferReplayResponder;

  start() {
    if (!this.ctx.config.capabilities.ingest.available) {
      this.ctx.log.info({ reason: this.ctx.config.capabilities.ingest.reason }, "live ingest disabled");
      return;
    }
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.ctx.log.error({ err: (err as Error).message }, "supervisor tick failed")), 2000);
    void this.tick();
  }

  async tick() {
    const publishing = await listPublishingSources(this.ctx.db);
    const ids = new Set(publishing.map((s) => s.id));
    for (const [id, r] of this.runners) {
      if (!ids.has(id)) {
        this.runners.delete(id);
        await r.stop("publisher_disconnected");
      } else if (r.finished) this.runners.delete(id);
    }
    for (const s of publishing) {
      if (this.runners.has(s.id) || this.runners.size >= this.ctx.config.env.WORKER_LIVE_MAX_SOURCES) continue;
      if (!(await this.lease.acquire(`source:${s.id}`, LEASE_TTL_MS))) continue;
      const runner = new LiveRunner(this.ctx, s, this.lease, this.replays);
      this.runners.set(s.id, runner);
      void runner.run().catch((err: unknown) => this.ctx.log.error({ err: sanitizeErrorMessage((err as Error).message), source: s.id }, "live runner crashed"));
    }
  }

  async stopAll() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.runners.values()].map((r) => r.stop("worker_shutdown")));
    this.runners.clear();
    await this.replays.close();
  }
}

class LiveRunner {
  finished = false;
  private running = true;
  private adapter: LiveIngestAdapter | null = null;
  private session: StreamSessionRow | null = null;
  private lastState: AnalysisState | null = null;
  private lastHealthEmit = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private lastFrameAt: number | null = null;
  private lastAnalyzedAt: number | null = null;
  private stopReason: string | null = null;
  /** Full-stream recording of the current reader run (creator opt-in). */
  private recorder: LiveRecorder | null = null;
  private recordingId: string | null = null;
  /** SLOT1's own demo channel (synthetic test video): bounded, never sent to paid AI by default. */
  private demo = false;
  private lastHousekeeping = 0;
  /** Current reader run of the rolling buffer (demo clips are cut from it). */
  private bufferRun: { startedAt: number; ringSize: number } | null = null;

  constructor(
    private readonly ctx: ServerContext,
    private source: MediaSourceRow,
    private readonly lease: RedisLease,
    private readonly replays: BufferReplayResponder | null = null,
  ) {}

  /** A rolling-buffer instant replay for this runner's current session and reader run. */
  private replayFromBuffer(req: BufferReplayRequest, readerStartedAt: number, bufferSeconds: number, ringSize: number): Promise<BufferReplayReply> {
    if (!this.session || req.sessionId !== this.session.id) return Promise.resolve({ status: "unavailable", reason: "That moment isn't part of this stream" });
    return bufferReplay(this.ctx, this.source.id, readerStartedAt, bufferSeconds, ringSize, req);
  }

  private async resolveSession(settings: ChannelSettings): Promise<StreamSessionRow> {
    if (this.source.session_id) {
      const s = await getSession(this.ctx.db, this.source.session_id);
      if (s && !s.ended_at) {
        const last = (s.last_received_frame_at ?? s.started_at).getTime();
        if (s.kind !== "ingest" || Date.now() - last < INGEST_SESSION_GAP_MS) return s;
        await endSession(this.ctx.db, s.id);
      }
    }
    // A TEST source never joins a real Twitch broadcast session.
    const open = this.source.label === "live" ? await getOpenTwitchSession(this.ctx.db, this.source.broadcaster_id) : null;
    const s =
      open ??
      (await createIngestSession(
        this.ctx.db,
        this.source.broadcaster_id,
        this.source.label === "test" ? "test" : "live",
        this.demo ? DEMO_SESSION_TITLE : `${this.source.label === "test" ? "Test ingest" : "Live ingest"}: ${this.source.name}`,
        settings.visibility,
        settings.sampleIntervalMs,
      ));
    if (open) await this.ctx.db.query(`UPDATE stream_sessions SET expected_interval_ms = $2 WHERE id = $1`, [open.id, settings.sampleIntervalMs]);
    await setSourceSession(this.ctx.db, this.source.id, s.id);
    this.source = (await getSource(this.ctx.db, this.source.id)) ?? this.source;
    return (await getSession(this.ctx.db, s.id)) ?? s;
  }

  async run() {
    const ctx = this.ctx;
    let settings = await getSettings(ctx.db, this.source.broadcaster_id);
    this.demo = this.source.publish_path === DEMO_PUBLISH_PATH && isDemoBroadcaster(await getBroadcaster(ctx.db, this.source.broadcaster_id));
    this.session = await this.resolveSession(settings);
    this.healthTimer = setInterval(() => void this.healthTick().catch(() => undefined), 2000);
    const work = path.join(tmpdir(), `slot1-live-${this.source.id}`);
    await mkdir(work, { recursive: true });
    try {
      while (this.running) {
        if (!(await this.lease.renew(`source:${this.source.id}`, LEASE_TTL_MS))) break;
        settings = await getSettings(ctx.db, this.source.broadcaster_id);
        // Fresh source row for every reader run: it carries the creator's current camera mask.
        this.source = (await getSource(ctx.db, this.source.id)) ?? this.source;
        if (this.demo && this.session && Date.now() - this.session.started_at.getTime() > DEMO_LIMITS.sessionMaxMs) {
          // The demo runs for weeks: close its session hourly so nothing grows without bound.
          await endSession(ctx.db, this.session.id);
          await setSourceSession(ctx.db, this.source.id, null);
          this.source = (await getSource(ctx.db, this.source.id)) ?? this.source;
          this.session = await this.resolveSession(settings);
        }
        const analyzing = settings.agentEnabled && !settings.analysisPaused;
        const buffer =
          settings.rollingBufferEnabled && settings.recordingConsent
            ? { dir: path.resolve(ctx.config.env.INGEST_SEGMENT_DIR, this.source.id), segmentSeconds: 6, segments: Math.ceil(settings.rollingBufferSeconds / 6) }
            : null;
        if (buffer) await mkdir(buffer.dir, { recursive: true });
        const session = this.session!;
        const recorder = settings.recordingEnabled && settings.recordingConsent
          ? await LiveRecorder.start(ctx, session, this.source).catch((err: unknown) => {
              ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message), source: this.source.id }, "recording could not start");
              return null;
            })
          : null;
        this.recorder = recorder;
        if (recorder) this.recordingId = recorder.recordingId;
        // "Hide your camera from the AI": blacked out inside ffmpeg for every analyzed frame.
        const mask = this.source.camera_mask ?? [];
        const maskKey = JSON.stringify(mask);
        const adapter = new LiveIngestAdapter(
          { sourceId: this.source.id, broadcasterId: this.source.broadcaster_id, sessionId: session.id, kind: "live_ingest", label: this.source.label },
          ctx.tools,
          {
            readUrl: buildReadUrl(ctx, this.source.publish_path!),
            intervalMs: settings.sampleIntervalMs,
            maxEdge: ctx.config.env.VISION_MAX_EDGE_PX,
            queueSize: 4,
            rollingBuffer: buffer,
            ioTimeoutSec: 15,
            hwaccel: ctx.config.env.FFMPEG_HWACCEL,
            hwaccelDevice: ctx.config.env.FFMPEG_HWACCEL_DEVICE,
            recording: recorder?.options() ?? null,
            mask,
          },
          (count, atPts) => {
            // Frames dropped under load are disclosed as coverage gaps, never hidden.
            void recordDroppedFrames(ctx.db, session.id, count, atPts === null ? null : { startMs: atPts, endMs: atPts + settings.sampleIntervalMs, reason: "dropped under load" });
            void upsertSourceHealth(ctx.db, this.source.id, { framesDroppedDelta: count });
          },
        );
        this.adapter = adapter;
        // The buffer is rewritten from this reader start on; replays only cover this run.
        const readerStartedAt = Date.now();
        const bufferSeconds = settings.rollingBufferSeconds;
        this.bufferRun = buffer ? { startedAt: readerStartedAt, ringSize: buffer.segments } : null;
        if (buffer) await this.replays?.serve(this.source.id, (req) => this.replayFromBuffer(req, readerStartedAt, bufferSeconds, buffer.segments));
        else await this.replays?.stop(this.source.id);
        await adapter.connect();
        const pipeline = analyzing
          ? new ObservationPipeline({
              ocr: ctx.config.capabilities.ocr.available ? new TesseractOcr(ctx.config.env.TESSERACT_PATH, ctx.tools) : null,
              ocrVersion: "5",
              // The demo never reaches a paid provider unless the operator opted in (rate-capped).
              vision: this.demo && !ctx.config.env.SLOT1_DEMO_VISION ? null : createVisionProvider(ctx.config.env),
              gtaModel: await loadActiveGtaModel(ctx, { live: true, streamId: `live:${this.source.id}` }),
              profile: getProfile(settings.gameProfile),
              sourceLabel: this.source.label,
              visionBatchSize: Math.max(1, Math.min(3, ctx.config.env.VISION_FRAMES_PER_CALL)),
              coverageMsPerFrame: settings.sampleIntervalMs,
              workDir: path.join(work, "pipeline"),
              sink: createPipelineSink(ctx, {
                session,
                source: this.source,
                settings,
                retentionDays: this.demo ? DEMO_LIMITS.frameRetentionDays : settings.retentionDays,
                onObservation: async (o) => {
                  await this.maybeComment(o);
                  if (this.demo) this.maybeDemoClip(o);
                },
                onFrameStored: async () => undefined,
                autoClipRunId: () => this.recorder?.runId ?? null,
              }),
              // "What the AI sees": a short-lived snapshot of each analyzed frame for viewers.
              insight: (i) =>
                publishAiView(
                  ctx,
                  {
                    sessionId: session.id,
                    label: this.source.label,
                    demo: this.demo,
                    intervalMs: settings.sampleIntervalMs,
                    measuredCadenceMs: adapter.health().cadenceMs ?? null,
                    hidden: mask,
                  },
                  i,
                ),
            })
          : null;
        let gotFrame = false;
        let maskCheckedAt = Date.now();
        for await (const frame of adapter.frames()) {
          if (!this.running) break;
          gotFrame = true;
          this.failures = 0;
          this.lastFrameAt = frame.receivedAt.getTime();
          if (pipeline) {
            await pipeline.handleFrame(frame);
            if (this.lastAnalyzedAt === null && this.source.label === "live") {
              void announce(ctx, this.source.broadcaster_id, "SLOT1 is watching the gameplay now. Try !slot1 now", `watching:${session.id}`).catch(() => undefined);
            }
            this.lastAnalyzedAt = Date.now();
          } else {
            await this.storePreview(frame);
          }
          const fresh = await getSettings(ctx.db, this.source.broadcaster_id);
          // Restart the reader when analysis or recording is switched on or off.
          if ((fresh.agentEnabled && !fresh.analysisPaused) !== analyzing || (fresh.recordingEnabled && fresh.recordingConsent) !== (settings.recordingEnabled && settings.recordingConsent)) break;
          // The demo's hourly session change (handled at the top of the loop).
          if (this.demo && Date.now() - session.started_at.getTime() > DEMO_LIMITS.sessionMaxMs) break;
          // A changed camera mask applies from the next reader run, a few seconds from now.
          if (Date.now() - maskCheckedAt > 4000) {
            maskCheckedAt = Date.now();
            const current = await getSource(ctx.db, this.source.id);
            if (current && JSON.stringify(current.camera_mask ?? []) !== maskKey) break;
          }
        }
        await pipeline?.flush();
        await adapter.disconnect();
        await recorder?.close().catch(() => undefined);
        this.recorder = null;
        const err = adapter.health().error;
        if (err) await recordOpsError(ctx.db, this.source.broadcaster_id, "ingest", sanitizeErrorMessage(err));
        if (!this.running) break;
        if (!gotFrame) this.failures += 1;
        const current = await getSource(ctx.db, this.source.id);
        if (!current || current.status !== "publishing" || current.revoked_at) break;
        if (this.failures >= 4) {
          // The gateway reported a publisher but no media arrives: treat the publisher as gone.
          await markPublishEnded(ctx.db, this.source.id);
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(15_000, 2000 * 2 ** this.failures)));
      }
    } finally {
      await this.finish(this.stopReason ?? "publisher_disconnected");
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Not analyzing: keep only the latest frame as the Studio preview (one fixed object). */
  private async storePreview(frame: SampledFrame) {
    const ctx = this.ctx;
    const session = this.session!;
    const key = `${storageKeys.sessionPrefix(session.broadcaster_id, session.id)}/src/${this.source.id}/preview.jpg`;
    const { bytes } = await ctx.storage.putBuffer(key, frame.jpeg, "image/jpeg");
    const asset = await insertAsset(ctx.db, {
      broadcasterId: session.broadcaster_id,
      sessionId: session.id,
      sourceId: this.source.id,
      kind: "thumbnail",
      storageKey: key,
      contentType: "image/jpeg",
      bytes,
      width: frame.width,
      height: frame.height,
      mediaPtsMs: frame.ptsMs,
    });
    await upsertSourceHealth(ctx.db, this.source.id, { framesReceivedDelta: 1, lastFrameAt: frame.receivedAt, lastFrameAssetId: asset.id, lastFramePtsMs: frame.ptsMs });
    await recordFrameReceived(ctx.db, session.id, null);
  }

  private async healthTick() {
    const ctx = this.ctx;
    if (!this.session) return;
    await this.recorder?.sync();
    if (this.demo && Date.now() - this.lastHousekeeping > 5 * 60_000) {
      this.lastHousekeeping = Date.now();
      await demoHousekeeping(ctx, this.source.broadcaster_id).catch((err: unknown) =>
        ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "demo housekeeping failed"),
      );
    }
    const settings = await getSettings(ctx.db, this.source.broadcaster_id);
    const row = await getSession(ctx.db, this.session.id);
    if (!row) return;
    const health = this.adapter?.health();
    if (health?.cadenceMs) await ctx.db.query(`UPDATE stream_sessions SET measured_cadence_ms = $2 WHERE id = $1`, [row.id, health.cadenceMs]);
    const derived = deriveLiveState({
      now: Date.now(),
      stoppedByCreator: false,
      pausedByCreator: settings.analysisPaused,
      publisherConnected: Boolean(health?.connected),
      lastFrameAt: this.lastFrameAt,
      lastAnalyzedAt: settings.agentEnabled ? this.lastAnalyzedAt : null,
      error: null,
      visionConfigured: ctx.config.capabilities.vision.available,
      ocrAvailable: ctx.config.capabilities.ocr.available,
      expectedIntervalMs: settings.sampleIntervalMs,
      measuredCadenceMs: health?.cadenceMs ?? row.measured_cadence_ms,
      measuredDelayMs: row.measured_delay_ms,
    });
    let state = derived.state;
    let reason = derived.reason;
    if (!settings.agentEnabled && state !== "stale" && this.lastFrameAt !== null) {
      state = "ready";
      reason = "Video source connected and frames arriving — agent not enabled";
    }
    if (state !== this.lastState || state !== row.analysis_state) {
      this.lastState = state;
      const updated = await setAnalysisState(ctx.db, row.id, state, reason);
      if (updated) await emitAnalysisStatus(ctx.db, ctx.publisher, updated, analysisStatus(updated, ctx.config));
    }
    if (Date.now() - this.lastHealthEmit > 5000) {
      this.lastHealthEmit = Date.now();
      const h = await upsertSourceHealth(ctx.db, this.source.id, { state, cadenceMs: health?.cadenceMs ?? undefined, error: health?.error ?? null });
      const view = sourceHealthView(h);
      if (view) await emitSourceHealth(ctx.db, ctx.publisher, row, view);
    }
    if (!(await this.lease.renew(`source:${this.source.id}`, LEASE_TTL_MS))) await this.stop("lease_lost");
  }

  /** Demo only: cut a short clip from the rolling buffer around a result screen (throttled). */
  private maybeDemoClip(o: Observation) {
    const run = this.bufferRun;
    const session = this.session;
    if (!run || !session || o.type !== "result_screen") return;
    void demoClipFromBuffer(this.ctx, { session, sourceId: this.source.id, readerStartedAtMs: run.startedAt, ringSize: run.ringSize, observation: o }).catch((err: unknown) =>
      this.ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "demo clip failed"),
    );
  }

  /** Automatic commentary: off by default, salient events only, never for TEST sources. */
  private async maybeComment(o: Observation) {
    const ctx = this.ctx;
    if (this.source.label !== "live" || !SALIENT.has(o.type) || !this.session || this.session.kind !== "twitch_broadcast") return;
    const settings = await getSettings(ctx.db, this.source.broadcaster_id);
    const key = `slot1:commentary:last:${this.source.broadcaster_id}`;
    const last = Number((await ctx.redis.get(key)) ?? 0) || null;
    const row = await getSession(ctx.db, this.session.id);
    const ok = commentaryAllowed({
      mode: settings.commentaryMode,
      muted: settings.commentaryMuted,
      botEnabled: settings.botEnabled,
      killed: settings.botKilled,
      globalKill: ctx.config.env.BOT_GLOBAL_KILL,
      analysisState: row ? analysisStatus(row, ctx.config).state : "stale",
      lastCommentaryAt: last,
      now: Date.now(),
    });
    const text = commentaryLine(o);
    if (!ok.allowed || !text) return;
    await ctx.redis.set(key, String(Date.now()), "PX", 3600_000);
    await ctx.enqueue(QUEUES.chat, "post-reply", { broadcasterId: this.source.broadcaster_id, text, replyToMessageId: null, dedupeKey: `commentary:${o.id}` }, { jobId: `commentary-${o.id}` });
  }

  async stop(reason: string) {
    this.stopReason = reason;
    this.running = false;
    await this.adapter?.disconnect();
  }

  private async finish(reason: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.replays?.stop(this.source.id).catch(() => undefined);
    const ctx = this.ctx;
    await this.lease.release(`source:${this.source.id}`).catch(() => undefined);
    if (!this.session) return;
    // When the source disappears the rail goes stale; nothing keeps generating events.
    const state: AnalysisState = reason === "creator_stopped" ? "stopped" : "stale";
    const why = reason === "creator_stopped" ? "Analysis stopped by the creator" : reason === "worker_shutdown" ? "Analysis worker restarting" : "Video source disconnected";
    const row = await setAnalysisState(ctx.db, this.session.id, state, why);
    if (row) await emitAnalysisStatus(ctx.db, ctx.publisher, row, analysisStatus(row, ctx.config));
    const h = await getSourceHealth(ctx.db, this.source.id);
    if (h) await upsertSourceHealth(ctx.db, this.source.id, { state });
    const b = await getBroadcaster(ctx.db, this.source.broadcaster_id);
    ctx.log.info({ source: this.source.id, broadcaster: b?.login, reason }, "live runner stopped");
    // Turn what was recorded into a playable file (any worker can do it; segments are in storage).
    if (this.recordingId) {
      await this.recorder?.close().catch(() => undefined);
      await ctx.enqueue(QUEUES.library, "finalize-recording", { recordingId: this.recordingId }, { jobId: `finalize-${this.recordingId}-${Date.now()}`, attempts: 3 });
    }
  }
}
