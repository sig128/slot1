import type { AnalysisStatus, ClipView, JobView, Observation, SourceHealthView } from "@slot1/contracts";
import { appendSessionEvent, getSettings, type Publisher, type Queryable, type StoredEvent, type StreamSessionRow } from "@slot1/db";
import { isPublicStream } from "./access";

/**
 * Public subscribers get sanitized payloads: no internal error detail, no model/provider
 * internals beyond the version label, no reviewer identity.
 */
export function publicObservation(o: Observation): Observation {
  return { ...o };
}

function publicStatus(s: AnalysisStatus): AnalysisStatus {
  const generic: Record<string, string> = {
    error: "Analysis unavailable",
    stale: s.reason?.startsWith("No frames") ? s.reason : "Video source stopped sending frames",
  };
  return { ...s, reason: generic[s.state] ?? s.reason };
}

async function publicAllowed(db: Queryable, session: Pick<StreamSessionRow, "broadcaster_id" | "visibility">) {
  return isPublicStream(session, await getSettings(db, session.broadcaster_id));
}

export async function emitObservation(
  db: Queryable,
  publisher: Publisher | null,
  session: Pick<StreamSessionRow, "id" | "broadcaster_id" | "visibility">,
  o: Observation,
  kind: "observation.created" | "observation.updated" = "observation.created",
): Promise<StoredEvent> {
  const pub = (await publicAllowed(db, session)) && o.reviewStatus !== "rejected" ? publicObservation(o) : null;
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind, payload: o, publicPayload: pub });
}

export async function emitAnalysisStatus(
  db: Queryable,
  publisher: Publisher | null,
  session: Pick<StreamSessionRow, "id" | "broadcaster_id" | "visibility">,
  status: AnalysisStatus,
) {
  const pub = (await publicAllowed(db, session)) ? publicStatus(status) : null;
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind: "analysis.status", payload: status, publicPayload: pub });
}

export async function emitSourceHealth(
  db: Queryable,
  publisher: Publisher | null,
  session: Pick<StreamSessionRow, "id" | "broadcaster_id" | "visibility">,
  health: SourceHealthView,
) {
  const pub = (await publicAllowed(db, session)) ? { ...health, error: health.error ? "Source error" : null } : null;
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind: "source.health", payload: health, publicPayload: pub });
}

export async function emitBroadcastStatus(
  db: Queryable,
  publisher: Publisher | null,
  session: Pick<StreamSessionRow, "id" | "broadcaster_id" | "visibility">,
  data: { state: "unknown" | "live" | "offline" | "error"; title: string | null; category: string | null },
) {
  const pub = (await publicAllowed(db, session)) ? data : null;
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind: "broadcast.status", payload: data, publicPayload: pub });
}

export async function emitClip(db: Queryable, publisher: Publisher | null, session: Pick<StreamSessionRow, "id" | "broadcaster_id" | "visibility">, clip: ClipView) {
  const pub = (await publicAllowed(db, session)) && clip.state === "ready" ? { ...clip, errorMessage: null, exports: [] } : null;
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind: "clip.updated", payload: clip, publicPayload: pub });
}

/** Job progress is creator-only. */
export async function emitJob(db: Queryable, publisher: Publisher | null, session: Pick<StreamSessionRow, "id" | "broadcaster_id">, job: JobView) {
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind: "job.updated", payload: job, publicPayload: null });
}

export async function emitMoment(
  db: Queryable,
  publisher: Publisher | null,
  session: Pick<StreamSessionRow, "id" | "broadcaster_id" | "visibility">,
  m: { id: string; title: string; mediaStartMs: number | null },
) {
  const pub = (await publicAllowed(db, session)) ? m : null;
  return appendSessionEvent(db, publisher, { sessionId: session.id, broadcasterId: session.broadcaster_id, kind: "moment.created", payload: m, publicPayload: pub });
}
