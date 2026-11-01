import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { findCaptionFont, probeFile, renderLandscapeClip, renderVerticalClip, runChecked } from "@slot1/analysis";
import {
  createClipSource,
  getAsset,
  getBroadcaster,
  getClipJob,
  getMoment,
  getSession,
  getSettings,
  insertAsset,
  listSources,
  recordOpsError,
  setAnalysisState,
  setClipMediaState,
  transitionClipJob,
  updateSourceStatus,
  type ClipJobRow,
  type StreamSessionRow,
  upsertLibraryItemForClipJob,
} from "@slot1/db";
import { QUEUES, sanitizeErrorMessage, storageKeys } from "@slot1/platform";
import {
  analysisStatus,
  clipView,
  emitAnalysisStatus,
  emitClip,
  GrantUnavailableError,
  TwitchNotConfiguredError,
  withUserToken,
  type ServerContext,
} from "@slot1/services";
import { HelixError, missingScopes, BROADCASTER_CLIP_ANALYSIS_SCOPES } from "@slot1/twitch";
import { analyzeMediaFile } from "../analyze-file";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function publish(ctx: ServerContext, row: ClipJobRow | null) {
  if (!row) return;
  // Ready clips (Twitch or rendered) also appear in the creator's library.
  if (row.state === "ready") await upsertLibraryItemForClipJob(ctx.db, row).catch(() => undefined);
  const session = await getSession(ctx.db, row.session_id);
  if (session) await emitClip(ctx.db, ctx.publisher, session, await clipView(ctx.db, ctx.storage, ctx.config, row));
}

async function fail(ctx: ServerContext, job: ClipJobRow, code: string, message: string) {
  const row = await transitionClipJob(ctx.db, job.id, "failed", { errorCode: code, errorMessage: message });
  await publish(ctx, row);
  await recordOpsError(ctx.db, job.broadcaster_id, "clips", `${code}: ${message}`);
  if (job.request_source === "chat") await chatNotice(ctx, job.broadcaster_id, `Clip failed: ${message}`, `clipfail:${job.id}`);
}

async function chatNotice(ctx: ServerContext, broadcasterId: string, text: string, dedupeKey: string) {
  await ctx.enqueue(QUEUES.chat, "post-reply", { broadcasterId, text, replyToMessageId: null, dedupeKey }, { jobId: `reply-${dedupeKey}` });
}

function mapHelixError(err: unknown): { code: string; message: string } {
  if (err instanceof GrantUnavailableError) return { code: "missing_auth", message: `${err.message}. ${err.requirement}.` };
  if (err instanceof TwitchNotConfiguredError) return { code: "twitch_not_configured", message: err.requirement };
  if (err instanceof HelixError) {
    if (err.status === 401) return { code: "missing_scope", message: "Twitch rejected the token or scope — reconnect Twitch in Studio" };
    if (err.status === 403) return { code: "clips_disabled", message: "Twitch refused the clip — clipping may be disabled or restricted on this channel" };
    if (err.status === 404) return { code: "not_live", message: "The channel isn't live on Twitch right now" };
    if (err.status === 429) return { code: "rate_limited", message: "Twitch rate limit reached — try again shortly" };
    return { code: "twitch_error", message: `Twitch error ${err.status}` };
  }
  return { code: "error", message: sanitizeErrorMessage((err as Error).message) };
}

/**
 * Poll Get Clips for a newly created clip. Per Twitch's clips guide: if Get Clips hasn't
 * returned the clip after 15 seconds, assume creation failed. No link is ever shown before then.
 */
async function pollUntilAvailable(ctx: ServerContext, job: ClipJobRow, twitchUserId: string, clipId: string): Promise<boolean> {
  const helix = ctx.helix!;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const clips = await withUserToken(ctx, "broadcaster", twitchUserId, (t) => helix.getClips(t, [clipId]));
    const c = clips[0];
    if (c) {
      const row = await transitionClipJob(ctx.db, job.id, "ready", {
        clipUrl: c.url,
        embedUrl: c.embed_url,
        thumbnailUrl: c.thumbnail_url,
        durationMs: Math.round(c.duration * 1000),
      });
      await publish(ctx, row);
      if (job.request_source === "chat") await chatNotice(ctx, job.broadcaster_id, `Clip ready: ${c.url}`, `clipready:${job.id}`);
      return true;
    }
  }
  await fail(ctx, job, "not_available", "Twitch didn't confirm the clip within 15 seconds, so it was treated as failed");
  return false;
}

