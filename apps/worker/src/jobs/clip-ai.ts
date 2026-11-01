import { UnrecoverableError } from "bullmq";
import { runChecked } from "@slot1/analysis";
import { sanitizeErrorMessage, type StorageDriver } from "@slot1/platform";
import { parseRmsLines, rmsArgs, setAudioAnalysis, storedMediaInfo, type ServerContext } from "@slot1/services";

/** A local path for fs storage (ffmpeg reads in place) or a signed URL for S3. */
async function readable(storage: StorageDriver, key: string, contentType: string): Promise<string> {
  const local = (storage as StorageDriver & { localPath?: (k: string) => string }).localPath;
  return local ? local.call(storage, key) : storage.signedGetUrl(key, 3600, contentType);
}

/**
 * AI clip tools: measure the loudness of a session's stored video, one RMS level per second.
 * Used to rank loud moments and to find silence worth cutting. Runs once per stored file.
 */
export async function analyzeClipAudio(ctx: ServerContext, data: { sessionId: string }): Promise<void> {
  const { rows } = await ctx.db.query<{ status: string }>(`SELECT status FROM clip_ai_audio WHERE session_id = $1`, [data.sessionId]);
  if (!rows[0] || rows[0].status === "ready") return;
  const media = await storedMediaInfo(ctx, data.sessionId);
  if (!media) {
    await setAudioAnalysis(ctx, data.sessionId, { status: "failed", error: "This session has no stored video any more" });
    return;
  }
  await setAudioAnalysis(ctx, data.sessionId, { status: "running", assetId: media.assetId });
  try {
    const input = await readable(ctx.storage, media.storageKey, media.contentType);
    const res = await runChecked(ctx.tools.ffmpeg, rmsArgs(input, /^https?:\/\//.test(input)), { timeoutMs: ctx.tools.timeoutMs, maxStdoutBytes: 8 * 1024 * 1024 });
    const rms = parseRmsLines(res.stdout.toString("utf8"));
    if (rms.length === 0) throw new UnrecoverableError("No audio could be measured in this video");
    await setAudioAnalysis(ctx, data.sessionId, { status: "ready", assetId: media.assetId, rmsDb: rms, durationMs: rms.length * 1000, error: null });
  } catch (err) {
    await setAudioAnalysis(ctx, data.sessionId, { status: "failed", error: sanitizeErrorMessage((err as Error).message).slice(0, 300) });
    if (!(err instanceof UnrecoverableError)) throw err;
  }
}
