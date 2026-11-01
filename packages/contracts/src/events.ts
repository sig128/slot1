import { z } from "zod";
import { AnalysisStatus, ClipView, JobView, SourceHealthView } from "./api";
import { BroadcastState } from "./enums";
import { Observation } from "./observation";

/**
 * Session event stream (SSE). `id` is a monotonically increasing per-deployment sequence
 * persisted in Postgres, so a reconnecting client can send Last-Event-ID and receive a
 * gap-free backfill without duplicates.
 */
export const SessionEventKind = z.enum([
  "observation.created",
  "observation.updated",
  "analysis.status",
  "broadcast.status",
  "source.health",
  "job.updated",
  "clip.updated",
  "moment.created",
  "session.ended",
]);
export type SessionEventKind = z.infer<typeof SessionEventKind>;

export const SessionEvent = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("observation.created"), data: Observation }),
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("observation.updated"), data: Observation }),
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("analysis.status"), data: AnalysisStatus }),
  z.object({
    id: z.string(),
    sessionId: z.string(),
    at: z.string(),
    kind: z.literal("broadcast.status"),
    data: z.object({ state: BroadcastState, title: z.string().nullable(), category: z.string().nullable() }),
  }),
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("source.health"), data: SourceHealthView }),
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("job.updated"), data: JobView }),
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("clip.updated"), data: ClipView }),
  z.object({
    id: z.string(),
    sessionId: z.string(),
    at: z.string(),
    kind: z.literal("moment.created"),
    data: z.object({ id: z.string(), title: z.string(), mediaStartMs: z.number().nullable() }),
  }),
  z.object({ id: z.string(), sessionId: z.string(), at: z.string(), kind: z.literal("session.ended"), data: z.object({ endedAt: z.string() }) }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Merge events into an ordered list without duplicates (used on reconnect/backfill). */
export function mergeEvents<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => compareEventIds(a.id, b.id));
}

export function compareEventIds(a: string, b: string): number {
  const ai = BigInt(a);
  const bi = BigInt(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}