async function afterReady(ctx: ServerContext, job: ClipJobRow, scopes: string[]) {
  const missing = missingScopes(scopes, BROADCASTER_CLIP_ANALYSIS_SCOPES);
  if (missing.length > 0) {
    // The clip exists and its link works; only analysis is unavailable.
    const row = await setClipMediaState(ctx.db, job.id, "missing_scope", { errorMessage: `Clip analysis needs the ${missing.join(", ")} permission — reconnect Twitch with clip analysis enabled` });
    await publish(ctx, row);
    return;
  }
  const row = await setClipMediaState(ctx.db, job.id, "queued");
  await publish(ctx, row);
  await ctx.enqueue(QUEUES.twitch, "download-clip", { clipJobId: job.id }, { jobId: `download-${job.id}` });
}

export async function createLiveClip(ctx: ServerContext, data: { clipJobId: string }) {
  const job = await getClipJob(ctx.db, data.clipJobId);
  if (!job || job.state !== "requested" || job.kind !== "twitch_live") return;
  const b = await getBroadcaster(ctx.db, job.broadcaster_id);
  if (!b?.twitch_user_id) return fail(ctx, job, "not_twitch", "This channel isn't connected to Twitch");
  if (!ctx.helix) return fail(ctx, job, "twitch_not_configured", ctx.config.capabilities.twitch.reason ?? "Twitch not configured");
  const processing = await transitionClipJob(ctx.db, job.id, "processing");
  await publish(ctx, processing);
  try {
    const helix = ctx.helix;
    const { created, scopes } = await withUserToken(ctx, "broadcaster", b.twitch_user_id, async (t, grant) => {
      if (!grant.scopes.includes("clips:edit")) throw new HelixError("missing clips:edit", 401, "clips");
      return { created: await helix.createClip(t, b.twitch_user_id!, false), scopes: grant.scopes };
    });
    await ctx.db.query(`UPDATE clip_jobs SET twitch_clip_id = $2, edit_url = $3, updated_at = now() WHERE id = $1`, [job.id, created.id, created.edit_url]);
    const fresh = (await getClipJob(ctx.db, job.id))!;
    if (await pollUntilAvailable(ctx, fresh, b.twitch_user_id, created.id)) await afterReady(ctx, fresh, scopes);
  } catch (err) {
    const { code, message } = mapHelixError(err);
    await fail(ctx, (await getClipJob(ctx.db, job.id))!, code, message);
  }
}

/** Authorized VOD clipping: Create Clip From VOD for a past moment of a Twitch broadcast. */
export async function createVodClip(ctx: ServerContext, data: { clipJobId: string }) {
  const job = await getClipJob(ctx.db, data.clipJobId);
  if (!job || job.state !== "requested" || job.kind !== "twitch_vod") return;
  const b = await getBroadcaster(ctx.db, job.broadcaster_id);
  const session = await getSession(ctx.db, job.session_id);
  if (!b?.twitch_user_id || !session?.twitch_stream_id) return fail(ctx, job, "no_vod", "VOD clips need a Twitch broadcast session with a saved VOD");
  if (!ctx.helix) return fail(ctx, job, "twitch_not_configured", ctx.config.capabilities.twitch.reason ?? "Twitch not configured");
  await publish(ctx, await transitionClipJob(ctx.db, job.id, "processing"));
  try {
    const helix = ctx.helix;
    const twitchId = b.twitch_user_id;
    const { created, scopes } = await withUserToken(ctx, "broadcaster", twitchId, async (t, grant) => {
      if (!grant.scopes.includes("channel:manage:clips")) throw new HelixError("missing channel:manage:clips", 401, "videos/clips");
      const videos = await helix.getArchiveVideos(t, twitchId, 10);
      const vod = videos.find((v) => v.stream_id === session.twitch_stream_id);
      if (!vod) throw Object.assign(new Error("No archived VOD found for this broadcast (VODs may be disabled or still processing)"), { code: "no_vod" });
      if (job.vod_offset_sec === null) throw Object.assign(new Error("No VOD offset recorded for this moment"), { code: "no_offset" });
      const durationSec = Math.min(60, Math.max(5, (job.duration_ms ?? 30_000) / 1000));
      const moment = job.moment_id ? await getMoment(ctx.db, job.moment_id) : null;
      return {
        created: await helix.createClipFromVod(t, {
          editorId: twitchId,
          broadcasterId: twitchId,
          vodId: vod.id,
          vodOffsetSec: job.vod_offset_sec,
          durationSec,
          title: moment?.title ?? "SLOT1 moment",
        }),
        scopes: grant.scopes,
      };
    });
    await ctx.db.query(`UPDATE clip_jobs SET twitch_clip_id = $2, edit_url = $3, updated_at = now() WHERE id = $1`, [job.id, created.id, created.edit_url]);
    const fresh = (await getClipJob(ctx.db, job.id))!;
    if (await pollUntilAvailable(ctx, fresh, twitchId, created.id)) await afterReady(ctx, fresh, scopes);
  } catch (err) {
    const e = err as Error & { code?: string };
    const mapped = e.code ? { code: e.code, message: e.message } : mapHelixError(err);
    await fail(ctx, (await getClipJob(ctx.db, job.id))!, mapped.code, mapped.message);
  }
}

