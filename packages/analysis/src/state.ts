import type { AnalysisState } from "@slot1/contracts";

export interface CadenceInput {
  /** Configured sampling interval for this source. */
  expectedIntervalMs: number | null;
  /** Measured interval between received frames (EMA). */
  measuredCadenceMs: number | null;
  /** Measured receive→analyzed delay. */
  measuredDelayMs: number | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Staleness threshold derived from the source's own cadence and measured delay — not one
 * universal timeout. Three missed frames at the slower of configured/measured cadence, plus
 * the measured processing delay, bounded to [10s, 5min].
 */
export function staleAfterMs(i: CadenceInput): number {
  const cadence = Math.max(i.expectedIntervalMs ?? 0, i.measuredCadenceMs ?? 0) || 5000;
  return clamp(cadence * 3 + (i.measuredDelayMs ?? 0), 10_000, 300_000);
}

/** Analysis is "delayed" when processing lags the newest received frame by this much. */
export function delayedAfterMs(i: CadenceInput): number {
  const cadence = Math.max(i.expectedIntervalMs ?? 0, i.measuredCadenceMs ?? 0) || 5000;
  return clamp(cadence * 2 + 5000, 8000, 120_000);
}

export interface LiveStateInput extends CadenceInput {
  now: number;
  stoppedByCreator: boolean;
  pausedByCreator: boolean;
  publisherConnected: boolean;
  lastFrameAt: number | null;
  lastAnalyzedAt: number | null;
  error: string | null;
  visionConfigured: boolean;
  ocrAvailable: boolean;
}

/**
 * Derive the live analysis state. `live_vision` is only reachable while real frames are
 * arriving AND being processed; a missing or silent source becomes `stale`, never "live".
 */
export function deriveLiveState(i: LiveStateInput): { state: AnalysisState; reason: string } {
  if (i.error) return { state: "error", reason: i.error };
  if (i.stoppedByCreator) return { state: "stopped", reason: "Analysis stopped by the creator" };
  if (i.pausedByCreator) return { state: "stopped", reason: "Analysis paused by the creator" };
  if (i.lastFrameAt === null) {
    return { state: "ready", reason: i.publisherConnected ? "Publisher connected — waiting for the first frame" : "Waiting for the publisher to connect" };
  }
  const age = i.now - i.lastFrameAt;
  const stale = staleAfterMs(i);
  if (age > stale) return { state: "stale", reason: `No frames for ${Math.round(age / 1000)}s (threshold ${Math.round(stale / 1000)}s)` };
  if (!i.visionConfigured && !i.ocrAvailable) return { state: "delayed", reason: "Frames arriving, but nothing is switched on to analyze them yet" };
  const lag = i.lastAnalyzedAt === null ? age : i.lastFrameAt - i.lastAnalyzedAt;
  if (i.lastAnalyzedAt === null || lag > delayedAfterMs(i)) {
    return { state: "delayed", reason: `Analysis is behind the newest frame by ${Math.round(Math.max(lag, 0) / 1000)}s` };
  }
  return {
    state: "live_vision",
    reason: i.visionConfigured ? "Frames arriving and being analyzed" : "Frames arriving — reading on-screen text only (the AI that describes gameplay isn't switched on yet)",
  };
}

/** Exponential moving average for cadence/delay measurements. */
export function ema(prev: number | null, sample: number, alpha = 0.3): number {
  return prev === null ? sample : Math.round(prev * (1 - alpha) + sample * alpha);
}

/** Whether automatic commentary may post right now. Defaults off; any doubt means no. */
export function commentaryAllowed(i: {
  mode: "off" | "rare" | "normal";
  muted: boolean;
  botEnabled: boolean;
  killed: boolean;
  globalKill: boolean;
  analysisState: AnalysisState;
  lastCommentaryAt: number | null;
  now: number;
}): { allowed: boolean; reason: string } {
  if (i.globalKill || i.killed) return { allowed: false, reason: "kill switch" };
  if (!i.botEnabled) return { allowed: false, reason: "bot disabled" };
  if (i.mode === "off") return { allowed: false, reason: "commentary off" };
  if (i.muted) return { allowed: false, reason: "commentary muted" };
  if (i.analysisState !== "live_vision") return { allowed: false, reason: `analysis ${i.analysisState}` };
  const minGap = i.mode === "rare" ? 10 * 60_000 : 4 * 60_000;
  if (i.lastCommentaryAt !== null && i.now - i.lastCommentaryAt < minGap) return { allowed: false, reason: "too soon" };
  return { allowed: true, reason: "ok" };
}
