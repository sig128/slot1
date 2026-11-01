import { z } from "zod";

/** Where SLOT1 can forward a creator's stream. Twitch uses the key from Twitch's API. */
export const RelayPlatform = z.enum(["twitch", "youtube", "kick", "custom"]);
export type RelayPlatform = z.infer<typeof RelayPlatform>;

/**
 * disabled: switched off. idle: on, but the creator isn't streaming to SLOT1 right now.
 * connecting/live/retrying: forwarding state. error: stopped until the creator fixes it.
 * needs_permission: Twitch forwarding needs the channel:read:stream_key permission.
 */
export const RelayStatus = z.enum(["disabled", "idle", "connecting", "live", "retrying", "error", "needs_permission"]);
export type RelayStatus = z.infer<typeof RelayStatus>;

export const RelayDestinationView = z.object({
  id: z.string(),
  platform: RelayPlatform,
  label: z.string(),
  enabled: z.boolean(),
  status: RelayStatus,
  statusDetail: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  /** Host only, e.g. "a.rtmps.youtube.com". Never the full URL with a key. */
  serverHost: z.string().nullable(),
  /** Last four characters of the stored key, if any. */
  keyHint: z.string().nullable(),
});
export type RelayDestinationView = z.infer<typeof RelayDestinationView>;

const Label = z.string().trim().min(1).max(40);
const StreamKey = z.string().trim().min(4).max(300);
const ServerUrl = z.string().trim().min(8).max(300);

export const CreateRelayDestinationInput = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("twitch"), label: Label.optional() }).strict(),
  z.object({ platform: z.literal("youtube"), label: Label.optional(), streamKey: StreamKey, serverUrl: ServerUrl.optional() }).strict(),
  z.object({ platform: z.literal("kick"), label: Label.optional(), streamKey: StreamKey, serverUrl: ServerUrl }).strict(),
  z.object({ platform: z.literal("custom"), label: Label, streamKey: StreamKey, serverUrl: ServerUrl }).strict(),
]);
export type CreateRelayDestinationInput = z.infer<typeof CreateRelayDestinationInput>;

export const UpdateRelayDestinationInput = z
  .object({ enabled: z.boolean(), label: Label, streamKey: StreamKey, serverUrl: ServerUrl })
  .partial()
  .strict();
export type UpdateRelayDestinationInput = z.infer<typeof UpdateRelayDestinationInput>;

export const RelayOverview = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  ingest: z.object({
    /** The one Server value creators paste into OBS ("Custom" service). */
    server: z.string().nullable(),
    sourceId: z.string().nullable(),
    keyHint: z.string().nullable(),
    publishing: z.boolean(),
  }),
  twitch: z.object({
    connected: z.boolean(),
    forwardingPermission: z.boolean(),
    permissionUrl: z.string().nullable(),
  }),
  destinations: z.array(RelayDestinationView),
  maxDestinations: z.number(),
  /** YouTube's secure (RTMPS) ingest, prefilled in the YouTube form. */
  youtubeServer: z.string(),
});
export type RelayOverview = z.infer<typeof RelayOverview>;

/** Returned once: a fresh stream key for the creator's SLOT1 ingest (only a hash is stored). */
export const IngestCredentials = z.object({ server: z.string(), streamKey: z.string(), sourceId: z.string() });
export type IngestCredentials = z.infer<typeof IngestCredentials>;
