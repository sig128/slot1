import type { ChannelSettings } from "@slot1/contracts";
import type { StreamSessionRow } from "@slot1/db";

/** Who is asking. `broadcasterId` is the channel the viewer OWNS, if any. */
export interface Viewer {
  userId: string | null;
  broadcasterId: string | null;
  isOperator: boolean;
}

export const ANONYMOUS: Viewer = { userId: null, broadcasterId: null, isOperator: false };

export function isOwner(viewer: Viewer, broadcasterId: string): boolean {
  return viewer.broadcasterId !== null && viewer.broadcasterId === broadcasterId;
}

/**
 * Whether a viewer may read a session's analysis (observations, evidence, events, clips).
 * Owners always may. Everyone else only when the creator has made the channel public, enabled
 * public analysis, and the session itself is public.
 */
export function canViewSession(viewer: Viewer, session: Pick<StreamSessionRow, "broadcaster_id" | "visibility">, settings: ChannelSettings): boolean {
  if (isOwner(viewer, session.broadcaster_id)) return true;
  return settings.visibility === "public" && settings.publicAnalysis && session.visibility === "public";
}

/** Public subscribers receive sanitized payloads only. */
export function isPublicStream(session: Pick<StreamSessionRow, "visibility">, settings: ChannelSettings): boolean {
  return settings.visibility === "public" && settings.publicAnalysis && session.visibility === "public";
}
