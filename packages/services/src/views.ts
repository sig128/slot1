import { staleAfterMs } from "@slot1/analysis";
import type { AnalysisStatus, ClipView, MediaSourceView, MomentView, SessionSummary, SourceHealthView } from "@slot1/contracts";
import {
  getAssets,
  iso,
  isoReq,
  type AssetRow,
  type BroadcasterRow,
  type ClipJobRow,
  type JobRunRow,
  type MediaSourceRow,
  type MomentRow,
  type Queryable,
  type SourceHealthRow,
  type StreamSessionRow,
} from "@slot1/db";
import type { AppConfig, StorageDriver } from "@slot1/platform";
import { channelUrl } from "@slot1/twitch/url";

const LIVE_STATES = new Set(["live_vision", "delayed"]);

/**
 * Effective analysis status at read time. If the stored state claims live vision but frames
 * stopped arriving (e.g. the worker died), it is reported as stale — never as live.
 */
export function analysisStatus(row: StreamSessionRow, config: AppConfig, now = Date.now()): AnalysisStatus {
  const live = row.kind !== "replay";
  const threshold = live
    ? staleAfterMs({ expectedIntervalMs: row.expected_interval_ms, measuredCadenceMs: row.measured_cadence_ms, measuredDelayMs: row.measured_delay_ms })
    : null;
  let state = row.analysis_state;
  let reason = row.analysis_reason;
  const last = row.last_received_frame_at?.getTime() ?? null;
  if (live && threshold !== null && LIVE_STATES.has(state) && (last === null || now - last > threshold)) {
    state = "stale";
    reason = last === null ? "No frames received" : `No frames for ${Math.round((now - last) / 1000)}s`;
  }
  return {
    state,
    reason,
    sourceLabel: row.label,
    lastReceivedFrameAt: iso(row.last_received_frame_at),
    lastAnalyzedFrameAt: iso(row.last_analyzed_frame_at),
    lastResultAt: iso(row.last_result_at),
    measuredCadenceMs: row.measured_cadence_ms,
    measuredDelayMs: row.measured_delay_ms,
    staleAfterMs: threshold,
    visionConfigured: config.capabilities.vision.available,
  };
}

export async function signedAssetUrl(storage: StorageDriver, config: AppConfig, asset: AssetRow, ttlSeconds = config.env.MEDIA_URL_TTL_SECONDS): Promise<string> {
  return storage.signedGetUrl(asset.storage_key, ttlSeconds, asset.content_type);
}

/**
 * Video players fetch new byte ranges whenever the viewer seeks, so playback links must outlive
 * a long recording or an editing session; images keep the short default lifetime.
 */
export function playbackUrlTtl(config: AppConfig): number {
  return Math.max(config.env.MEDIA_URL_TTL_SECONDS, 6 * 3600);
}

