import { z } from "zod";

/**
 * Broadcast state comes ONLY from Twitch platform data (EventSub + Helix).
 * It says nothing about whether SLOT1 can see the gameplay.
 */
export const BroadcastState = z.enum(["unknown", "live", "offline", "error"]);
export type BroadcastState = z.infer<typeof BroadcastState>;

/**
 * Analysis state describes the gameplay-analysis subsystem only.
 * `live_vision` is reachable only while real frames are arriving AND being processed.
 */
export const AnalysisState = z.enum([
  "no_source",
  "ready",
  "analyzing_clip",
  "live_vision",
  "replay",
  "delayed",
  "stale",
  "stopped",
  "error",
]);
export type AnalysisState = z.infer<typeof AnalysisState>;

/** How media physically reached SLOT1. */
export const SourceKind = z.enum(["upload", "twitch_clip", "live_ingest", "recording"]);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * What the UI must call the media. A looped recording delivered over a live transport is
 * still `test`; an upload is always `replay`. Only a creator-declared live relay is `live`.
 */
export const SourceLabel = z.enum(["replay", "test", "live", "clip"]);
export type SourceLabel = z.infer<typeof SourceLabel>;

export const SessionKind = z.enum(["twitch_broadcast", "replay", "ingest"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const ObservationOrigin = z.enum(["twitch", "video", "ocr", "audio", "user_correction"]);
export type ObservationOrigin = z.infer<typeof ObservationOrigin>;

export const Interpretation = z.enum(["directly_visible", "inferred", "unknown"]);
export type Interpretation = z.infer<typeof Interpretation>;

export const ReviewStatus = z.enum(["unreviewed", "confirmed", "corrected", "rejected"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/**
 * Observation types. Gameplay types may only be produced from real video/audio input.
 * Platform types (`stream_*`, `channel_update`) come from Twitch and never from vision.
 */
export const ObservationType = z.enum([
  // media / coverage measurements (deterministic, local)
  "session_coverage",
  "media_facts",
  "source_gap",
  "scene_transition",
  "black_screen",
  "audio_silence",
  // visible text (OCR or vision reading on-screen text)
  "visible_text",
  "objective_text",
  "mission_title",
  "subtitle",
  "result_screen",
  "hud_reading",
  "place_name",
  // visual observations (vision model)
  "vehicle",
  "vehicle_enter_exit",
  "possible_collision",
  "movement",
  "combat",
  "landmark",
  "environment",
  // audio
  "dialogue",
  "siren",
  "reaction",
  // derived
  "highlight_candidate",
  // Twitch platform facts
  "stream_online",
  "stream_offline",
  "channel_update",
]);
export type ObservationType = z.infer<typeof ObservationType>;

/** Types that describe a change over time and therefore need more than one frame. */
export const TEMPORAL_TYPES: ReadonlySet<ObservationType> = new Set([
  "vehicle_enter_exit",
  "possible_collision",
  "movement",
  "combat",
]);

export const PLATFORM_TYPES: ReadonlySet<ObservationType> = new Set([
  "stream_online",
  "stream_offline",
  "channel_update",
]);

export const Visibility = z.enum(["public", "private"]);
export type Visibility = z.infer<typeof Visibility>;

export const ClipKind = z.enum(["twitch_live", "twitch_vod", "owned_render"]);
export type ClipKind = z.infer<typeof ClipKind>;

export const ClipJobState = z.enum(["requested", "processing", "ready", "failed", "expired"]);
export type ClipJobState = z.infer<typeof ClipJobState>;

/** Download/analysis sub-state of a clip, kept separate from the clip's own existence. */
export const ClipMediaState = z.enum([
  "not_requested",
  "missing_scope",
  "queued",
  "downloading",
  "analyzing",
  "ready",
  "failed",
  "expired",
]);
export type ClipMediaState = z.infer<typeof ClipMediaState>;

export const AssetKind = z.enum([
  "original",
  "playback",
  "frame",
  "thumbnail",
  "clip",
  "export_landscape",
  "export_vertical",
  "audio_chunk",
  "recording_segment",
  "screenshot",
  "render",
  "poster",
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const JobState = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobState = z.infer<typeof JobState>;

export const CommentaryMode = z.enum(["off", "rare", "normal"]);
export type CommentaryMode = z.infer<typeof CommentaryMode>;

export const ViewerQuestionPolicy = z.enum(["off", "signed_in", "anyone"]);
export type ViewerQuestionPolicy = z.infer<typeof ViewerQuestionPolicy>;

export const ClipPermission = z.enum(["broadcaster", "approved_moderators", "moderators", "vips", "everyone"]);
export type ClipPermission = z.infer<typeof ClipPermission>;

export const BotCommandName = z.enum([
  "help",
  "status",
  "now",
  "recap",
  "clip",
  "find",
  "ask",
  "pause",
  "resume",
  "mute",
  "unmute",
  "record",
  "autoclip",
  "relay",
]);
export type BotCommandName = z.infer<typeof BotCommandName>;

/** Creator controls: only the broadcaster and approved moderators may use these in chat. */
export const PRIVILEGED_COMMANDS: ReadonlySet<BotCommandName> = new Set(["pause", "resume", "mute", "unmute", "record", "autoclip", "relay"]);
