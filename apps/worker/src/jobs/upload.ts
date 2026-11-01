import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFrameAt, makePlaybackRendition, probeFile, validateProbe, DEFAULT_PROBE_LIMITS } from "@slot1/analysis";
import {
  getAsset,
  getSession,
  getSettings,
  getSource,
  insertAsset,
  jobRunView,
  recordOpsError,
  setAnalysisState,
  setSourceAssets,
  updateJobRun,
  updateSourceStatus,
} from "@slot1/db";
import { sanitizeErrorMessage, storageKeys, type MediaJobs } from "@slot1/platform";
import { analysisStatus, emitAnalysisStatus, emitJob, type ServerContext } from "@slot1/services";
import { analyzeMediaFile } from "../analyze-file";

/**
 * REPLAY vertical slice: user-owned upload → validate → ffprobe → browser playback rendition →
 * evidence frames → OCR / vision / transcription (when configured) → observations → live rail.
 * The session is labeled REPLAY throughout; it is never presented as a live broadcast.
 */
export async function analyzeUpload(ctx: ServerContext, data: MediaJobs["analyze-upload"]): Promise<void> {
  const session = await getSession(ctx.db, data.sessionId);
  const source = await getSource(ctx.db, data.sourceId);
  if (!session || !source || session.broadcaster_id !== data.broadcasterId || source.broadcaster_id !== data.broadcasterId) return;
  if (session.kind !== "replay" || source.kind !== "upload") throw new Error("analyze-upload only handles replay uploads");
  const settings = await getSettings(ctx.db, session.broadcaster_id);
  const progress = async (step: string, value: number | null) => {
    const job = await updateJobRun(ctx.db, data.jobRunId, { step, progress: value });
    if (job) await emitJob(ctx.db, ctx.publisher, session, jobRunView(job));
  };
  const setState = async (state: "replay" | "error", reason: string) => {
    const row = await setAnalysisState(ctx.db, session.id, state, reason);
    if (row) await emitAnalysisStatus(ctx.db, ctx.publisher, row, analysisStatus(row, ctx.config));
  };

  const work = await mkdtemp(path.join(tmpdir(), "slot1-upload-"));
  try {
    await updateJobRun(ctx.db, data.jobRunId, { state: "running", step: "Fetching upload", progress: 0 });
    await updateSourceStatus(ctx.db, source.id, "processing");
    await setState("replay", "Processing upload");
    const original = source.original_asset_id ? await getAsset(ctx.db, source.original_asset_id) : null;
    if (!original) throw new Error("Original upload is missing from storage");
    const ext = path.extname(original.storage_key) || ".bin";
    const file = path.join(work, `original${ext}`);
    await ctx.storage.downloadToFile(original.storage_key, file);

    await progress("Validating media", 0.02);
    const probe = await probeFile(ctx.tools, file);
    const problems = validateProbe(probe, { ...DEFAULT_PROBE_LIMITS, maxDurationMs: ctx.config.env.UPLOAD_MAX_DURATION_SEC * 1000 });
    if (problems.length) throw new Error(problems.join(" "));

    await progress("Preparing playback", 0.04);
    const playbackFile = path.join(work, "playback.mp4");
    const mode = await makePlaybackRendition(ctx.tools, file, probe, playbackFile);
    const pbKey = storageKeys.playback(session.broadcaster_id, session.id, source.id);
    const pb = await ctx.storage.putFile(pbKey, playbackFile, "video/mp4");
    const pbAsset = await insertAsset(ctx.db, {
      broadcasterId: session.broadcaster_id,
      sessionId: session.id,
      sourceId: source.id,
      kind: "playback",
      storageKey: pbKey,
      contentType: "video/mp4",
      bytes: pb.bytes,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      durationMs: probe.durationMs,
    });
    const posterFile = path.join(work, "poster.jpg");
    await extractFrameAt(ctx.tools, playbackFile, "mov", Math.min(2000, Math.floor((probe.durationMs ?? 0) * 0.1)), posterFile, 1280).catch(() => undefined);
    try {
      const posterKey = storageKeys.poster(session.broadcaster_id, session.id, source.id);
      const p = await ctx.storage.putFile(posterKey, posterFile, "image/jpeg");
      await insertAsset(ctx.db, {
        broadcasterId: session.broadcaster_id,
        sessionId: session.id,
        sourceId: source.id,
        kind: "thumbnail",
        storageKey: posterKey,
        contentType: "image/jpeg",
        bytes: p.bytes,
      });
    } catch {
      /* poster is optional */
    }
    await setSourceAssets(ctx.db, source.id, null, pbAsset.id);
    ctx.log.info({ session: session.id, mode }, "playback rendition ready");

    const result = await analyzeMediaFile(ctx, { session, source, file, settings, onProgress: progress });
    await updateSourceStatus(ctx.db, source.id, "ready");
    await setState("replay", `Replay analyzed: ${result.summary}`);
    const job = await updateJobRun(ctx.db, data.jobRunId, {
      state: "succeeded",
      step: "Done",
      progress: 1,
      usage: { frames: result.frames, analyzedFrames: result.analyzedFrames, observations: result.observations, transcribedChunks: result.transcribedChunks },
    });
    if (job) await emitJob(ctx.db, ctx.publisher, session, jobRunView(job));
  } catch (err) {
    const msg = sanitizeErrorMessage((err as Error).message);
    await updateSourceStatus(ctx.db, source.id, "failed", msg);
    await setState("error", `Processing failed: ${msg}`);
    await recordOpsError(ctx.db, session.broadcaster_id, "upload", msg);
    const job = await updateJobRun(ctx.db, data.jobRunId, { state: "failed", error: msg });
    if (job) await emitJob(ctx.db, ctx.publisher, session, jobRunView(job));
    // Validation failures are permanent; don't burn retries on them.
    throw Object.assign(new Error(msg), { permanent: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