export async function sessionSummary(
  db: Queryable,
  storage: StorageDriver,
  config: AppConfig,
  row: StreamSessionRow,
  broadcaster: BroadcasterRow,
  extras: { playbackSource: MediaSourceRow | null; job: JobRunRow | null },
): Promise<SessionSummary> {
  const now = Date.now();
  const durationMs = row.duration_ms ?? (row.kind === "replay" ? null : (row.ended_at ?? new Date()).getTime() - row.started_at.getTime());
  let playback: SessionSummary["playback"] = null;
  const src = extras.playbackSource;
  if (src?.playback_asset_id) {
    const assets = await getAssets(db, [src.playback_asset_id]);
    const pa = assets[0];
    if (pa) {
      const posterRows = await db.query<AssetRow>(
        `SELECT * FROM evidence_assets WHERE source_id = $1 AND kind = 'thumbnail' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [src.id],
      );
      const poster = posterRows.rows[0];
      playback = {
        url: await signedAssetUrl(storage, config, pa, playbackUrlTtl(config)),
        posterUrl: poster ? await signedAssetUrl(storage, config, poster) : null,
        durationMs: src.probe?.durationMs ?? null,
        width: src.probe?.width ?? null,
        height: src.probe?.height ?? null,
        fps: src.probe?.fps ?? null,
        hasAudio: src.probe?.hasAudio ?? false,
      };
    }
  }
  return {
    id: row.id,
    broadcasterId: row.broadcaster_id,
    channelLogin: broadcaster.login,
    channelDisplayName: broadcaster.display_name,
    kind: row.kind,
    label: row.label,
    title: row.title,
    startedAt: isoReq(row.started_at),
    endedAt: iso(row.ended_at),
    visibility: row.visibility,
    broadcastState: row.broadcast_state,
    analysis: analysisStatus(row, config, now),
    coverage: {
      analyzedMs: row.analyzed_ms,
      durationMs,
      ratio: durationMs && durationMs > 0 ? Math.min(1, row.analyzed_ms / durationMs) : null,
      framesAnalyzed: row.frames_analyzed,
      framesDropped: row.frames_dropped,
      gaps: row.gaps ?? [],
    },
    playback,
    processing: extras.job
      ? { state: extras.job.state, step: extras.job.step, progress: extras.job.progress, error: extras.job.error }
      : null,
  };
}

export async function clipView(db: Queryable, storage: StorageDriver, config: AppConfig, row: ClipJobRow): Promise<ClipView> {
  const ids = [row.landscape_asset_id, row.portrait_asset_id].filter((x): x is string => Boolean(x));
  const assets = await getAssets(db, ids);
  const exports: ClipView["exports"] = [];
  for (const a of assets) {
    // Only media we actually possess is exportable. A Twitch clip URL alone is not a file.
    exports.push({
      kind: a.id === row.portrait_asset_id ? "vertical" : "landscape",
      url: await signedAssetUrl(storage, config, a),
      width: a.width,
      height: a.height,
    });
  }
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    mediaState: row.media_state,
    twitchClipId: row.twitch_clip_id,
    clipUrl: row.clip_url,
    embedUrl: row.embed_url,
    thumbnailUrl: row.thumbnail_url,
    durationMs: row.duration_ms,
    sourceResolution: row.source_resolution,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestedAt: isoReq(row.requested_at),
    readyAt: iso(row.ready_at),
    expiresAt: iso(row.expires_at),
    exports,
  };
}

export function momentProcessingState(clip: ClipView | null): MomentView["processingState"] {
  if (!clip) return "evidence_only";
  switch (clip.state) {
    case "requested":
      return "queued";
    case "processing":
      return "processing";
    case "ready":
      return clip.mediaState === "downloading" || clip.mediaState === "analyzing" || clip.mediaState === "queued" ? "processing" : "ready";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
  }
}

export async function momentView(
  db: Queryable,
  storage: StorageDriver,
  config: AppConfig,
  row: MomentRow,
  clip: ClipView | null,
): Promise<MomentView> {
  let thumbnailUrl: string | null = clip?.thumbnailUrl ?? null;
  const frameId = row.observation_evidence?.find((e) => e.kind === "frame")?.assetId;
  if (frameId) {
    const [asset] = await getAssets(db, [frameId]);
    if (asset) thumbnailUrl = await signedAssetUrl(storage, config, asset);
  }
  const sourceKind =
    row.session_kind === "replay" ? "upload" : clip && clip.kind !== "owned_render" ? "twitch_clip" : row.session_kind === "ingest" ? "live_ingest" : null;
  return {
    id: row.id,
    broadcasterId: row.broadcaster_id,
    channelLogin: row.channel_login,
    channelDisplayName: row.channel_display_name,
    sessionId: row.session_id,
    sessionKind: row.session_kind,
    sessionLabel: row.session_label,
    observationId: row.observation_id,
    observationType: row.observation_type,
    title: row.title,
    note: row.note,
    mediaStartMs: row.media_start_ms,
    mediaEndMs: row.media_end_ms,
    createdAt: isoReq(row.created_at),
    thumbnailUrl,
    processingState: momentProcessingState(clip),
    clip,
    twitchUrl: row.broadcaster_kind === "twitch" ? (clip?.clipUrl ?? channelUrl(row.channel_login)) : null,
    sourceKind,
    canExport: Boolean(clip && clip.exports.length > 0),
  };
}

export function sourceHealthView(h: SourceHealthRow | null): SourceHealthView | null {
  if (!h) return null;
  return {
    state: h.state as SourceHealthView["state"],
    framesReceived: h.frames_received,
    framesAnalyzed: h.frames_analyzed,
    framesDropped: h.frames_dropped,
    lastFrameAt: iso(h.last_frame_at),
    lastAnalyzedAt: iso(h.last_analyzed_at),
    cadenceMs: h.cadence_ms,
    delayMs: h.delay_ms,
    error: h.error,
    updatedAt: isoReq(h.updated_at),
  };
}

export function sourceView(row: MediaSourceRow, health: SourceHealthRow | null, config: AppConfig): MediaSourceView {
  const p = row.probe;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    name: row.name,
    status: row.status,
    createdAt: isoReq(row.created_at),
    sessionId: row.session_id,
    probe: p
      ? {
          durationMs: p.durationMs,
          width: p.width,
          height: p.height,
          fps: p.fps,
          videoCodec: p.videoCodec,
          audioCodec: p.audioCodec,
          hasAudio: p.hasAudio,
          sizeBytes: p.sizeBytes,
        }
      : null,
    publish:
      row.kind === "live_ingest" && row.publish_path && row.status !== "revoked"
        ? {
            serverUrl: config.env.INGEST_PUBLIC_RTMP_URL ?? "(streaming to SLOT1 isn't open yet)",
            streamPath: row.publish_path,
            keyHint: row.publish_key_hint ?? "",
            protocol: "rtmp",
            whipUrl:
              config.env.INGEST_GATEWAY === "mediamtx" && config.env.INGEST_PUBLIC_WEBRTC_URL
                ? `${config.env.INGEST_PUBLIC_WEBRTC_URL.replace(/\/$/, "")}/${row.publish_path}/whip`
                : null,
            srtUrl: config.env.INGEST_GATEWAY === "mediamtx" ? config.env.INGEST_PUBLIC_SRT_URL : null,
          }
        : null,
    health: sourceHealthView(health),
    error: row.error,
  };
}
