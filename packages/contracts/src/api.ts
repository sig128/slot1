import { z } from "zod";
import {
  AnalysisState,
  AssetKind,
  BroadcastState,
  ClipJobState,
  ClipKind,
  ClipMediaState,
  ClipPermission,
  CommentaryMode,
  JobState,
  SessionKind,
  SourceKind,
  SourceLabel,
  ViewerQuestionPolicy,
  Visibility,
  BotCommandName,
} from "./enums";
import { Observation } from "./observation";

/* ----------------------------------------------------------------------------------------- */
/* Capabilities — what is genuinely configured on this deployment                             */
/* ----------------------------------------------------------------------------------------- */

export const CapabilityStatus = z.object({
  available: z.boolean(),
  /**
   * Why it's unavailable, in plain words. Only operators (and /admin sessions) get the technical
   * reason naming server settings; everyone else gets a friendly line with no internals.
   */
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  /** Operators only: the exact missing settings and the server command that fixes them. */
  setup: z.object({ missing: z.array(z.string()), command: z.string().nullable() }).nullable().optional(),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const Capabilities = z.object({
  environment: z.enum(["development", "test", "production"]),
  twitch: CapabilityStatus,
  bot: CapabilityStatus,
  eventsub: CapabilityStatus,
  vision: CapabilityStatus.extend({ provider: z.string().nullable(), model: z.string().nullable() }),
  transcription: CapabilityStatus.extend({ provider: z.string().nullable(), model: z.string().nullable() }),
  ocr: CapabilityStatus,
  storage: CapabilityStatus.extend({ driver: z.enum(["fs", "s3"]) }),
  ingest: CapabilityStatus.extend({ gateway: z.enum(["nginx-rtmp", "mediamtx"]).nullable() }),
  /** SLOT1-hosted live video over WebRTC (WHEP), only through MediaMTX. */
  liveVideo: CapabilityStatus,
  /** Forwarding a creator's SLOT1 ingest to Twitch, YouTube, Kick or a custom RTMP(S) server. */
  relay: CapabilityStatus,
  localLogin: z.boolean(),
  ps5ChatDisplay: z.literal("needs_console_verification"),
});
export type Capabilities = z.infer<typeof Capabilities>;

/* ----------------------------------------------------------------------------------------- */
/* Identity                                                                                  */
/* ----------------------------------------------------------------------------------------- */

export const BroadcasterRef = z.object({
  id: z.string(),
  login: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  kind: z.enum(["twitch", "local"]),
});
export type BroadcasterRef = z.infer<typeof BroadcasterRef>;

export const MeResponse = z.object({
  user: z
    .object({
      id: z.string(),
      displayName: z.string(),
      kind: z.enum(["twitch", "local"]),
      isOperator: z.boolean(),
    })
    .nullable(),
  broadcaster: BroadcasterRef.nullable(),
  csrfToken: z.string().nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/* ----------------------------------------------------------------------------------------- */
/* Directory & watch                                                                          */
/* ----------------------------------------------------------------------------------------- */

export const BroadcastSnapshot = z.object({
  state: BroadcastState,
  title: z.string().nullable(),
  /** User-supplied Twitch category — metadata, not proof of what the video shows. */
  category: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  /** Only present when Twitch returned it. */
  viewerCount: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
});
export type BroadcastSnapshot = z.infer<typeof BroadcastSnapshot>;

export const AnalysisStatus = z.object({
  state: AnalysisState,
  reason: z.string().nullable(),
  sourceLabel: SourceLabel.nullable(),
  lastReceivedFrameAt: z.string().nullable(),
  lastAnalyzedFrameAt: z.string().nullable(),
  lastResultAt: z.string().nullable(),
  measuredCadenceMs: z.number().nullable(),
  measuredDelayMs: z.number().nullable(),
  staleAfterMs: z.number().nullable(),
  visionConfigured: z.boolean(),
});
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

export const ChannelCard = z.object({
  broadcasterId: z.string(),
  login: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  twitchUrl: z.string(),
  broadcast: BroadcastSnapshot,
  analysis: AnalysisStatus,
  publicAnalysis: z.boolean(),
});
export type ChannelCard = z.infer<typeof ChannelCard>;

export const DirectoryResponse = z.object({
  channels: z.array(ChannelCard),
  twitchConfigured: z.boolean(),
  refreshedAt: z.string().nullable(),
});
export type DirectoryResponse = z.infer<typeof DirectoryResponse>;

export const ResolveLinkResponse = z.object({
  kind: z.enum(["channel", "clip", "video"]),
  login: z.string().nullable(),
  clipSlug: z.string().nullable(),
  videoId: z.string().nullable(),
  /** True only if the creator has connected and opted in to SLOT1. */
  slot1Authorized: z.boolean(),
  broadcasterId: z.string().nullable(),
  watchHref: z.string(),
  twitchUrl: z.string(),
  metadata: z
    .object({
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
      title: z.string().nullable(),
      category: z.string().nullable(),
      isLive: z.boolean().nullable(),
    })
    .nullable(),
  metadataUnavailableReason: z.string().nullable(),
});
export type ResolveLinkResponse = z.infer<typeof ResolveLinkResponse>;

export const PlaybackInfo = z.object({
  url: z.string(),
  posterUrl: z.string().nullable(),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  fps: z.number().nullable(),
  hasAudio: z.boolean(),
});
export type PlaybackInfo = z.infer<typeof PlaybackInfo>;

export const Coverage = z.object({
  analyzedMs: z.number(),
  durationMs: z.number().nullable(),
  ratio: z.number().nullable(),
  framesAnalyzed: z.number(),
  framesDropped: z.number(),
  gaps: z.array(z.object({ startMs: z.number(), endMs: z.number(), reason: z.string() })),
});
export type Coverage = z.infer<typeof Coverage>;

export const SessionSummary = z.object({
  id: z.string(),
  broadcasterId: z.string(),
  channelLogin: z.string(),
  channelDisplayName: z.string(),
  kind: SessionKind,
  label: SourceLabel.nullable(),
  title: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  visibility: Visibility,
  broadcastState: BroadcastState,
  analysis: AnalysisStatus,
  coverage: Coverage,
  playback: PlaybackInfo.nullable(),
  processing: z
    .object({ state: JobState, step: z.string().nullable(), progress: z.number().nullable(), error: z.string().nullable() })
    .nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const WatchChannelResponse = z.object({
  channel: ChannelCard,
  authorized: z.boolean(),
  session: SessionSummary.nullable(),
  viewer: z.object({ isCreator: z.boolean(), canAsk: z.boolean(), askPolicy: ViewerQuestionPolicy }),
  recentReplays: z.array(z.object({ id: z.string(), title: z.string().nullable(), startedAt: z.string(), label: SourceLabel.nullable() })),
});
export type WatchChannelResponse = z.infer<typeof WatchChannelResponse>;

/* ----------------------------------------------------------------------------------------- */
/* Evidence & observations                                                                    */
/* ----------------------------------------------------------------------------------------- */

export const EvidenceAssetView = z.object({
  assetId: z.string(),
  kind: AssetKind,
  url: z.string(),
  contentType: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  mediaPtsMs: z.number().nullable(),
  durationMs: z.number().nullable(),
});
export type EvidenceAssetView = z.infer<typeof EvidenceAssetView>;

export const ObservationDetail = z.object({
  observation: Observation,
  evidence: z.array(EvidenceAssetView),
  corrections: z.array(
    z.object({ id: z.string(), createdAt: z.string(), reviewStatus: z.string(), reason: z.string().nullable(), previousDescription: z.string() }),
  ),
  sessionLabel: SourceLabel.nullable(),
  sessionKind: SessionKind,
  nearbyClip: z.lazy(() => ClipView).nullable(),
  canEdit: z.boolean(),
});
export type ObservationDetail = z.infer<typeof ObservationDetail>;

export const SourceRef = z.object({
  id: z.string(),
  kind: SourceKind,
  label: SourceLabel,
  name: z.string(),
  createdAt: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const ObservationPage = z.object({
  observations: z.array(Observation),
  /** Media sources referenced by these observations (to label clip/replay/test evidence). */
  sources: z.array(SourceRef),
  lastEventId: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ObservationPage = z.infer<typeof ObservationPage>;

/* ----------------------------------------------------------------------------------------- */
/* Clips & moments                                                                            */
/* ----------------------------------------------------------------------------------------- */

export const ClipView = z.object({
  id: z.string(),
  kind: ClipKind,
  state: ClipJobState,
  mediaState: ClipMediaState,
  twitchClipId: z.string().nullable(),
  clipUrl: z.string().nullable(),
  embedUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  durationMs: z.number().nullable(),
  sourceResolution: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  requestedAt: z.string(),
  readyAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  exports: z.array(z.object({ kind: z.enum(["landscape", "vertical"]), url: z.string(), width: z.number().nullable(), height: z.number().nullable() })),
});
export type ClipView = z.infer<typeof ClipView>;

export const MomentView = z.object({
  id: z.string(),
  broadcasterId: z.string(),
  channelLogin: z.string(),
  channelDisplayName: z.string(),
  sessionId: z.string(),
  sessionKind: SessionKind,
  sessionLabel: SourceLabel.nullable(),
  observationId: z.string().nullable(),
  observationType: z.string().nullable(),
  title: z.string(),
  note: z.string().nullable(),
  mediaStartMs: z.number().nullable(),
  mediaEndMs: z.number().nullable(),
  createdAt: z.string(),
  thumbnailUrl: z.string().nullable(),
  processingState: z.enum(["queued", "processing", "ready", "failed", "expired", "evidence_only"]),
  clip: ClipView.nullable(),
  twitchUrl: z.string().nullable(),
  sourceKind: SourceKind.nullable(),
  canExport: z.boolean(),
});
export type MomentView = z.infer<typeof MomentView>;

export const MomentsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  broadcasterId: z.string().optional(),
  sessionId: z.string().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type MomentsQuery = z.infer<typeof MomentsQuery>;

export const SaveMomentInput = z.object({
  sessionId: z.string().min(1),
  observationId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
  mediaStartMs: z.number().int().nonnegative().optional(),
  mediaEndMs: z.number().int().nonnegative().optional(),
});
export type SaveMomentInput = z.infer<typeof SaveMomentInput>;

export const ClipRequestInput = z.object({
  sessionId: z.string().min(1),
  kind: ClipKind,
  momentId: z.string().optional(),
  /** Owned renders only: window around this media time. */
  centerMs: z.number().int().nonnegative().optional(),
  preRollMs: z.number().int().min(0).max(60_000).optional(),
  postRollMs: z.number().int().min(0).max(60_000).optional(),
  vertical: z.boolean().optional(),
  caption: z.string().trim().max(90).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type ClipRequestInput = z.infer<typeof ClipRequestInput>;

/* ----------------------------------------------------------------------------------------- */
/* Studio                                                                                     */
/* ----------------------------------------------------------------------------------------- */

export const ChannelSettings = z.object({
  visibility: Visibility,
  directoryOptIn: z.boolean(),
  publicAnalysis: z.boolean(),
  viewerQuestions: ViewerQuestionPolicy,
  botEnabled: z.boolean(),
  botKilled: z.boolean(),
  commentaryMode: CommentaryMode,
  commentaryMuted: z.boolean(),
  allowedCommands: z.array(BotCommandName),
  shortAliasesEnabled: z.boolean(),
  clipPermission: ClipPermission,
  approvedModeratorIds: z.array(z.string()),
  userCooldownSec: z.number().int(),
  channelCooldownSec: z.number().int(),
  agentEnabled: z.boolean(),
  analysisPaused: z.boolean(),
  recordingConsent: z.boolean(),
  rollingBufferEnabled: z.boolean(),
  rollingBufferSeconds: z.number().int(),
  retentionDays: z.number().int(),
  sampleIntervalMs: z.number().int(),
  maxVisionCallsPerHour: z.number().int(),
  gameProfile: z.enum(["generic", "gta5"]),
  /** Creator opted in to letting SLOT1 keep frames from their streams to train the GTA model. */
  trainingConsent: z.boolean(),
  recordingEnabled: z.boolean(),
  recordingRetentionDays: z.number().int(),
  autoClips: z.boolean(),
  autoClipPreRollMs: z.number().int(),
  autoClipPostRollMs: z.number().int(),
  /** Opt-in bot announcements in chat ("SLOT1 is watching", auto-clip ready). */
  chatAnnouncements: z.boolean(),
});
export type ChannelSettings = z.infer<typeof ChannelSettings>;

export const ChannelSettingsPatch = z
  .object({
    visibility: Visibility,
    directoryOptIn: z.boolean(),
    publicAnalysis: z.boolean(),
    viewerQuestions: ViewerQuestionPolicy,
    botEnabled: z.boolean(),
    botKilled: z.boolean(),
    commentaryMode: CommentaryMode,
    commentaryMuted: z.boolean(),
    allowedCommands: z.array(BotCommandName).max(20),
    shortAliasesEnabled: z.boolean(),
    clipPermission: ClipPermission,
    approvedModeratorIds: z.array(z.string().regex(/^\d{1,20}$/)).max(50),
    userCooldownSec: z.number().int().min(5).max(600),
    channelCooldownSec: z.number().int().min(2).max(300),
    analysisPaused: z.boolean(),
    recordingConsent: z.boolean(),
    rollingBufferEnabled: z.boolean(),
    rollingBufferSeconds: z.number().int().min(30).max(900),
    retentionDays: z.number().int().min(1).max(365),
    sampleIntervalMs: z.number().int().min(1000).max(60_000),
    maxVisionCallsPerHour: z.number().int().min(0).max(3600),
    gameProfile: z.enum(["generic", "gta5"]),
    trainingConsent: z.boolean(),
    recordingEnabled: z.boolean(),
    recordingRetentionDays: z.number().int().min(1).max(365),
    autoClips: z.boolean(),
    autoClipPreRollMs: z.number().int().min(0).max(60_000),
    autoClipPostRollMs: z.number().int().min(1000).max(60_000),
    chatAnnouncements: z.boolean(),
  })
  .partial()
  .strict();
export type ChannelSettingsPatch = z.infer<typeof ChannelSettingsPatch>;

export const ReadinessStepId = z.enum(["twitch_connected", "bot_ready", "clip_permissions_ready", "video_source_ready", "agent_enabled"]);
export type ReadinessStepId = z.infer<typeof ReadinessStepId>;

export const ReadinessStep = z.object({
  id: ReadinessStepId,
  label: z.string(),
  status: z.enum(["done", "todo", "blocked", "unavailable"]),
  detail: z.string(),
  action: z
    .object({ label: z.string(), kind: z.enum(["link", "action"]), href: z.string().nullable(), actionId: z.string().nullable() })
    .nullable(),
});
export type ReadinessStep = z.infer<typeof ReadinessStep>;

export const SourceHealthView = z.object({
  state: AnalysisState,
  framesReceived: z.number(),
  framesAnalyzed: z.number(),
  framesDropped: z.number(),
  lastFrameAt: z.string().nullable(),
  lastAnalyzedAt: z.string().nullable(),
  cadenceMs: z.number().nullable(),
  delayMs: z.number().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});
export type SourceHealthView = z.infer<typeof SourceHealthView>;

export const MediaSourceView = z.object({
  id: z.string(),
  kind: SourceKind,
  label: SourceLabel,
  name: z.string(),
  status: z.enum(["pending", "processing", "ready", "awaiting_publisher", "publishing", "idle", "revoked", "failed", "deleted"]),
  createdAt: z.string(),
  sessionId: z.string().nullable(),
  probe: z
    .object({
      durationMs: z.number().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      fps: z.number().nullable(),
      videoCodec: z.string().nullable(),
      audioCodec: z.string().nullable(),
      hasAudio: z.boolean(),
      sizeBytes: z.number().nullable(),
    })
    .nullable(),
  publish: z
    .object({
      serverUrl: z.string(),
      streamPath: z.string(),
      keyHint: z.string(),
      protocol: z.string(),
      /** OBS 30+ WHIP server URL (WebRTC, lowest delay). Bearer token = the stream key. MediaMTX only. */
      whipUrl: z.string().nullable().optional(),
      /** SRT address without the passphrase part. MediaMTX only. */
      srtUrl: z.string().nullable().optional(),
    })
    .nullable(),
  health: SourceHealthView.nullable(),
  error: z.string().nullable(),
});
export type MediaSourceView = z.infer<typeof MediaSourceView>;

export const JobView = z.object({
  id: z.string(),
  queue: z.string(),
  name: z.string(),
  state: JobState,
  step: z.string().nullable(),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JobView = z.infer<typeof JobView>;

export const UsageView = z.object({
  periodStart: z.string(),
  visionCalls: z.number(),
  framesAnalyzed: z.number(),
  audioSeconds: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  estimatedCostUsd: z.number().nullable(),
  costBasis: z.string(),
  maxVisionCallsPerHour: z.number(),
  visionCallsLastHour: z.number(),
});
export type UsageView = z.infer<typeof UsageView>;

export const StudioOverview = z.object({
  broadcaster: BroadcasterRef,
  twitch: z.object({
    linked: z.boolean(),
    login: z.string().nullable(),
    scopes: z.array(z.string()),
    /** Creator scopes "Connect my Twitch" asks for that this grant doesn't have (older connections). */
    missingScopes: z.array(z.string()).default([]),
    grantStatus: z.enum(["active", "refresh_failed", "revoked", "missing"]),
    lastValidatedAt: z.string().nullable(),
  }),
  readiness: z.array(ReadinessStep),
  settings: ChannelSettings,
  sources: z.array(MediaSourceView),
  currentSession: SessionSummary.nullable(),
  lastFrame: z.object({ url: z.string(), receivedAt: z.string(), mediaPtsMs: z.number().nullable(), sessionId: z.string() }).nullable(),
  jobs: z.array(JobView),
  usage: UsageView,
  recentErrors: z.array(z.object({ at: z.string(), scope: z.string(), message: z.string() })),
  sessions: z.array(z.object({ id: z.string(), kind: SessionKind, label: SourceLabel.nullable(), title: z.string().nullable(), startedAt: z.string(), visibility: Visibility })),
});
export type StudioOverview = z.infer<typeof StudioOverview>;

export const CreateIngestSourceInput = z.object({
  name: z.string().trim().min(1).max(60),
  /** Declared by the creator. A looped recording must be declared as `test`. */
  label: z.enum(["live", "test"]),
});
export type CreateIngestSourceInput = z.infer<typeof CreateIngestSourceInput>;

export const CreateIngestSourceResponse = z.object({
  source: MediaSourceView,
  /** Shown exactly once. Only a hash is stored. */
  streamKey: z.string(),
  publishUrl: z.string(),
  /** WebRTC publishing for OBS 30+ (Service: WHIP). The bearer token is the stream key secret. */
  whip: z.object({ url: z.string(), bearerToken: z.string() }).nullable().optional(),
  /** SRT publishing URL including its credentials (shown once). */
  srt: z.object({ url: z.string() }).nullable().optional(),
});
export type CreateIngestSourceResponse = z.infer<typeof CreateIngestSourceResponse>;

/** Short-lived permission to play a session's live video over WebRTC (WHEP). */
export const LiveVideoResponse = z.object({
  available: z.boolean(),
  /** Why the live video can't be played (when unavailable). */
  reason: z.string().nullable(),
  whepUrl: z.string().nullable(),
  /** Bearer token for the WHEP request. Expires quickly; fetch a new one to reconnect. */
  token: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type LiveVideoResponse = z.infer<typeof LiveVideoResponse>;

export const AskInput = z.object({ question: z.string().trim().min(2).max(300) });
export type AskInput = z.infer<typeof AskInput>;

export const AskResponse = z.object({
  answer: z.string(),
  notObserved: z.boolean(),
  citations: z.array(z.object({ observationId: z.string(), mediaStartMs: z.number().nullable(), description: z.string(), type: z.string() })),
  mode: z.enum(["model", "retrieval"]),
  freshness: z.object({ lastObservationAgeMs: z.number().nullable(), stale: z.boolean() }),
});
export type AskResponse = z.infer<typeof AskResponse>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), requirement: z.string().nullable().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;
