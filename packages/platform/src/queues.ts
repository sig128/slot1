/**
 * Queue names and job payloads shared by the API (producer) and the worker (consumer).
 * Payloads carry identifiers only — never tokens, stream keys or media bytes.
 */
export const QUEUES = {
  media: "slot1-media",
  twitch: "slot1-twitch",
  chat: "slot1-chat",
  maintenance: "slot1-maintenance",
  /** Recordings, screenshots and edit renders (kept apart from upload analysis). */
  library: "slot1-library",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface MediaJobs {
  "analyze-upload": { jobRunId: string; broadcasterId: string; sessionId: string; sourceId: string };
  "render-clip": { jobRunId: string; clipJobId: string };
  "analyze-clip-media": { jobRunId: string; clipJobId: string };
}

export interface TwitchJobs {
  "create-live-clip": { clipJobId: string };
  "create-vod-clip": { clipJobId: string };
  "download-clip": { clipJobId: string };
  /** Non-secret platform data from a verified EventSub notification. */
  "eventsub-process": { messageId: string; subscriptionType: string; event: unknown };
  "eventsub-reconcile": { broadcasterId: string | null; reason: string };
  "validate-grants": Record<string, never>;
  "refresh-directory": Record<string, never>;
}

export interface ChatJobs {
  /** Only messages that start with "!" are queued; full chat logs are never stored. */
  "handle-command": { messageId: string; event: unknown };
  "post-reply": { broadcasterId: string; text: string; replyToMessageId: string | null; dedupeKey: string };
}

export interface LibraryJobs {
  "finalize-recording": { recordingId: string };
  "screenshot": { itemId: string; sessionId: string; atMs: number };
  "render-project": { itemId: string; projectId: string; jobRunId: string };
}

export interface MaintenanceJobs {
  "retention-sweep": Record<string, never>;
  "delete-session": { sessionId: string; broadcasterId: string };
  "purge-broadcaster-media": { broadcasterId: string };
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
} as const;