const DEFAULT_DOWNLOAD_HOSTS = ["twitch.tv", "twitchcdn.net", "ttvnw.net", "jtvnw.net"];

function allowedDownloadHost(url: string, extra: string | undefined): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const hosts = [...DEFAULT_DOWNLOAD_HOSTS, ...(extra ? extra.split(",").map((h) => h.trim()).filter(Boolean) : [])];
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

/** Download the real clip media with Get Clips Download (needs channel:manage:clips) and analyze it. */
export async function downloadAndAnalyzeClip(ctx: ServerContext, data: { clipJobId: string }) {
  const job = await getClipJob(ctx.db, data.clipJobId);
  if (!job || job.state !== "ready" || !job.twitch_clip_id) return;
  const b = await getBroadcaster(ctx.db, job.broadcaster_id);
  const session = await getSession(ctx.db, job.session_id);
  if (!b?.twitch_user_id || !session || !ctx.helix) return;
  const helix = ctx.helix;
  const work = await mkdtemp(path.join(tmpdir(), "slot1-clip-"));
  let previousState: StreamSessionRow["analysis_state"] = session.analysis_state;
  try {
    await publish(ctx, await setClipMediaState(ctx.db, job.id, "downloading"));
    const downloads = await withUserToken(ctx, "broadcaster", b.twitch_user_id, (t) =>
      helix.getClipsDownload(t, { editorId: b.twitch_user_id!, broadcasterId: b.twitch_user_id!, clipIds: [job.twitch_clip_id!] }),
    );
    const url = downloads[0]?.landscape_download_url;
    if (!url) {
      await publish(ctx, await setClipMediaState(ctx.db, job.id, "failed", { errorMessage: "Twitch did not provide a download URL for this clip" }));
      return;
    }
    if (!allowedDownloadHost(url, process.env.TWITCH_CLIP_DOWNLOAD_HOSTS)) {
      await publish(ctx, await setClipMediaState(ctx.db, job.id, "failed", { errorMessage: "Download URL host is not on the allowlist (TWITCH_CLIP_DOWNLOAD_HOSTS)" }));
      return;
    }
    const file = path.join(work, "clip.mp4");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
      // Download URLs are short-lived; an expired one is reported as such.
      const expired = res.status === 403 || res.status === 404 || res.status === 410;
      await publish(ctx, await setClipMediaState(ctx.db, job.id, expired ? "expired" : "failed", { errorMessage: `Clip download failed (${res.status})` }));
      return;
    }
    const max = 512 * 1024 * 1024;
    let bytes = 0;
    const limited = Readable.fromWeb(res.body as never).on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > max) limited.destroy(new Error("Clip download exceeded 512 MB"));
    });
    await streamPipeline(limited, createWriteStream(file));
    const size = (await stat(file)).size;

    const source = await createClipSource(ctx.db, session.broadcaster_id, session.id, `Twitch clip ${job.twitch_clip_id}`);
    const key = storageKeys.clip(session.broadcaster_id, session.id, job.id, "twitch-original");
    await ctx.storage.putFile(key, file, "video/mp4");
    const probe = await probeFile(ctx.tools, file);
    const asset = await insertAsset(ctx.db, {
      broadcasterId: session.broadcaster_id,
      sessionId: session.id,
      sourceId: source.id,
      kind: "clip",
      storageKey: key,
      contentType: "video/mp4",
      bytes: size,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      durationMs: probe.durationMs,
    });
    await ctx.db.query(`UPDATE media_sources SET original_asset_id = $2, playback_asset_id = $2 WHERE id = $1`, [source.id, asset.id]);
    await ctx.db.query(`UPDATE clip_jobs SET landscape_asset_id = $2, source_resolution = $3, updated_at = now() WHERE id = $1`, [
      job.id,
      asset.id,
      probe.video ? `${probe.video.width}×${probe.video.height}` : null,
    ]);
    await publish(ctx, await setClipMediaState(ctx.db, job.id, "analyzing"));
    previousState = session.analysis_state;
    const analyzing = await setAnalysisState(ctx.db, session.id, "analyzing_clip", "Analyzing a downloaded Twitch clip");
    if (analyzing) await emitAnalysisStatus(ctx.db, ctx.publisher, analyzing, analysisStatus(analyzing, ctx.config));
    const settings = await getSettings(ctx.db, session.broadcaster_id);
    const result = await analyzeMediaFile(ctx, { session, source, file, settings, onProgress: async () => undefined });
    await updateSourceStatus(ctx.db, source.id, "ready");
    await publish(ctx, await setClipMediaState(ctx.db, job.id, "ready"));
    ctx.log.info({ clip: job.id, observations: result.observations }, "clip analyzed");
  } catch (err) {
    const { message } = mapHelixError(err);
    await publish(ctx, await setClipMediaState(ctx.db, job.id, "failed", { errorMessage: message }));
    await recordOpsError(ctx.db, job.broadcaster_id, "clip-analysis", message);
  } finally {
    // Return the session to its own state (e.g. chat-only) once the clip is done.
    const current = await getSession(ctx.db, job.session_id);
    if (current?.analysis_state === "analyzing_clip") {
      const restore = previousState === "analyzing_clip" ? "no_source" : previousState;
      const row = await setAnalysisState(ctx.db, current.id, restore, restore === "no_source" ? "No authorized video source — chat and clips only" : current.analysis_reason);
      if (row) await emitAnalysisStatus(ctx.db, ctx.publisher, row, analysisStatus(row, ctx.config));
    }
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Render a clip from media we actually possess (an uploaded replay or the live rolling buffer):
 * a clean landscape version at source resolution and, when asked, a vertical 9:16 layout that
 * keeps the full frame visible with an optional caption.
 */
export async function renderOwnedClip(ctx: ServerContext, data: { clipJobId: string }) {
  const job = await getClipJob(ctx.db, data.clipJobId);
  if (!job || job.state !== "requested" || job.kind !== "owned_render") return;
  const session = await getSession(ctx.db, job.session_id);
  if (!session) return;
  await publish(ctx, await transitionClipJob(ctx.db, job.id, "processing", { mediaState: "queued" }));
  const work = await mkdtemp(path.join(tmpdir(), "slot1-render-"));
  try {
    const sources = await listSources(ctx.db, session.broadcaster_id);
    // An uploaded replay or a finalized live recording (both are stored MP4 files).
    const src = sources.find((s) => s.session_id === session.id && (s.kind === "upload" || s.kind === "recording") && s.original_asset_id);
    let input: string;
    let demuxer = "mov";
    if (src?.original_asset_id) {
      const original = await getAsset(ctx.db, src.original_asset_id);
      if (!original) throw new Error("The original recording is no longer stored (retention may have removed it)");
      input = path.join(work, `in${path.extname(original.storage_key) || ".mp4"}`);
      await ctx.storage.downloadToFile(original.storage_key, input);
      demuxer = (await probeFile(ctx.tools, input)).demuxer;
    } else {
      input = await assembleFromRollingBuffer(ctx, session, job, work);
      demuxer = "mpegts";
    }
    const probe = await probeFile(ctx.tools, input);
    const duration = probe.durationMs ?? 0;
    const center = Math.min(job.center_ms ?? 0, Math.max(0, duration - 1));
    const start = Math.max(0, center - (job.pre_roll_ms ?? 8000));
    const end = Math.min(duration, center + (job.post_roll_ms ?? 8000));
    if (end - start < 1000) throw new Error("The requested window is too short");
    const resolution = probe.video ? `${probe.video.width}×${probe.video.height}` : null;

    const landscape = path.join(work, "landscape.mp4");
    await renderLandscapeClip(ctx.tools, input, demuxer, start, end, landscape);
    const lKey = storageKeys.clip(session.broadcaster_id, session.id, job.id, "landscape");
    const l = await ctx.storage.putFile(lKey, landscape, "video/mp4");
    const lAsset = await insertAsset(ctx.db, {
      broadcasterId: session.broadcaster_id,
      sessionId: session.id,
      sourceId: src?.id ?? null,
      kind: "export_landscape",
      storageKey: lKey,
      contentType: "video/mp4",
      bytes: l.bytes,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      durationMs: end - start,
      mediaPtsMs: start,
    });
    let portraitId: string | undefined;
    let note: string | null = null;
    if (job.vertical) {
      const vertical = path.join(work, "vertical.mp4");
      const font = findCaptionFont();
      const r = await renderVerticalClip(ctx.tools, input, demuxer, start, end, vertical, job.caption, font);
      if (job.caption && !r.captioned) note = "Caption skipped: no caption font available on the worker";
      const vKey = storageKeys.clip(session.broadcaster_id, session.id, job.id, "vertical");
      const v = await ctx.storage.putFile(vKey, vertical, "video/mp4");
      const vAsset = await insertAsset(ctx.db, {
        broadcasterId: session.broadcaster_id,
        sessionId: session.id,
        sourceId: src?.id ?? null,
        kind: "export_vertical",
        storageKey: vKey,
        contentType: "video/mp4",
        bytes: v.bytes,
        width: 1080,
        height: 1920,
        durationMs: end - start,
        mediaPtsMs: start,
      });
      portraitId = vAsset.id;
    }
    const row = await transitionClipJob(ctx.db, job.id, "ready", {
      mediaState: "ready",
      landscapeAssetId: lAsset.id,
      ...(portraitId ? { portraitAssetId: portraitId } : {}),
      durationMs: end - start,
      ...(resolution ? { sourceResolution: resolution } : {}),
      errorCode: null,
      errorMessage: note,
    });
    await publish(ctx, row);
  } catch (err) {
    await fail(ctx, (await getClipJob(ctx.db, job.id))!, "render_failed", sanitizeErrorMessage((err as Error).message));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Concatenate rolling-buffer segments covering the requested window (live ingest only). */
async function assembleFromRollingBuffer(ctx: ServerContext, session: StreamSessionRow, job: ClipJobRow, work: string): Promise<string> {
  const sources = await listSources(ctx.db, session.broadcaster_id);
  const live = sources.find((s) => s.session_id === session.id && s.kind === "live_ingest");
  const settings = await getSettings(ctx.db, session.broadcaster_id);
  if (!live || !settings.rollingBufferEnabled || !settings.recordingConsent) {
    throw new Error("No media to render: this session has no stored recording and the rolling buffer is off");
  }
  const dir = path.resolve(ctx.config.env.INGEST_SEGMENT_DIR, live.id);
  let csv: string;
  try {
    csv = await readFile(path.join(dir, "segments.csv"), "utf8");
  } catch {
    throw new Error("Rolling buffer is empty");
  }
  const center = job.center_ms ?? 0;
  const from = center - (job.pre_roll_ms ?? 8000);
  const to = center + (job.post_roll_ms ?? 8000);
  const latest = new Map<string, { start: number; end: number }>();
  for (const line of csv.trim().split(/\r?\n/)) {
    const [name, s, e] = line.split(",");
    if (!name || !/^seg\d{4}\.ts$/.test(name)) continue;
    latest.set(name, { start: Number(s) * 1000, end: Number(e) * 1000 });
  }
  const parts = [...latest.entries()].filter(([, r]) => r.end >= from && r.start <= to).sort((a, b) => a[1].start - b[1].start);
  if (parts.length === 0) throw new Error("That moment is no longer in the rolling buffer");
  const list = path.join(work, "concat.txt");
  await writeFile(list, parts.map(([n]) => `file '${path.join(dir, n)}'`).join("\n"));
  const out = path.join(work, "window.ts");
  await runChecked(ctx.tools.ffmpeg, ["-hide_banner", "-nostdin", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file", "-i", list, "-c", "copy", "-y", out], {
    timeoutMs: 120_000,
  });
  // Shift the job window to be relative to the assembled file.
  const offset = parts[0]![1].start;
  await ctx.db.query(`UPDATE clip_jobs SET center_ms = $2 WHERE id = $1`, [job.id, Math.max(0, center - offset)]);
  job.center_ms = Math.max(0, center - offset);
  return out;
}
