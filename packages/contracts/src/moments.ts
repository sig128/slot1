import { z } from "zod";

/* ------------------------------------------------------------------------------------------ */
/* Timestamps and moment links                                                                */
/* ------------------------------------------------------------------------------------------ */

/** Jumps land this far before the moment so the run-up is visible. */
export const JUMP_LEAD_MS = 3000;

const MAX_MS = 24 * 3600_000;

/**
 * Parse a `?t=` value into milliseconds. Accepts plain seconds ("83", "83.5", "83s"), unit form
 * ("1m23s", "1h2m3s") and clock form ("01:23", "1:02:03"). Anything else is null, never a guess.
 */
export function parseTimeParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 16) return null;
  let ms: number | null = null;
  if (/^\d+(\.\d+)?s?$/.test(v)) ms = Math.round(parseFloat(v) * 1000);
  else if (/^(\d+h)?(\d+m)?(\d+(\.\d+)?s)?$/.test(v)) {
    const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/)!;
    if (!m[1] && !m[2] && !m[3]) return null;
    ms = Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000);
  } else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(v)) {
    const parts = v.split(":").map(Number);
    if (parts.slice(1).some((p) => p > 59)) return null;
    ms = parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  }
  if (ms === null || !Number.isFinite(ms) || ms < 0 || ms > MAX_MS) return null;
  return ms;
}

/** Compact `?t=` value: 83000 → "1m23s", 4000 → "4s". */
export function formatTimeParam(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s || (!h && !m) ? `${s}s` : ""}`;
}

/** Where a jump to a moment should start playing. */
export function jumpTarget(momentMs: number): number {
  return Math.max(0, momentMs - JUMP_LEAD_MS);
}

/**
 * The short link to one observation. `/m/<id>` resolves at click time: an instant replay while
 * the stream is live, the recording at the right second once it has finished.
 */
export function momentLink(publicOrigin: string, observationId: string): string {
  return `${publicOrigin.replace(/\/$/, "")}/m/${observationId}`;
}

export const MomentLinkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), login: z.string(), sessionId: z.string(), observationId: z.string() }),
  z.object({ kind: z.literal("replay"), sessionId: z.string(), observationId: z.string(), tMs: z.number().int().nonnegative().nullable() }),
]);
export type MomentLinkTarget = z.infer<typeof MomentLinkTarget>;

/* ------------------------------------------------------------------------------------------ */
/* Instant replay                                                                             */
/* ------------------------------------------------------------------------------------------ */

export const INSTANT_REPLAY_DEFAULT_PRE_MS = 8000;
export const INSTANT_REPLAY_DEFAULT_POST_MS = 4000;

export const InstantReplayRequest = z
  .object({
    observationId: z.string().uuid().optional(),
    /** Replay the last N seconds of what SLOT1 received. */
    secondsAgo: z.number().int().min(3).max(60).optional(),
    preMs: z.number().int().min(1000).max(20_000).default(INSTANT_REPLAY_DEFAULT_PRE_MS),
    postMs: z.number().int().min(0).max(10_000).default(INSTANT_REPLAY_DEFAULT_POST_MS),
  })
  .refine((r) => (r.observationId ? 1 : 0) + (r.secondsAgo ? 1 : 0) === 1, { message: "Give either observationId or secondsAgo" });
export type InstantReplayRequest = z.infer<typeof InstantReplayRequest>;

export const InstantReplaySource = z.enum(["recording", "buffer"]);
export type InstantReplaySource = z.infer<typeof InstantReplaySource>;

/** Whether this viewer can use instant replay in this session, and why not. */
export const InstantReplayStatus = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  source: InstantReplaySource.nullable(),
  /** For the rolling buffer: how far back moments can be replayed. */
  bufferSeconds: z.number().int().nullable(),
});
export type InstantReplayStatus = z.infer<typeof InstantReplayStatus>;

export const InstantReplayResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    url: z.string(),
    source: InstantReplaySource,
    /** The window in the live reader's media time, and the moment inside it. */
    startMs: z.number().int(),
    endMs: z.number().int(),
    momentOffsetMs: z.number().int().nullable(),
    durationMs: z.number().int(),
    expiresAt: z.string(),
  }),
  /** The end of the window hasn't been recorded yet: ask again after `retryAfterMs`. */
  z.object({ status: z.literal("pending"), reason: z.string(), retryAfterMs: z.number().int() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type InstantReplayResponse = z.infer<typeof InstantReplayResponse>;
